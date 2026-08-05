/**
 * =============================================================================
 * inherit-profile-plus — Profile 继承核心逻辑
 * =============================================================================
 *
 * 用途（Purpose）:
 *   实现 VS Code Profile 之间的设置（settings.json）和扩展（extensions.json）
 *   继承逻辑。子 Profile 可以声明一个或多个父 Profile，自动继承其配置。
 *
 * 工作机制（How it works）:
 *   1. 通过读取 VS Code 全局存储 storage.json 获取 Profile 列表和当前 Profile
 *   2. 获取当前 Profile 的 `inheritProfile.parents` 配置，确定父 Profile
 *   3. 设置继承：
 *      a. 读取父 Profile 和子 Profile 的 settings.json
 *      b. 用 subtractSettings() 剔除子中已有的 key（子覆盖父）
 *      c. 将缺失的父设置写入 inherited 标记块（带起始/结束标记）
 *   4. 扩展继承（7步全量对账）：
 *      a. 读取 settings.json 元数据（originallyOwn, optedOut）
 *      b. 转换旧标记格式（inheritedFromProfile → inheritProfile.inherited）
 *      c. 注入 optedOut 标记
 *      d. 一致性校验（settings.json 列表 ↔ extensions.json 标记）
 *      e. 收集父级扩展
 *      f. 通过 mergeInheritedExtensions 全量对账
 *      g. 统计真实新增/移除
 *   5. 反向索引 + 级联触发：
 *      - 建立 parent→children 映射
 *      - 当父 Profile 变更时，仅同步其后代
 *      - 缓存带 mtime 校验，自动失效
 *
 * 依赖关系（Dependencies）:
 *   - import { ... } from "./profileSettings" — JSONC 工具函数
 *   - import { SelfWriteTracker } from "./selfWriteTracker" — 自写跟踪
 *   - vscode 模块 — 配置、消息通知
 *   - fs/promises + path — 文件读写
 *   - jsonc-parser — 解析带注释的 JSON
 *
 * 对外提供的 API（Exports）:
 *   - readJSON(filePath)                                    [async] 读取 JSONC 文件
 *   - getGlobalStoragePath(context)                         获取 storage.json 路径
 *   - getCurrentProfileName(context)                        [async] 获取当前 Profile 名称
 *   - getProfileMap(context)                                [async] Profile 名称→目录映射
 *   - getCurrentProfileDetails(context)                     [async] 当前 Profile 详细信息
 *   - readRawSettingsFile(settingsPath)                     [async] 读取原始 settings.json
 *   - updateCurrentProfileInheritance(context, trigger?)    [async] **主要入口**：完整继承同步
 *   - removeCurrentProfileInheritedSettings(context)        [async] 清除当前 Profile 的继承内容
 *   - writeManagedFile(filePath, content)                   [async] 写入文件并记录自写
 *   - isManagedFileSelfWrite(filePath, content)             判断是否为自身的写入
 *   - invalidateInheritanceGraph()                          使反向索引缓存失效
 *
 * 内部函数（Internal）:
 *   - getUserDirectory(context)                              获取用户目录
 *   - getGlobalStoragePath(context)                          获取 storage.json 路径
 *   - readGlobalStorage(context)                             [async] 读取全局存储
 *   - getCustomProfiles(context)                             [async] 获取自定义 Profile 列表
 *   - findByKeyValuePair(input, key, value)                  在嵌套对象中递归搜索
 *   - getProfileSettings(context, profiles)                  [async] 收集指定 Profile 的拍平设置
 *   - getCurrentProfileSettings(context)                     [async] 当前 Profile 自身设置
 *   - getInheritedSettings(context)                          [async] 计算应继承的设置（父−子）
 *   - removeInheritedSettingsFromFile(settingsPath)          [async] 从文件移除 inherited 标记块
 *   - writeInheritedSettings(settingsPath, flattened)        [async] 写入 inherited 设置块
 *   - applyInheritedSettings(context)                        [async] 执行继承（设置+扩展+备份）
 *   - collectInheritedExtensions(context, ...)               [async] 7步全量对账扩展继承
 *   - buildInheritanceGraph(profiles)                        构建反向索引
 *   - isGraphCacheValid(profiles)                            检查反向索引缓存有效性
 *   - getInheritanceGraph(profiles)                          获取或构建缓存的反向索引
 *   - getDescendants(root, graph)                            BFS 获取所有后代
 *
 * 配置项（Config keys under "inheritProfile"）:
 *   - parents: string[] — 父 Profile 名称列表
 *   - runOnStartup: boolean — 启动时自动同步
 *   - runOnProfileChange: boolean — 切换 Profile 时自动同步
 *   - runOnCurrentProfileSave: boolean — 当前 Profile 保存时同步
 *   - runOnParentProfileSave: boolean — 父级保存时同步
 *   - inheritExtensions: boolean — 是否继承扩展
 *   - showMessages: boolean — 是否显示通知消息
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { statSync, readFileSync } from "fs";
import { parse as parseJSONC } from "jsonc-parser";
import { getDisabledExtensions } from "./disabledExtensions";
import {
  buildInheritedSettingsBlock,
  findTabValue,
  flattenSettings,
  INHERITED_SETTINGS_END_MARKER,
  INHERITED_SETTINGS_START_MARKER,
  insertBeforeClose,
  mergeFlattenedSettings,
  mergeInheritedExtensions,
  removeInsertionBoundarySetting,
  removeTrailingComma,
  sortSettings,
  splitRawSettingsByClosingBrace,
  stripInheritedExtensions,
  stripInheritedSettingsBlocks,
  stripManagedProfileSettings,
  subtractSettings,
  convertOldMarkers,
  isInheritedExtension,
  isOptedOutExtension,
  markExtensionAsInherited,
  markExtensionAsOptedOut,
  INHERITED_PROFILE_META_KEY,
} from "./profileSettings";
import { SelfWriteTracker } from "./selfWriteTracker";

/**
 * Tracks content written to profile files by this extension so that file
 * watchers reacting to those same files can tell the difference between our
 * own writes and genuine external edits.
 */
const selfWriteTracker = new SelfWriteTracker();

/**
 * Writes `content` to `filePath` and records it with {@link selfWriteTracker}
 * so that file watchers set up to react to external edits of this file (see
 * `isManagedFileSelfWrite`) can recognise and ignore the change this write is
 * about to cause.
 */
async function writeManagedFile(
  filePath: string,
  content: string,
): Promise<void> {
  selfWriteTracker.record(filePath, content);
  await fs.writeFile(filePath, content, "utf8");
}

// writeManagedFile 需要 export, 供 extension.ts 的 checkAndRestoreMarkers 调用
export { writeManagedFile };

/**
 * Reports whether the most recent write to `filePath` (via
 * {@link writeManagedFile}) wrote exactly `content`, meaning a file watcher
 * observing this change is seeing this extension's own write rather than an
 * external edit.
 * @param filePath Absolute path to the file that changed.
 * @param content The file's current content.
 */
export function isManagedFileSelfWrite(
  filePath: string,
  content: string,
): boolean {
  return selfWriteTracker.isSelfWrite(filePath, content);
}

// ---------------------------------------------------------------------------
// 反向索引 + 级联触发
// ---------------------------------------------------------------------------

// 内存缓存: parent → children[]
let inheritanceGraphCache: Record<string, string[]> | undefined;
// 缓存时的 profiles 快照（用于检测 profile 新增/删除）
let cachedProfilesSnapshot: Record<string, string> | undefined;
// 缓存时各 profile 目录的 mtime 签名, 用于检测文件变更
let cachedProfileMtimes: Record<string, number> | undefined;

/**
 * 检查缓存是否仍然有效。
 * 如 profiles 列表有变动或任一 profile 目录的 mtime 变化, 缓存失效。
 */
