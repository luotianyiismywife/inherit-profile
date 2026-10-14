/**
 * =============================================================================
 * inherit-profile-plus — 原子文件写入
 * =============================================================================
 *
 * 用途（Purpose）:
 *   提供"同目录临时文件 + rename"的原子写入，避免多窗口并发 reconcile 时
 *   直接 `fs.writeFile` 被并发覆盖，导致目标文件停在**未闭合的中间态**
 *   （issue #7：settings.json 被截断成 207 字节、缺结尾 `}`）。
 *
 * 工作机制（How it works）:
 *   1. 在目标文件**同目录**写一个唯一命名的临时文件
 *      `<filePath>.<pid>-<uuid>.tmp`（同目录 → rename 才在同一文件系统内原子）
 *   2. `fs.rename(tmp, target)` 原子替换目标
 *      - 进程即使被打断，磁盘上要么是完整旧文件、要么是完整新文件，
 *        绝不会停在半写状态
 *      - 多窗口并发最终收敛为"最后一个 rename 胜出"，不会损坏文件
 *   3. Windows 上 rename 可能因目标被占用（VS Code 在读 / 杀毒扫描 /
 *      其他实例在写）抛 EPERM/EBUSY/EACCES → **退避重试**
 *   4. 无论成功失败，`finally` 里清理临时文件（忽略 ENOENT）
 *
 * ⚠️ 关键约束（issue #7 评估结论）:
 *   - 临时文件名**必须每次唯一**：固定名会让两个实例写同一个临时文件，
 *     把截断问题原样转移到临时文件上，rename 反而把半成品搬进目标。
 *   - rename 重试耗尽后**必须放弃本次写入**（保留旧内容），
 *     **绝不能回退到 `fs.writeFile`**——否则非原子写 bug 立刻回归。
 *
 * 跨平台（Cross-platform）:
 *   - **Windows**：`fs.rename` 走 `MoveFileExW` + `REPLACE_EXISTING`，目标被
 *     占用（VS Code 在读 / 杀毒扫描 / 其他实例在写）时抛 EPERM/EBUSY/EACCES
 *     → 退避重试。这是重试逻辑的主要服务对象。
 *   - **macOS / Linux**：`rename(2)` 原子替换目标，几乎不会失败，重试逻辑
 *     只是无害兜底。**但**新建的临时文件默认带 umask 权限，rename 后会覆盖
 *     目标原有权限——若原文件是 0600 会变成 0644（权限被放宽）。因此写入前
 *     先 stat 原文件 mode，rename 前把临时文件 chmod 成一致（见
 *     {@link AtomicWriteDeps.statMode} / {@link AtomicWriteDeps.chmod}）。
 *     Windows 上 chmod 基本是 no-op，调用无害。
 *
 * 依赖关系（Dependencies）:
 *   - node:crypto — 生成唯一临时文件名后缀
 *   - node:fs/promises — 写临时文件 / stat / chmod / rename / unlink
 *
 * 被谁使用（Used by）:
 *   - src/profiles.ts — writeManagedFile
 *
 * 导出列表（Exports）:
 *   - writeFileAtomic(filePath, content, options?)  [async] 原子写入
 *   - AtomicWriteDeps                              依赖注入接口（测试用）
 *   - AtomicWriteOptions                           选项接口
 */

import * as crypto from "crypto";
import * as fs from "fs/promises";

/** 默认总尝试次数（首次 + 重试）。 */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** 默认重试基础间隔（毫秒），采用线性退避：delay * attempt。 */
export const DEFAULT_RETRY_DELAY_MS = 30;

/**
 * Windows 上 rename 因目标被占用而失败的可重试 errno 集合。
 * - EPERM / EACCES：目标被其他进程打开（MoveFileEx 拒绝）
 * - EBUSY：目标被占用
 */
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * 原子写入的可注入依赖。默认使用真实 fs；测试可覆盖以模拟失败/并发。
 */
