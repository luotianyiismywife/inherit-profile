/**
 * =============================================================================
 * inherit-profile-plus — 自写内容跟踪器
 * =============================================================================
 *
 * 用途（Purpose）:
 *   跟踪扩展自身对文件的写入内容，用于区分"自身写入"和"外部编辑"。
 *   防止文件监听器对自身写入产生反应，避免无限循环触发。
 *
 * 工作机制（How it works）:
 *   1. record(filePath, content) — 记录写入路径和内容（进程内，同实例快速路径）
 *   2. isSelfWrite(filePath, content) — 检查某路径的最新内容是否匹配记录
 *   3. forget(filePath) — 清除某路径的记录
 *   4. 磁盘标记（writeWriteToken / readWriteTokenHash）— 跨实例自写识别：
 *      writeManagedFile 在写正文**之前**先写 `<目标文件>.inherit-token` 标记文件
 *      （内容 = { instanceId, hash: sha1(正文), ts }）。其他窗口/进程的 watcher
 *      收到正文变更事件时，读标记并比对 sha1，一致即判定为"扩展自己写的"。
 *
 *   进程内 Map 只覆盖当前扩展宿主；多个 VS Code 窗口 = 多个扩展宿主 = 各自独立
 *   Map，单靠内存无法识别兄弟实例的写入，磁盘标记是跨进程的共享痕迹。
 *
 * 依赖关系（Dependencies）:
 *   - node:crypto — sha1 摘要
 *   - node:fs — 标记文件同步读写（写正文前必须已落盘）
 *
 * 被谁使用（Used by）:
 *   - src/profiles.ts — writeManagedFile / isManagedFileSelfWrite
 *   - src/profileWatchers.ts — 区分自身写入与外部编辑
 *
 * 导出列表（Exports）:
 *   - WRITE_TOKEN_SUFFIX (const)       标记文件后缀
 *   - sha1Hex(text)                    内容 SHA-1 摘要
 *   - writeTokenPathFor(filePath)      目标文件对应的标记路径
 *   - writeWriteToken(filePath, content)  写正文前同步写入标记
 *   - readWriteTokenHash(filePath)     读取标记中的内容哈希（无标记返回 undefined）
 *   - SelfWriteTracker (class)         进程内自写内容跟踪器类
 *     - record(filePath, content)    记录写入
 *     - isSelfWrite(filePath, content)  判断是否为自身写入
 *     - forget(filePath)             清除记录
 */

import * as crypto from "crypto";
import * as fs from "fs";

/** 磁盘标记文件后缀: `<目标文件>.<后缀>`（与目标文件同目录） */
export const WRITE_TOKEN_SUFFIX = ".inherit-token";

/**
 * 当前扩展宿主进程的唯一实例 ID: pid + 随机 UUID。
 * 用于标记文件中记录"是谁写的"，跨窗口区分实例。
 */
const instanceId = `${process.pid}-${crypto.randomUUID()}`;

/**
 * 计算文本的 SHA-1 十六进制摘要。
 * 用于标记哈希比对：watcher 读到正文后重算哈希，与标记中的哈希比对。
 */
export function sha1Hex(text: string): string {
  return crypto.createHash("sha1").update(text, "utf8").digest("hex");
}

/** 返回目标文件对应的磁盘标记文件路径 */
export function writeTokenPathFor(filePath: string): string {
  return filePath + WRITE_TOKEN_SUFFIX;
}

/**
 * 在写正文**之前**同步写入磁盘标记，供其他实例（其他窗口/进程）的 watcher
 * 识别"这是扩展自己写的"而非外部编辑。
 *
 * 时序关键：必须先写标记、再写正文——这样正文变更事件触发时，标记一定已
 * 落盘可读，哈希比对必然命中。标记文件保留不删（每次写入覆盖），避免
 * "删除标记"与"watcher 读到正文"之间的竞态窗口。
 *
 * 标记文件是纯本地痕迹，不在 Settings Sync 同步清单中，不会上传/被覆盖。
 */
export function writeWriteToken(filePath: string, content: string): void {
  const token = {
    v: 1,
    instanceId,
    hash: sha1Hex(content),
    ts: Date.now(),
  };
  fs.writeFileSync(writeTokenPathFor(filePath), JSON.stringify(token), "utf8");
}

/**
 * 读取目标文件的磁盘标记中的内容哈希。
 * @returns 标记中记录的 hash；标记文件缺失/损坏/格式不符时返回 `undefined`。
 */
export function readWriteTokenHash(filePath: string): string | undefined {
  try {
    const raw = fs.readFileSync(writeTokenPathFor(filePath), "utf8");
    const parsed = JSON.parse(raw) as { hash?: unknown };
    return typeof parsed?.hash === "string" ? parsed.hash : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tracks the content this extension itself most recently wrote to a given
 * file path.
 *
 * This is used to distinguish between file system events caused by this
 * extension's own writes (e.g. inserting the inherited settings block) and
 * genuine external edits (e.g. the user editing and saving the file), so
 * that file watchers which react to changes do not re-trigger themselves
 * and cause an infinite loop.
 */
export class SelfWriteTracker {
  private readonly lastWrittenContentByPath = new Map<string, string>();

  /**
   * Records that `content` was just written to `filePath` by this
   * extension.
   */
  record(filePath: string, content: string): void {
    this.lastWrittenContentByPath.set(filePath, content);
  }

  /**
   * @returns Returns `true` if `content` matches the last content this
   * extension recorded for `filePath` (i.e. this looks like our own write
   * rather than an external edit).
   */
  isSelfWrite(filePath: string, content: string): boolean {
    return this.lastWrittenContentByPath.get(filePath) === content;
  }

  /**
   * Forgets any recorded content for `filePath`, so the next change to it is
   * always treated as external.
   */
  forget(filePath: string): void {
    this.lastWrittenContentByPath.delete(filePath);
  }
}