function isGraphCacheValid(
  profiles: Readonly<Record<string, string>>,
): boolean {
  if (!inheritanceGraphCache || !cachedProfilesSnapshot || !cachedProfileMtimes) {
    return false;
  }
  // 检查 profile 列表是否一致
  const currentKeys = Object.keys(profiles).sort().join(",");
  const cachedKeys = Object.keys(cachedProfilesSnapshot).sort().join(",");
  if (currentKeys !== cachedKeys) return false;
  // 检查每个 profile 的 settings.json 的 mtime（⚠️ 不能用目录 mtime——
  // Windows 上修改文件内容不更新父目录 mtime，会导致缓存永远不失效）
  for (const [name, dir] of Object.entries(profiles)) {
    try {
      const stat = statSync(path.join(dir, "settings.json"));
      if (stat.mtimeMs !== cachedProfileMtimes[name]) return false;
    } catch {
      return false; // settings.json 不存在或无法访问
    }
  }
  return true;
}

/**
 * 构建继承关系反向索引。
 * 扫描所有 profile 的 settings.json 中的 inheritProfile.parents 来建立。
 * 同时记录 mtime 签名以供后续缓存校验。
 */
function buildInheritanceGraph(
  profiles: Readonly<Record<string, string>>,
): Record<string, string[]> {
  const graph: Record<string, string[]> = {};
  const mtimes: Record<string, number> = {};
  for (const [profileName, profileDir] of Object.entries(profiles)) {
    const settingsPath = path.join(profileDir, "settings.json");
    try {
      // 记录 settings.json 的 mtime（⚠️ 不能用目录 mtime——Windows 上
      // 修改文件内容不更新父目录 mtime，缓存校验会失效）
      const fileStat = statSync(settingsPath);
      mtimes[profileName] = fileStat.mtimeMs;

      const raw = readFileSync(settingsPath, "utf8");
      const settings = parseJSONC(raw) as Record<string, any>;
      // 兼容两种存储格式（嵌套/扁平）——扁平格式不会被 jsonc-parser 展开
      const parents =
        settings?.inheritProfile?.parents ??
        settings?.["inheritProfile.parents"] ??
        [];
      for (const parent of parents) {
        if (profiles[parent]) {
          if (!graph[parent]) graph[parent] = [];
          if (!graph[parent].includes(profileName)) {
            graph[parent].push(profileName);
          }
        }
      }
    } catch (err) {
      // 忽略无法读取的 settings.json (如新 profile 尚无配置)
      // 但记录 warn 以便调试
      console.warn(`buildInheritanceGraph: skipping \`${profileName}\` (${(err as Error)?.message ?? err})`);
    }
  }
  cachedProfileMtimes = mtimes;
  cachedProfilesSnapshot = { ...profiles };
  return graph;
}

/**
 * 获取或构建缓存的反向索引。
 * 如果缓存已失效（profiles 变动或 mtime 变化）, 自动重建。
 */
export function getInheritanceGraph(
  profiles: Readonly<Record<string, string>>,
): Record<string, string[]> {
  if (!inheritanceGraphCache || !isGraphCacheValid(profiles)) {
    inheritanceGraphCache = buildInheritanceGraph(profiles);
  }
  return inheritanceGraphCache;
}

/**
 * 使反向索引缓存失效（配置变更时调用）。
 * 注意: 日常使用中缓存由 `getInheritanceGraph` 的 `isGraphCacheValid`
 * 自动校验（检查 profiles 列表和 mtime）, 无需手动失效。
 * 但父级列表变更（`inheritProfile.parents` 配置变化）时仍需手动调用,
 * 因为继承关系拓扑变了, mtime 检测无法感知。
 */
function invalidateInheritanceGraph(): void {
  inheritanceGraphCache = undefined;
  cachedProfilesSnapshot = undefined;
  cachedProfileMtimes = undefined;
}

export function getDescendants(
  root: string,
  graph: Record<string, string[]>,
): string[] {
  const result: string[] = [];
  const visited = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = graph[current] ?? [];
    for (const child of children) {
      if (!visited.has(child)) {
        visited.add(child);
        result.push(child);
        queue.push(child);
      }
    }
  }
  return result;
}

// 注意: invalidateInheritanceGraph 需要 export, 供 extension.ts 和 profileWatchers.ts 调用
export { invalidateInheritanceGraph };

/**
 * 为当前 Profile 读取父级列表（直接从 settings.json 读取，不经过 VS Code 设置 API）。
 */
export async function readParentProfiles(
  context: vscode.ExtensionContext,
): Promise<string[]> {
  const { currentProfileDirectory } = await getCurrentProfileDetails(context);
  const settingsPath = path.join(currentProfileDirectory, "settings.json");
  const settings = (await readJSON(settingsPath)) ?? {};
  return settings?.inheritProfile?.["parents"] ?? settings?.["inheritProfile.parents"] ?? [];
}

// ---------------------------------------------------------------------------
// parents 快照（globalState）—— 防御 Settings Sync 覆盖删除
// ---------------------------------------------------------------------------
// Settings Sync 的 settingsMerge.parseSettings 只识别**顶层 key**：嵌套的
// `inheritProfile: { parents }` 会被当作整个 inheritProfile 节点的整体内容处理。
// 一旦 Sync 拉取应用，本地 parents 会被云端（无 parents）版本覆盖删除。
//
// 因此三管齐下：
//   1) 写入一律用**扁平 key** `"inheritProfile.parents"`（VS Code 配置系统与
//      Settings Sync 均能正确识别顶层 key，不会被整体替换）
//   2) 用户主动设置或同步成功后把 parents 存入 globalState 快照
//      （key 已加入 setKeysForSync，可跨设备同步）
//   3) 读取时若发现文件缺失且快照存在，自动以扁平格式写回恢复
const PARENT_SNAPSHOTS_KEY = "inheritProfile.parentSnapshots";

async function getParentSnapshots(
  context: vscode.ExtensionContext,
): Promise<Record<string, string[]>> {
  // globalState 可能缺失（如测试 mock context）——防御性处理
  if (!context.globalState) {
    return {};
  }
  return (
    context.globalState.get<Record<string, string[]>>(PARENT_SNAPSHOTS_KEY) ??
    {}
  );
}

async function setParentSnapshot(
  context: vscode.ExtensionContext,
  profileName: string,
  parents: string[],
): Promise<void> {
  if (!context.globalState) {
    return; // 测试环境无 globalState, 跳过快照
  }
  const snapshots = await getParentSnapshots(context);
  if (
    JSON.stringify(snapshots[profileName] ?? []) ===
    JSON.stringify(parents)
  ) {
    return; // 无变化, 避免无谓写入
  }
  await context.globalState.update(PARENT_SNAPSHOTS_KEY, {
    ...snapshots,
    [profileName]: parents,
  });
}

/**
 * 若指定 Profile 的 settings.json 中没有 parents 但 globalState 快照有，
 * 则以扁平格式写回恢复（防御 Settings Sync 反复删除）。
 *
 * 注意：仅在文件**完全没有 parents 键**（undefined）时恢复；
 * 若文件已有 parents（即使是空数组 `[]` = 用户主动清空），尊重现状不覆盖。
 * @returns 文件中的 parents（恢复后为快照值）
 */