export interface AtomicWriteDeps {
  /** 写文件（默认 fs.writeFile，utf8）。 */
  writeFile(path: string, content: string): Promise<void>;
  /** 重命名（默认 fs.rename）。 */
  rename(oldPath: string, newPath: string): Promise<void>;
  /** 删除文件（默认 fs.unlink）。 */
  unlink(path: string): Promise<void>;
  /**
   * 读取目标文件当前的权限 mode（默认 fs.stat().mode）。
   * 文件不存在或读取失败时返回 `undefined`（此时不 chmod，用默认权限）。
   * 用于 POSIX 上保留原文件权限，避免 rename 后权限被 umask 放宽。
   */
  statMode(path: string): Promise<number | undefined>;
  /** 设置文件权限（默认 fs.chmod）。Windows 上基本是 no-op。 */
  chmod(path: string, mode: number): Promise<void>;
  /** 生成唯一临时文件名后缀（默认 `<pid>-<uuid>`）。 */
  randomSuffix(): string;
  /** 睡眠（默认 setTimeout）。 */
  sleep(ms: number): Promise<void>;
}

/** {@link writeFileAtomic} 的选项。 */
export interface AtomicWriteOptions {
  /** 总尝试次数（含首次）。默认 {@link DEFAULT_MAX_ATTEMPTS}。 */
  maxAttempts?: number;
  /** 重试基础间隔（毫秒）。默认 {@link DEFAULT_RETRY_DELAY_MS}。 */
  retryDelayMs?: number;
  /** 覆盖部分依赖（测试用）。 */
  deps?: Partial<AtomicWriteDeps>;
}

/** 构造默认依赖（真实 fs）。 */
function defaultDeps(): AtomicWriteDeps {
  return {
    writeFile: (p, content) => fs.writeFile(p, content, "utf8"),
    rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
    unlink: (p) => fs.unlink(p),
    statMode: async (p) => {
      try {
        return (await fs.stat(p)).mode;
      } catch {
        return undefined;
      }
    },
    chmod: (p, mode) => fs.chmod(p, mode),
    randomSuffix: () => `${process.pid}-${crypto.randomUUID()}`,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** 判断错误是否属于"可重试的 rename 占用错误"。 */
function isRetryableRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && RETRYABLE_RENAME_CODES.has(code);
}

/**
 * 带退避重试的 rename。仅对可重试 errno（EPERM/EACCES/EBUSY）重试；
 * 其他错误（如 ENOENT）立即抛出，不做无谓等待。
 *
 * @throws 重试耗尽或遇到不可重试错误时，抛出最后一次的错误。
 */
async function renameWithRetry(
  deps: AtomicWriteDeps,
  from: string,
  to: string,
  maxAttempts: number,
  retryDelayMs: number,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await deps.rename(from, to);
      return;
    } catch (err) {
      lastError = err;
      const isLast = attempt >= maxAttempts;
      if (isLast || !isRetryableRenameError(err)) {
        throw err;
      }
      // 线性退避：30ms, 60ms, 90ms, ...
      await deps.sleep(retryDelayMs * attempt);
    }
  }
  // 理论上不可达（循环内要么 return 要么 throw），兜底。
  throw lastError;
}

/**
 * 原子地把 `content` 写入 `filePath`。
 *
 * 实现：同目录唯一临时文件 → `rename` 原子替换（占用时退避重试）→
 * `finally` 清理临时文件。失败时抛出，**不**回退到非原子写。
 *
 * @param filePath 目标文件绝对路径。
 * @param content 要写入的完整内容。
 * @param options 可选：尝试次数 / 重试间隔 / 依赖注入。
 * @throws 写临时文件失败、或 rename 重试耗尽时抛出。
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const deps: AtomicWriteDeps = { ...defaultDeps(), ...options.deps };
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  // 读取目标原有权限（POSIX 上 rename 会用临时文件的权限覆盖目标，
  // 若不保留，0600 的 settings.json 会被 umask 放宽成 0644）。
  // 文件不存在时返回 undefined → 不 chmod，用默认权限。
  const originalMode = await deps.statMode(filePath);

  // 同目录 + 唯一后缀：保证 rename 原子，且并发实例互不踩踏。
  const tmpPath = `${filePath}.${deps.randomSuffix()}.tmp`;

  try {
    await deps.writeFile(tmpPath, content);
    // 保留原文件权限（Windows 上 chmod 基本是 no-op，调用无害）。
    if (originalMode !== undefined) {
      await deps.chmod(tmpPath, originalMode).catch(() => {});
    }
    await renameWithRetry(deps, tmpPath, filePath, maxAttempts, retryDelayMs);
  } finally {
    // rename 成功后 tmp 已不存在（ENOENT）；失败时清理残留。两者都忽略错误。
    await deps.unlink(tmpPath).catch(() => {});
  }
}