async function restoreParentsFromSnapshot(
  context: vscode.ExtensionContext,
  profileName: string,
  profileDir: string,
): Promise<string[]> {
  const settingsPath = path.join(profileDir, "settings.json");
  const current = (await readJSON(settingsPath)) ?? {};
  const existing =
    current?.inheritProfile?.parents ?? current?.["inheritProfile.parents"];
  if (existing !== undefined) {
    return existing; // 文件已有 parents（含 []），不覆盖
  }

  const snapshots = await getParentSnapshots(context);
  const saved = snapshots[profileName];
  if (!saved || saved.length === 0) {
    return [];
  }
  const raw = await readRawSettingsFile(settingsPath);
  const { modify, applyEdits } = await import("jsonc-parser");
  const options: import("jsonc-parser").ModificationOptions = {
    formattingOptions: { insertSpaces: true, tabSize: 4 },
  };
  // 分步写入避免重叠 edits：先删旧嵌套 parents，再写扁平 parents。
  // ⚠️ 只有存在嵌套 inheritProfile 对象时才删（Settings Sync 重写后的纯扁平
  // 文件没有该对象，jsonc-parser 对不存在的路径执行删除会抛
  // "Can not delete in empty document"）。
  let updated = raw;
  if ((current as Record<string, any>)?.inheritProfile) {
    const edits1 = modify(raw, ["inheritProfile", "parents"], undefined, options);
    updated = applyEdits(raw, edits1);
  }
  const edits2 = modify(updated, ["inheritProfile.parents"], saved, options);
  updated = applyEdits(updated, edits2);
  await writeManagedFile(settingsPath, updated);
  invalidateInheritanceGraph();
  console.info(
    `[parents-restore] Parents for \`${profileName}\` were missing ` +
      `(Settings Sync overwrite?) and restored from snapshot: [${saved.join(", ")}]`,
  );
  return saved;
}

/**
 * 统一读取指定 Profile 的 parents：文件（嵌套/扁平）→ 快照 → 配置 API 回退。
 * 所有同步入口都应使用本函数，避免 VS Code 配置缓存读到已丢失的 parents。
 *
 * 分层设计（文件是事实来源）：
 *   1. 文件中有 parents（含显式空数组 `[]` = 用户主动清空）→ 返回文件值
 *   2. 文件缺失（Settings Sync 覆盖删除/从未设置）→ 从快照恢复
 *   3. 快照也无 → 回退到 VS Code 配置 API。⚠️ **仅当目标 profile 是当前激活
 *      profile 时**才回退——`config.get("parents")` 读取的是当前激活 profile 的
 *      配置模型，若用于其他 profile 会把当前 profile 的 parents 错误套用到它
 *      （如 `syncProfileByName` 处理 Base 时误拿到 Base->Dev 的 parents）。
 */
type ParentsSource = "file" | "snapshot" | "config" | "none";

/**
 * 统一读取指定 Profile 的 parents 并返回来源标记。
 * 所有同步入口都应使用本函数，避免 VS Code 配置缓存读到已丢失的 parents。
 *
 * 分层设计（文件是事实来源）：
 *   1. 文件中有 parents（含显式空数组 `[]` = 用户主动清空）→ source: file
 *   2. 文件缺失（Settings Sync 覆盖删除/从未设置）→ 从快照恢复 → source: snapshot
 *   3. 快照也无 → 回退到 VS Code 配置 API → source: config。
 *      ⚠️ 仅当目标 profile 是当前激活 profile 时才回退——`config.get("parents")`
 *      读取的是当前激活 profile 的配置模型，用于其他 profile 会把当前 profile
 *      的 parents 错误套用到它（如 `syncProfileByName` 处理 Base 时误拿
 *      Base->Dev 的 parents）。且 config 是**过期缓存**（文件刚被改但配置模型
 *      未刷新），因此 config 来源的值**不应固化到快照**（见 syncProfileByName）。
 */
async function getParentNamesWithSource(
  context: vscode.ExtensionContext,
  profileName: string,
  profileDir: string,
): Promise<{ parents: string[]; source: ParentsSource }> {
  const settingsPath = path.join(profileDir, "settings.json");
  const settings = (await readJSON(settingsPath)) ?? {};
  const fromFile =
    settings?.inheritProfile?.parents ?? settings?.["inheritProfile.parents"];
  if (fromFile !== undefined) {
    return { parents: fromFile, source: "file" };
  }
  // 文件缺失 → 快照恢复
  const restored = await restoreParentsFromSnapshot(context, profileName, profileDir);
  if (restored.length > 0) {
    return { parents: restored, source: "snapshot" };
  }
  // 快照也无 → 配置 API 回退（仅限当前激活 profile；兼容旧流程/测试 updateConfig）
  try {
    const currentProfileName = await getCurrentProfileName(context);
    if (currentProfileName === profileName) {
      const config = vscode.workspace.getConfiguration("inheritProfile");
      return { parents: config.get<string[]>("parents", []), source: "config" };
    }
  } catch {
    // 无法解析当前 profile（storage.json 未就绪等）→ 视为无 parents
  }
  return { parents: [], source: "none" };
}

/**
 * 统一读取指定 Profile 的 parents：文件（嵌套/扁平）→ 快照 → 配置 API 回退。
 * 见 {@link getParentNamesWithSource} 的详细分层说明。
 */
export async function getParentNamesFromProfile(
  context: vscode.ExtensionContext,
  profileName: string,
  profileDir: string,
): Promise<string[]> {
  const { parents } = await getParentNamesWithSource(
    context,
    profileName,
    profileDir,
  );
  return parents;
}

/**
 * 为当前 Profile 写入父级列表到 settings.json。
 * 不触发同步——调用者需自行调用 reconcileAllProfiles。
 * 写入使用**扁平 key** `"inheritProfile.parents"`（VS Code 配置系统与
 * Settings Sync 兼容格式），同时清理旧嵌套 parents 防止双份歧义。
 */
export async function writeParentProfiles(
  context: vscode.ExtensionContext,
  parentNames: string[],
): Promise<void> {
  const { currentProfileDirectory, currentProfileName } =
    await getCurrentProfileDetails(context);
  const settingsPath = path.join(currentProfileDirectory, "settings.json");
  const raw = await readRawSettingsFile(settingsPath);
  const { modify, applyEdits } = await import("jsonc-parser");
  const options: import("jsonc-parser").ModificationOptions = {
    formattingOptions: { insertSpaces: true, tabSize: 4 },
  };

  // 分步写入避免重叠 edits：先删旧嵌套 parents，再写扁平 parents。
  // ⚠️ 只有存在嵌套 inheritProfile 对象时才删（同 restoreParentsFromSnapshot，
  // 纯扁平文件下 jsonc-parser 删除不存在的路径会抛异常）。
  let intermediate = raw;
  if ((parseJSONC(raw) as Record<string, any>)?.inheritProfile) {
    const edits1 = modify(raw, ["inheritProfile", "parents"], undefined, options);
    intermediate = applyEdits(raw, edits1);
  }
  const edits2 = modify(
    intermediate,
    ["inheritProfile.parents"],
    parentNames,
    options,
  );
  const updated = applyEdits(intermediate, edits2);
  await writeManagedFile(settingsPath, updated);
  invalidateInheritanceGraph();
  // 记录快照（跨设备同步 + 丢失恢复）
  await setParentSnapshot(context, currentProfileName, parentNames);
  console.info(
    `Parents for \`${currentProfileName}\` set to: [${parentNames.join(", ")}]`,
  );
}

// ---------------------------------------------------------------------------

/**
 * Reads JSONC (JSON with comments).
 * @param filePath Path to the JSON/JSONC file.
 * @returns Parsed object or {} on error.
 */
export async function readJSON(filePath: string): Promise<any> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseJSONC(raw); // handles // and /* */ comments
  } catch (error) {
    console.error(`Failed to read JSONC at ${filePath}:`, error);
    return {};
  }
}

/**
 * @returns The user directory.
 */
function getUserDirectory(context: vscode.ExtensionContext): string {
  return path.resolve(context.globalStorageUri.fsPath, "../../");
}

/**
 * Gets the path to the global storage JSON file.
 * @param context Extension context.
 * @returns Returns the path to the global storage JSON file.
 */
export function getGlobalStoragePath(context: vscode.ExtensionContext): string {
  return path.resolve(context.globalStorageUri.fsPath, "../storage.json");
}

/**
 * Reads the global storage JSON file.
 *
 * This contains a lot of useful information about profiles.
 * @param context Extension context.
 * @returns Returns the contents of the global storage JSON file.
 */
async function readGlobalStorage(
  context: vscode.ExtensionContext,
): Promise<any> {
  const storagePath: string = getGlobalStoragePath(context);
  return await readJSON(storagePath);
}

/**
 * Extracts the custom profiles section from the global storage JSON file.
 *
 * This is useful for finding out the names and paths of the user created
 * profiles.
 * @param context Extension context.
 * @returns Returns the contents of the `userDataProfiles` filed from the global
 * storage JSON file.
 */
async function getCustomProfiles(
  context: vscode.ExtensionContext,
): Promise<any[]> {
  const storage = await readGlobalStorage(context);
  return storage.userDataProfiles ?? [];
}

/**
 * Finds a record by a key value pair within the record.
 * @param obj Object to search.
 * @param key Key to search.
 * @param value Expected value of the key.
 * @returns Returns the record with the given ID.
 */
function findByKeyValuePair(
  input: unknown,
  key: string,
  value: unknown,
): any | undefined {
  const seen = new Set<object>();

  function dfs(node: unknown): any | undefined {
    if (node === null || typeof node !== "object") {
      return undefined;
    }
    if (seen.has(node as object)) {
      return undefined;
    }
    seen.add(node as object);

    if (!Array.isArray(node)) {
      if (
        Object.prototype.hasOwnProperty.call(node, key) &&
        (node as any)[key] === value
      ) {
        return node;
      }
      for (const v of Object.values(node as Record<string, unknown>)) {
        const found = dfs(v);
        if (found) {
          return found;
        }
      }
    } else {
      for (const item of node as unknown[]) {
        const found = dfs(item);
        if (found) {
          return found;
        }
      }
    }

    return undefined;
  }

  return dfs(input);
}

/**
 * Gets the current profile name.
 * @param context Extension context.
 * @returns Returns the name of the current profile.
 */
export async function getCurrentProfileName(
  context: vscode.ExtensionContext,
): Promise<string> {
  const storage = await readGlobalStorage(context);
  const profilesSubMenu = findByKeyValuePair(
    storage,
    "id",
    "submenuitem.Profiles",
  );
  if (profilesSubMenu) {
    const submenuItems = profilesSubMenu.submenu.items;
    for (const submenuItem of submenuItems) {
      if (submenuItem.checked) {
        const fullProfileId: string = submenuItem.id;
        const profileId = fullProfileId.substring(
          fullProfileId.lastIndexOf(".") + 1,
        );
        const profileData = findByKeyValuePair(storage, "location", profileId);
        if (profileData) {
          return profileData.name;
        }
      }
    }
  }

  const workspaceUri: vscode.Uri | undefined =
    vscode.workspace.workspaceFile ||
    vscode.workspace.workspaceFolders?.at(0)?.uri;
  if (workspaceUri) {
    const workspaceKey = workspaceUri.toString();
    const workspaceAssociations = storage.profileAssociations?.workspaces;
    if (
      workspaceAssociations &&
      Object.prototype.hasOwnProperty.call(workspaceAssociations, workspaceKey)
    ) {
      const profileId = workspaceAssociations[workspaceKey];
      const profile = findByKeyValuePair(
        storage.userDataProfiles,
        "location",
        profileId,
      );
      return profile?.name || "Default";
    }
  }

  // Fallback for empty windows (no workspace/folder open):
  // In VS Code 1.127+, the profile menu structure is no longer in storage.json.
  // Use the current window's backup folder ID to look up the profile association.
  const lastActiveWindow = storage.windowsState?.lastActiveWindow;
  if (lastActiveWindow?.backupPath) {
    const backupFolderId = path.basename(lastActiveWindow.backupPath);
    const emptyWindows = storage.profileAssociations?.emptyWindows;
    if (
      emptyWindows &&
      Object.prototype.hasOwnProperty.call(emptyWindows, backupFolderId)
    ) {
      const profileId = emptyWindows[backupFolderId];
      const profile = findByKeyValuePair(
        storage.userDataProfiles,
        "location",
        profileId,
      );
      if (profile?.name) {
        return profile.name;
      }
    }
  }

  return "Default";
}

/**
 * Finds each of the profiles in the user directory and returns a mapping from
 * the profile name to the profile directory.
 * @param context Extension context.
 * @returns A mapping from profile name to the directory for the profile.
 */
export async function getProfileMap(
  context: vscode.ExtensionContext,
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const userDirectory = getUserDirectory(context);

  // Add the default profile:
  // NOTE: The default profile always exists in the user directory.
  map["Default"] = userDirectory;

  // Add the custom profiles:
  let customProfiles: any[] = await getCustomProfiles(context);
  for (const profile of customProfiles) {
    // 跳过内置 profile (如 VS Code 1.127+ 的 "Agents", location 形如
    // "builtin/agents"), 它们的目录不在 User/profiles 下, 无法读取
    // settings.json / extensions.json, 也不应参与继承体系。
    if (profile.location && String(profile.location).startsWith("builtin/")) {
      console.info(
        `Skipping builtin profile \`${profile.name}\` (location: ${profile.location}).`,
      );
      continue;
    }
    if (profile.name && profile.location) {
      map[profile.name] = path.join(
        userDirectory,
        "profiles",
        profile.location,
      );
    }
  }

  return map;
}

/**
 * Gets the current profile name, directory, and full profile map.
 * @param context Extension context.
 * @returns Returns details about the current profile.
 */
export async function getCurrentProfileDetails(
  context: vscode.ExtensionContext,
): Promise<{
  currentProfileName: string;
  currentProfileDirectory: string;
  profiles: Record<string, string>;
}> {
  const currentProfileName = await getCurrentProfileName(context);
  const profiles = await getProfileMap(context);
  const currentProfileDirectory = profiles[currentProfileName];
  if (!currentProfileDirectory) {
    throw new Error(
      `Unable to find current profile directory for \`${currentProfileName}\` profile.`,
    );
  }

  return {
    currentProfileName,
    currentProfileDirectory,
    profiles,
  };
}

/**
 * Collects the settings for each of the profiles.
 *
 * This function will start with the first profile in the list. This function
 * will override properties that are redefined in profiles that appear towards
 * the end of the list.
 * @param context Extension context.
 * @param profiles List of profiles to collect settings for.
 * @returns Flattened settings from the provided profiles.
 */
async function getProfileSettings(
  context: vscode.ExtensionContext,
  profiles: string[],
): Promise<Record<string, string>> {
  const profileMap: Record<string, string> = await getProfileMap(context);
  var settings: Record<string, string> = {};
  console.debug(
    `Collecting settings from ${profiles.length} different profiles.`,
  );
  for (const profileName of profiles) {
    const profilePath = profileMap[profileName];
    if (!profilePath) {
      console.warn(
        `Failed to collect settings for profile ${profileName}: Profile does not exist.`,
      );
      continue;
    }
    const settingsPath = path.join(profilePath, "settings.json");
    // TODO: We could also collect extensions here

    const profileSettings = stripManagedProfileSettings(
      flattenSettings(await readJSON(settingsPath)),
    );
    console.debug(
      `Found ${Object.keys(profileSettings).length} settings from \`${settingsPath}\`.`,
    );
    settings = mergeFlattenedSettings(settings, profileSettings);
    console.debug(
      `Merged ${settingsPath} into collected settings. Current total settings ${Object.keys(settings).length}.`,
    );
  }
  return stripManagedProfileSettings(settings);
}

/**
 * Gets the settings for the current profile.
 * @param context Extension context.
 * @returns Returns the flattened settings for the current profile.
 */
async function getCurrentProfileSettings(
  context: vscode.ExtensionContext,
): Promise<Record<string, string>> {
  const currentProfileName = await getCurrentProfileName(context);
  return flattenSettings(
    await getProfileSettings(context, [currentProfileName]),
  );
}

/**
 * Gets the settings that are missing from the current profile.
 * @param context Extension context.
 * @returns Returns the flattened settings that are missing from the current profile.
 */
async function getInheritedSettings(
  context: vscode.ExtensionContext,
): Promise<Record<string, string>> {
  const currentProfileSettings = await getCurrentProfileSettings(context);
  console.info(
    `Found ${Object.keys(currentProfileSettings).length} settings in current profile.`,
  );

  // 从文件读取 parents（含快照恢复），不依赖 VS Code 配置缓存
  const { currentProfileName, currentProfileDirectory } =
    await getCurrentProfileDetails(context);
  const parentProfiles = await getParentNamesFromProfile(
    context,
    currentProfileName,
    currentProfileDirectory,
  );
  const parentProfileSettings = await getProfileSettings(
    context,
    parentProfiles,
  );
  console.info(
    `Found ${Object.keys(parentProfileSettings).length} settings in parent profiles.`,
  );

  const inheritedSettings = subtractSettings(
    parentProfileSettings,
    currentProfileSettings,
  );
  console.info(
    `Found ${Object.keys(inheritedSettings).length} inherited in from parent profiles.`,
  );

  const sortedInheritedSettings = sortSettings(inheritedSettings);
  return sortedInheritedSettings;
}

/**
 * Removes the inherited settings block (including the markers) from a settings
 * file.
 *
 * If no markers are found, the file is left unchanged.
 *
 * NOTE: Removes ALL inherited blocks, not just the first one — see
 * {@link stripInheritedSettingsBlocks} for why that matters.
 */
async function removeInheritedSettingsFromFile(
  settingsPath: string,
): Promise<void> {
  console.info(`Removing inherited settings from \`${settingsPath}\`.`);

  // Find the start and end markers:
  let raw = "";
  try {
    raw = await readRawSettingsFile(settingsPath);
  } catch (error) {
    console.error(
      `Failed to read settings file at \`${settingsPath}\`:`,
      error,
    );
    return;
  }

  const { cleaned: stripped, removedCount } =
    stripInheritedSettingsBlocks(raw);

  if (removedCount === 0) {
    return; // markers not found, leave file alone
  }

  // Ensure JSONC ends properly:
  let cleaned = removeTrailingComma(stripped);
  if (!cleaned.endsWith("}")) {
    cleaned += "\n}";
  }

  console.info(
    `Removed ${removedCount} inherited settings block(s) from \`${settingsPath}\`.`,
  );

  // Write cleaned file:
  await writeManagedFile(settingsPath, cleaned + "\n");
}

/**
 * Writes a set of inherited settings to a settings path.
 *
 * IMPORTANT: This function assumes that there are no inherited settings in the
 * file. Any inherited settings should be removed before calling this function.
 */
async function writeInheritedSettings(
  settingsPath: string,
  flattened: Record<string, any>,
): Promise<void> {
  // Early exit if there is nothing to add:
  if (Object.keys(flattened).length === 0) {
    return;
  }

  // Read the raw file, split it by the closing brace, and get the tab size
  // for formatting:
  const raw = await readRawSettingsFile(settingsPath);
  const [beforeClose, afterClose] = await splitRawSettingsByClosingBrace(raw);
  const tab = findTabValue(raw);

  // Build the inherited settings block:
  const block = buildInheritedSettingsBlock(flattened, tab);

  // Insert the inherited settings block between the before and after closing
  // brace blocks:
  const beforeClosePlusBlock = insertBeforeClose(beforeClose, block);
  const finalSettings = beforeClosePlusBlock + afterClose;

  // Write the final settings to the settings path:
  await writeManagedFile(settingsPath, finalSettings);
}

/**
 * Reads and returns a raw `settings.json` file.
 */
export async function readRawSettingsFile(
  settingsPath: string,
): Promise<string> {
  try {
    return await fs.readFile(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "{\n}\n";
    }
    throw error;
  }
}

/**
 * Applies the inherited settings to the current profile.
 * @param context Extension context.
 */
async function applyInheritedSettings(
  context: vscode.ExtensionContext,
): Promise<void> {
  const { currentProfileName, currentProfileDirectory, profiles } =
    await getCurrentProfileDetails(context);
  const currentProfilePath = path.join(
    currentProfileDirectory,
    "settings.json",
  );

  // Remove the inherited settings from the current profile:
  await removeInheritedSettingsFromFile(currentProfilePath);

  // Get the settings that the current profile should inherit:
  const inheritedSettings = await getInheritedSettings(context);
  const totalInheritedSettings = Object.keys(inheritedSettings).length;
  console.info(
    `Found ${totalInheritedSettings} inherited settings for \`${currentProfileName}\` profile.`,
  );
  if (totalInheritedSettings > 0) {
    console.info(
      `Merging ${totalInheritedSettings} settings into \`${currentProfilePath}\`.`,
    );
    await writeInheritedSettings(currentProfilePath, inheritedSettings);
  }

  const config = vscode.workspace.getConfiguration("inheritProfile");
  if (!config.get<boolean>("inheritExtensions", true)) {
    console.info("Extension inheritance is disabled, skipping extensions.");
    return;
  }

  const currentExtensionsPath = path.join(
    currentProfileDirectory,
    "extensions.json",
  );
  const parsedCurrentExtensions = await readJSON(currentExtensionsPath);
  const currentExtensions = Array.isArray(parsedCurrentExtensions)
    ? parsedCurrentExtensions
    : [];
  // Collect and write inherited extensions
  const extResult = await collectInheritedExtensions(
    context,
    currentExtensions,
    currentProfileName,
    profiles,
  );
  const finalExtensions = extResult.extensions;
  if (JSON.stringify(finalExtensions) !== JSON.stringify(currentExtensions)) {
    console.info(
      `Writing ${finalExtensions.length} extensions to \`${currentExtensionsPath}\`.`,
    );
    await writeManagedFile(
      currentExtensionsPath,
      JSON.stringify(finalExtensions, null, 4) + "\n",
    );
  }

  // 回写 _originallyOwnExtensions 和 optedOutExtensions 到 settings.json（扁平 key）
  const { originallyOwn, optedOut } = extResult;
  if (originallyOwn.length > 0 || optedOut.length > 0) {
    let rawSettings = await readRawSettingsFile(currentProfilePath);

    const options: import("jsonc-parser").ModificationOptions = {
      formattingOptions: { insertSpaces: true, tabSize: 4 },
    };

    const { modify, applyEdits } = await import("jsonc-parser");

    // 先删旧嵌套残留（仅当嵌套对象存在），再写扁平 key
    const settings = parseJSONC(rawSettings) as Record<string, any>;
    let updatedSettings = rawSettings;
    if (settings?.inheritProfile) {
      const editsN0 = modify(
        rawSettings,
        ["inheritProfile", "_originallyOwnExtensions"],
        undefined,
        options,
      );
      updatedSettings = applyEdits(rawSettings, editsN0);
      const editsN1 = modify(
        updatedSettings,
        ["inheritProfile", "optedOutExtensions"],
        undefined,
        options,
      );
      updatedSettings = applyEdits(updatedSettings, editsN1);
    }

    const edits: import("jsonc-parser").Edit[] = [
      ...modify(updatedSettings, ["inheritProfile._originallyOwnExtensions"], originallyOwn, options),
      ...modify(updatedSettings, ["inheritProfile.optedOutExtensions"], optedOut, options),
    ];
    updatedSettings = applyEdits(updatedSettings, edits);
    await writeManagedFile(currentProfilePath, updatedSettings);
  }

  // 备份当前 profile 的 extension 标记到 globalState，用于跨设备恢复
  const existingBackup = context.globalState.get<Record<string, Record<string, string>>>(
    "inheritProfile.extensionMarkers"
  ) ?? {};
  const existingMarkers = existingBackup[currentProfileName] ?? {};
  const extensionMarkersBackup = { ...existingMarkers };
  for (const ext of finalExtensions) {
    const id = ext?.identifier?.id;
    if (id && isInheritedExtension(ext) && !extensionMarkersBackup[id]) {
      extensionMarkersBackup[id] = ""; // 理论不会走到这里，兜底
    }
  }
  void context.globalState.update(
    "inheritProfile.extensionMarkers",
    {
      ...existingBackup,
      [currentProfileName]: extensionMarkersBackup,
    }
  );
}

/**
 * Collect extensions from parent profiles, merge with current profile extensions,
 * and mark inherited extensions in their metadata.
 *
 * This is the full 7-step reconciliation process:
 *   1. Read settings.json metadata (originallyOwn, optedOut)
 *   2. Convert old markers (inheritedFromProfile → inheritProfile.inherited)
 *   3. Inject optedOutList markers from settings.json
 *   3.5 Consistency check: settings.json list ↔ extensions.json markers
 *   4. Collect parent profiles' extensions
 *   5. Full reconciliation via mergeInheritedExtensions
 *   5.5 Post-process: catch opt-outs for extensions that didn't exist yet
 *   6. Backup parentNameMap to globalState
 *   7. Statistics & return
 *
 * @param context Extension context (for globalState access).
 * @param currentExtensions The parsed extensions array from the current profile.
 * @param currentProfileName Name of the current profile.
 * @param profiles A map of profile names to their directory paths.
 * @param originallyOwn Optional pre-read originallyOwn list.
 * @param optedOutList Optional pre-read optedOut list.
 * @returns The merged result plus metadata for back-writing.
 */
async function collectInheritedExtensions(
  context: vscode.ExtensionContext,
  currentExtensions: any[],
  currentProfileName: string,
  profiles: Record<string, string>,
  originallyOwn?: string[],
  optedOutList?: string[],
  parentProfileNamesOverride?: string[],
): Promise<{ extensions: any[]; originallyOwn: string[]; optedOut: string[] }> {
  // 1. 如调用者未传入, 从 settings.json 读取元数据
  const currentProfileDir = profiles[currentProfileName];
  if (!currentProfileDir) {
    console.error(
      `Cannot collect inherited extensions: profile directory for \`${currentProfileName}\` not found.`
    );
    return { extensions: currentExtensions, originallyOwn: [], optedOut: [] };
  }

  if (!originallyOwn || !optedOutList) {
    const settingsPath = path.join(currentProfileDir, "settings.json");
    const settings = await readJSON(settingsPath);
    // 兼容嵌套/扁平两种格式（扁平是目标格式，防 Settings Sync 节点锁定）
    originallyOwn =
      settings?.inheritProfile?._originallyOwnExtensions ??
      settings?.["inheritProfile._originallyOwnExtensions"] ??
      [];
    optedOutList =
      settings?.inheritProfile?.optedOutExtensions ??
      settings?.["inheritProfile.optedOutExtensions"] ??
      [];
  }

  // 2. 转换旧标记并持久化（仅首次需要）
  const migrationDoneKey = "inheritProfile._markersConverted";
  let markersAlreadyConverted = false;
  if (context.globalState.get(migrationDoneKey)) {
    markersAlreadyConverted = true;
  }

  // 始终通过 .map() 创建拷贝, 防止 step 3/3.5 的原位突变影响 caller 的数组
  let converted: any[];
  if (markersAlreadyConverted) {
    // 浅拷贝: 每个条目的 metadata 是共享引用, 但 step 3 替换整个 metadata 对象
    // (ext.metadata = {...}) 而非浅修改 (ext.metadata.foo = bar),
    // 所以浅拷贝足够安全
    converted = currentExtensions.map((e: any) => ({ ...e }));
  } else {
    converted = currentExtensions.map(convertOldMarkers);
  }

  if (!markersAlreadyConverted) {
    const hasOldMarkers = currentExtensions.some(
      (e: any) => e?.metadata?.inheritedFromProfile
    );
    if (hasOldMarkers) {
      const extPath = path.join(profiles[currentProfileName], "extensions.json");
      await writeManagedFile(
        extPath,
        JSON.stringify(converted, null, 4) + "\n",
      );
    }
    void context.globalState.update(migrationDoneKey, true);
  }

  // 3. 将 optedOutList 中的跳过注入为 optedOut 标记
  for (const ext of converted) {
    const id = ext?.identifier?.id;
    if (id && optedOutList!.includes(id) && !isOptedOutExtension(ext)) {
      ext.metadata = {
        ...(ext.metadata ?? {}),
        inheritProfile: {
          ...(ext.metadata?.inheritProfile ?? {}),
          optedOut: true,
        },
      };
    }
  }

  // 3.5 一致性校验: settings.json 的 optedOutExtensions 列表 ↔ extensions.json 的标记
  const idsWithOrphanedOptOut = new Set<string>();
  for (const ext of converted) {
    const id = ext?.identifier?.id;
    if (id && isOptedOutExtension(ext) && !optedOutList!.includes(id)) {
      idsWithOrphanedOptOut.add(id);
    }
  }
  if (idsWithOrphanedOptOut.size > 0) {
    console.warn(
      `Found ${idsWithOrphanedOptOut.size} extension(s) with orphaned optedOut marker ` +
      `(not in optedOutExtensions list): ${[...idsWithOrphanedOptOut].join(", ")}. ` +
      `Removing markers to sync with settings.json.`
    );
    for (const ext of converted) {
      const id = ext?.identifier?.id;
      if (id && idsWithOrphanedOptOut.has(id)) {
        const { inheritProfile, ...restMeta } = ext.metadata ?? {};
        const { optedOut: _, ...cleanProfile } = inheritProfile ?? {};
        ext.metadata = Object.keys(cleanProfile).length > 0
          ? ({ ...restMeta, inheritProfile: cleanProfile } as any)
          : Object.keys(restMeta).length > 0
            ? (restMeta as any)
            : undefined;
      }
    }
  }

  // 4. 获取父级列表 (优先使用调用者传入的, 否则从文件读取 + 快照恢复)
  let parentProfileNames: string[];
  if (parentProfileNamesOverride) {
    parentProfileNames = parentProfileNamesOverride;
  } else {
    parentProfileNames = await getParentNamesFromProfile(
      context,
      currentProfileName,
      currentProfileDir,
    );
  }

  const parentProfiles: { profileName: string; extensions: any[] }[] = [];
  const parentDisabledIds: string[] = [];
  for (const profileName of parentProfileNames) {
    const profileDirectory = profiles[profileName];
    if (!profileDirectory) continue;
    const rawProfileExtensions = await readJSON(
      path.join(profileDirectory, "extensions.json")
    );
    // 收集禁用扩展 ID（从 SQLite state.vscdb）用于后续过滤
    const disabledIds = await getDisabledExtensions(profileDirectory);
    parentDisabledIds.push(...disabledIds);
    // 传入全部扩展（含 disabled: true）到 mergeInheritedExtensions，
    // 确保子级中 own 的扩展能被正确转为 inherited
    const extensions = Array.isArray(rawProfileExtensions) ? rawProfileExtensions : [];
    parentProfiles.push({
      profileName,
      extensions,
    });
  }

  // 5. 全量对账
  const result = mergeInheritedExtensions(converted, parentProfiles, originallyOwn);

  // 5.5 后处理: 从 result.merged 中移除 optedOutList 中但被 mergeInheritedExtensions
  //     误加为 inherited 的条目
  let finalMerged = result.merged.map((ext) => {
    const id = ext?.identifier?.id;
    if (id && optedOutList!.includes(id) && isInheritedExtension(ext)) {
      return markExtensionAsOptedOut(id, ext) as typeof ext;
    }
    return ext;
  });

  // 5.6 后处理: 移除父级已禁用的扩展（仅影响 inherited 的）
  //     disabled:true 或 state.vscdb 中标记为禁用的扩展不会被继承
  const disabledIdSet = new Set(parentDisabledIds);
  for (const ext of parentProfiles.flatMap(p => p.extensions)) {
    const id = ext?.identifier?.id;
    if (id && ext?.disabled === true) {
      disabledIdSet.add(id);
    }
  }
  if (disabledIdSet.size > 0) {
    const beforeCount = finalMerged.length;
    finalMerged = finalMerged.filter((ext) => {
      const id = ext?.identifier?.id;
      if (id && disabledIdSet.has(id) && isInheritedExtension(ext)) {
        return false;
      }
      // 如果父级禁用了但子级是 own — 保留不受影响
      return true;
    });
    const removedCount = beforeCount - finalMerged.length;
    if (removedCount > 0) {
      console.info(
        `Removed ${removedCount} inherited extension(s) that are disabled in parent profiles.`,
      );
    }
  }

  // 6. 将 parentNameMap 存入 globalState（用于 extensionMarkers 备份）
  const finalParentNameMap = { ...result.parentNameMap };
  for (const ext of finalMerged) {
    const id = ext?.identifier?.id;
    if (id && isOptedOutExtension(ext) && finalParentNameMap[id]) {
      delete finalParentNameMap[id];
    }
  }

  const existingBackup = context.globalState.get<Record<string, Record<string, string>>>(
    "inheritProfile.extensionMarkers"
  ) ?? {};
  const mergedBackup = {
    ...(existingBackup[currentProfileName] ?? {}),
    ...finalParentNameMap,
  };
  if (Object.keys(finalParentNameMap).length > 0) {
    await context.globalState.update("inheritProfile.extensionMarkers", {
      ...existingBackup,
      [currentProfileName]: mergedBackup,
    });
  }

  // 7. 统计真实新增/移除
  const prevInheritedIds = new Set(
    converted
      .filter((e: any) => isInheritedExtension(e))
      .map((e: any) => e.identifier?.id)
  );
  const newInheritedIds = new Set(
    finalMerged
      .filter((e: any) => isInheritedExtension(e))
      .map((e: any) => e.identifier?.id)
  );
  const addedCount = [...newInheritedIds].filter((id) => !prevInheritedIds.has(id)).length;
  const removedCount = [...prevInheritedIds].filter((id) => !newInheritedIds.has(id)).length;

  if (addedCount > 0 || removedCount > 0) {
    console.info(
      `Extensions reconciled for \`${currentProfileName}\`: ${addedCount} inherited, ${removedCount} uninherited.`
    );
  }

  return {
    extensions: finalMerged,
    originallyOwn: result.originallyOwnExtensions,
    optedOut: optedOutList ?? [],
  };
}

/**
 * 恢复所有 Profile 中缺失的 parents（从 globalState 快照写回扁平格式）。
 * 防御 Settings Sync 覆盖删除后，继承图/级联触发/继承树全部退化的场景。
 * 幂等：文件已有 parents（含 []）则跳过。
 */
async function restoreAllParents(
  context: vscode.ExtensionContext,
  profiles: Record<string, string>,
): Promise<void> {
  for (const [profileName, profileDir] of Object.entries(profiles)) {
    await restoreParentsFromSnapshot(context, profileName, profileDir);
  }
}

/**
 * Updates the inherited settings for the current profile.
 *
 * When `triggerProfileName` is provided, only performs reconciliation if the
 * current profile is a descendant of the trigger profile (cascading trigger).
 * When omitted, always reconciles the current profile (full sync).
 *
 * @param context Extension context.
 * @param triggerProfileName Optional. If set, only reconcile if current
 *   profile is a descendant of this profile (used for cascading triggers).
 */
export async function updateCurrentProfileInheritance(
  context: vscode.ExtensionContext,
  triggerProfileName?: string,
): Promise<void> {
  const { currentProfileName, profiles } = await getCurrentProfileDetails(context);

  // 先恢复所有缺失 parents（Settings Sync 覆盖防御）——
  // 否则继承图会退化为全根，级联判断与树展示全部失真。
  // 幂等：文件已有 parents 的 profile 不会重写。
  await restoreAllParents(context, profiles);
  invalidateInheritanceGraph();

  if (triggerProfileName) {
    // 级联触发: 仅对账触发 profile 的后代
    const graph = getInheritanceGraph(profiles);
    const descendants = getDescendants(triggerProfileName, graph);

    if (!descendants.includes(currentProfileName)) {
      console.info(
        `Skipping reconciliation for ${currentProfileName}: ` +
        `not a descendant of trigger ${triggerProfileName}.`
      );
      return;
    }
  }

  await applyInheritedSettings(context);

  const config = vscode.workspace.getConfiguration("inheritProfile");
  if (config.get<boolean>("showMessages", true)) {
    vscode.window.showInformationMessage("Inherited profile settings applied!");
  }
}

// ---------------------------------------------------------------------------
// 全量重建 + 单 Profile 同步
// ---------------------------------------------------------------------------

/**
 * 同步指定 Profile 的继承（设置 + 扩展）。
 * 直接从该 Profile 的 settings.json 读取 parents，不依赖 vscode 当前配置。
 */
async function syncProfileByName(
  context: vscode.ExtensionContext,
  profileName: string,
  profileDir: string,
  profiles: Record<string, string>,
): Promise<void> {
  const settingsPath = path.join(profileDir, "settings.json");
  const rawSettings = (await readJSON(settingsPath)) ?? {};
  // 兼容两种存储格式（嵌套/扁平）+ 快照恢复（Settings Sync 覆盖防御）
  const { parents: parentNames, source } = await getParentNamesWithSource(
    context,
    profileName,
    profileDir,
  );
  // 同步时顺带刷新快照，供 Settings Sync 删除后的自动恢复使用。
  // ⚠️ 仅 file/snapshot 来源刷新——config 来源是**过期缓存**，固化它会导致
  // 用户手动删除的 parents 被缓存旧值复活。
  if (source === "file" || source === "snapshot") {
    await setParentSnapshot(context, profileName, parentNames);
  }

  // 1. 设置继承
  await removeInheritedSettingsFromFile(settingsPath);

  const parentProfileSettings = await getProfileSettings(context, parentNames);
  const ownSettings = stripManagedProfileSettings(flattenSettings(rawSettings));
  const inheritedSettings = sortSettings(
    subtractSettings(parentProfileSettings, ownSettings),
  );
  if (Object.keys(inheritedSettings).length > 0) {
    await writeInheritedSettings(settingsPath, inheritedSettings);
  }

  // 2. 扩展继承
  const config = vscode.workspace.getConfiguration("inheritProfile");
  if (config.get<boolean>("inheritExtensions", true)) {
    const extPath = path.join(profileDir, "extensions.json");
    const parsedExts = await readJSON(extPath);
    const currentExtensions = Array.isArray(parsedExts) ? parsedExts : [];

    const extResult = await collectInheritedExtensions(
      context,
      currentExtensions,
      profileName,
      profiles,
      rawSettings?.inheritProfile?._originallyOwnExtensions ??
      rawSettings?.["inheritProfile._originallyOwnExtensions"],
      rawSettings?.inheritProfile?.optedOutExtensions ??
      rawSettings?.["inheritProfile.optedOutExtensions"],
      parentNames,
    );

    const finalExtensions = extResult.extensions;
    if (
      JSON.stringify(finalExtensions) !== JSON.stringify(currentExtensions)
    ) {
      await writeManagedFile(
        extPath,
        JSON.stringify(finalExtensions, null, 4) + "\n",
      );
    }

    // 回写元数据（扁平 key，防 Settings Sync 节点锁定；同时清理旧嵌套残留）
    const { originallyOwn, optedOut } = extResult;
    if (originallyOwn.length > 0 || optedOut.length > 0) {
      let rawSettingsContent = await readRawSettingsFile(settingsPath);
      const { modify, applyEdits } = await import("jsonc-parser");
      const options = {
        formattingOptions: { insertSpaces: true, tabSize: 4 },
      };

      // 逐条应用 edits, 避免同时修改同一对象导致 Overlapping edit。
      // 先删旧嵌套元数据（仅当嵌套对象存在），再写扁平 key。
      const settings = parseJSONC(rawSettingsContent) as Record<string, any>;
      let updated = rawSettingsContent;
      if (settings?.inheritProfile) {
        const edits0 = modify(
          rawSettingsContent,
          ["inheritProfile", "_originallyOwnExtensions"],
          undefined,
          options,
        );
        updated = applyEdits(rawSettingsContent, edits0);
        const edits0b = modify(
          updated,
          ["inheritProfile", "optedOutExtensions"],
          undefined,
          options,
        );
        updated = applyEdits(updated, edits0b);
      }
      const edits1 = modify(
        updated,
        ["inheritProfile._originallyOwnExtensions"],
        originallyOwn,
        options,
      );
      updated = applyEdits(updated, edits1);
      const edits2 = modify(
        updated,
        ["inheritProfile.optedOutExtensions"],
        optedOut,
        options,
      );
      updated = applyEdits(updated, edits2);
      await writeManagedFile(settingsPath, updated);
    }
  }
}

/**
 * 全量重建：从根 Profile 开始逐级向下同步所有 Profile。
 * 确保每一级都基于最新的父级状态。
 */
export async function reconcileAllProfiles(
  context: vscode.ExtensionContext,
): Promise<void> {
  const profiles = await getProfileMap(context);

  // 先恢复所有缺失的 parents（防止 Settings Sync 覆盖后继承图退化为全根）
  await restoreAllParents(context, profiles);

  invalidateInheritanceGraph();
  const graph = getInheritanceGraph(profiles);

  // 收集所有出现在 children 中的 profile
  const allChildren = new Set<string>();
  for (const children of Object.values(graph)) {
    for (const c of children) {
      allChildren.add(c);
    }
  }

  // 根节点 = 不是任何人的孩子的 profile
  const roots = Object.keys(profiles).filter((p) => !allChildren.has(p));

  // BFS 拓扑排序: 保证父级在子级之前被同步
  const visited = new Set<string>();
  const order: string[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    order.push(current);
    const children = graph[current] ?? [];
    for (const child of children) {
      if (!visited.has(child)) queue.push(child);
    }
  }

  console.info(
    `Reconciliation order: ${order.join(" \u2192 ")}`,
  );

  for (const profileName of order) {
    const profileDir = profiles[profileName];
    if (!profileDir) continue;
    console.info(`Reconciling profile: ${profileName}`);
    await syncProfileByName(context, profileName, profileDir, profiles);
  }
}

/**
 * Removes the inherited settings from the current profile.
 * @param context Extension context.
 */
export async function removeCurrentProfileInheritedSettings(
  context: vscode.ExtensionContext,
): Promise<void> {
  const { currentProfileName, currentProfileDirectory } =
    await getCurrentProfileDetails(context);
  const currentProfilePath = path.join(
    currentProfileDirectory,
    "settings.json",
  );
  await removeInheritedSettingsFromFile(currentProfilePath);

  // Also remove inherited extensions from the current profile's extensions.json
  try {
    const currentExtensionsPath = path.join(
      currentProfileDirectory,
      "extensions.json",
    );
    const parsedCurrentExtensions = await readJSON(currentExtensionsPath);
    const currentExtensions = Array.isArray(parsedCurrentExtensions)
      ? parsedCurrentExtensions
      : [];
    // 先转换旧标记, 统一格式后再 strip, 避免遗漏 inheritedFromProfile 旧格式
    const converted = currentExtensions.map(convertOldMarkers);
    const filteredExtensions = stripInheritedExtensions(converted);
    // Only write if there was a change to avoid unnecessary fs writes
    if (filteredExtensions.length !== converted.length) {
      console.info(
        `Removing ${converted.length - filteredExtensions.length} inherited extensions from \`${currentExtensionsPath}\`.`,
      );
      await writeManagedFile(
        currentExtensionsPath,
        JSON.stringify(filteredExtensions, null, 4) + "\n",
      );
    }
  } catch (err) {
    console.warn(
      `Failed to remove inherited extensions for profile \`${currentProfileName}\`:`,
      err,
    );
  }

  // 清理 settings.json 中的继承元数据键（扁平 key + 清嵌套残留）
  try {
    const settingsPath = path.join(currentProfileDirectory, "settings.json");
    let raw = await readRawSettingsFile(settingsPath);
    const { modify, applyEdits } = await import("jsonc-parser");
    const options: import("jsonc-parser").ModificationOptions = {
      formattingOptions: { insertSpaces: true, tabSize: 4 },
    };
    // 先删嵌套残留
    const parsed = parseJSONC(raw) as Record<string, any>;
    let updated = raw;
    if (parsed?.inheritProfile) {
      for (const key of ["_originallyOwnExtensions", "optedOutExtensions"] as const) {
        updated = applyEdits(
          updated,
          modify(updated, ["inheritProfile", key], undefined, options),
        );
      }
    }
    // 再清扁平 key（重置为空数组而非删除, 避免 jsonc-parser 处理 undefined 行为不确定）
    for (const key of ["inheritProfile._originallyOwnExtensions", "inheritProfile.optedOutExtensions"] as const) {
      updated = applyEdits(
        updated,
        modify(updated, [key], [], options),
      );
    }
    if (updated !== raw) {
      await writeManagedFile(settingsPath, updated);
    }
  } catch (err) {
    console.warn(
      `Failed to clean inheritance metadata from settings.json for \`${currentProfileName}\`:`,
      err,
    );
  }

  const config = vscode.workspace.getConfiguration("inheritProfile");
  if (config.get<boolean>("showMessages", true)) {
    vscode.window.showInformationMessage(
      "Inherited settings removed from current profile!",
    );
  }
}

// ---------------------------------------------------------------------------
// Inheritance Tree 展示
// ---------------------------------------------------------------------------

/**
 * 在 OutputChannel 中展示所有 Profile 的继承树形图。
 * 直接读文件构建树，不依赖 graph 缓存。
 * 注意：由于 VS Code 1.127+ 不通过文件暴露当前激活的 Profile，
 * 树中不显示 "▶" 标记。
 */
export async function showInheritanceTree(
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    // 先全量重建，确保树是最新状态
    await reconcileAllProfiles(context);

    const profiles = await getProfileMap(context);

    // 直接读每个 profile 的 settings.json 获取 parents
    const childToParents: Record<string, string[]> = {};
    for (const [name, dir] of Object.entries(profiles)) {
      const settingsPath = path.join(dir, "settings.json");
      const raw = (await readJSON(settingsPath)) ?? {};
      childToParents[name] =
        raw?.inheritProfile?.parents ??
        raw?.["inheritProfile.parents"] ??
        [];
    }

    // 构建 parent→children 映射
    const children: Record<string, string[]> = {};
    const allChildren = new Set<string>();
    for (const [childName, parentNames] of Object.entries(childToParents)) {
      for (const parentName of parentNames) {
        if (profiles[parentName]) {
          if (!children[parentName]) children[parentName] = [];
          if (!children[parentName].includes(childName)) {
            children[parentName].push(childName);
          }
          allChildren.add(childName);
        }
      }
    }

    // 根节点
    const roots = Object.keys(profiles).filter(
      (p) => !allChildren.has(p),
    );

    const lines: string[] = [];
    lines.push(`Profile Inheritance Tree`);
    lines.push("─".repeat(50));

    function render(node: string, depth: number) {
      const indent = "  ".repeat(depth);
      lines.push(`${indent}${node}`);
      const nodeChildren = children[node] ?? [];
      for (const child of nodeChildren) {
        render(child, depth + 1);
      }
    }

    for (const root of roots) {
      render(root, 0);
    }

    const channel = vscode.window.createOutputChannel("InheritanceTree");
    channel.clear();
    channel.appendLine(lines.join("\n"));
    channel.show(true);
  } catch (err) {
    console.error("showInheritanceTree failed:", err);
    vscode.window.showErrorMessage(
      `Failed to show inheritance tree: ${(err as Error)?.message ?? err}`,
    );
  }
}
