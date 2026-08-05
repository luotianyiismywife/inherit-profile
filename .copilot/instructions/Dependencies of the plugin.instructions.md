---
description: "Use when: 检查 VS Code 新版本兼容性、验证插件依赖的 VS Code 内部文件结构（storage.json/extensions.json/state.vscdb/mcp.json）、升级 engines.vscode 或 @types/vscode 前对照"
---

# inherit-profile-plus — VS Code 依赖清单

> **用途**：记录本插件依赖的 VS Code 公开 API 与**内部文件结构**，以及第三方 npm 包。
> **检查时机**：每次 VS Code 大版本更新（如 1.132、1.133...）后，对照本清单逐项验证，在文末"检查记录"表中追加一行。
> **脆弱度说明**：🔴 高 = VS Code 未文档化的内部结构，版本升级随时可能变；🟡 中 = 公开 API 但行为可能调整；🟢 低 = 稳定公开 API / 已锁版本。

---

## 一、VS Code 内部文件结构依赖（最脆弱，重点盯防）

插件直接读取/写入 VS Code 用户数据目录下的文件。这些文件**不是公开接口**，VS Code 团队可随时改变其结构。

### 1. `storage.json`（用户目录根）— 🔴 高

**路径**：`<用户目录>/storage.json`（`globalStorageUri.fsPath` 的上级）
**读取函数**：`profiles.ts` → `readGlobalStorage()` / `getCurrentProfileName()` / `getProfileMap()`

| 字段 | 用途 | 最新版状态 (1.131) |
|------|------|-------------------|
| `userDataProfiles[]` | Profile 列表：`{name, location, id...}`，location 是 `profiles/` 下的目录 ID | ✅ 仍在写入 |
| `profileAssociations.workspaces` | 工作区 URI → Profile ID 映射（当前 Profile 检测） | ✅ 仍在写入 |
| `profileAssociations.emptyWindows` | 空窗口 backup 目录 ID → Profile ID 映射（empty window fallback） | ✅ 仍在写入 |
| `windowsState.lastActiveWindow.backupPath` | 当前窗口 backup 目录（配合 emptyWindows 反查 Profile） | ✅ 仍在写入 |
| `submenuitem.Profiles` | 旧版 Profile 菜单选中项 → Profile ID | ❌ **1.127 起已不再写入**（源码中已删除该键）→ 插件中该分支是死代码，建议删除 |

**验证方法**（VS Code 源码仓库 `microsoft/vscode`）：
- 搜索 `PROFILES_KEY`（`userDataProfiles`）→ `src/vs/platform/userDataProfile/common/userDataProfile.ts`
- 搜索 `saveStoredProfileAssociations` → 确认 `emptyWindows`/`workspaces` 仍在写
- 搜索 `windowsStateStorageKey` → `src/vs/platform/windows/electron-main/windowsStateHandler.ts`

### 2. `settings.json`（每个 Profile 目录内）— 🟡 中

**路径**：`<用户目录>/profiles/<id>/settings.json`（Default 在用户目录根）
**读写函数**：`profiles.ts` 全链路 + `profileSettings.ts`（JSONC 工具）

| 依赖点 | 说明 |
|--------|------|
| JSONC 格式（注释、尾逗号） | 用 `jsonc-parser` 解析，不依赖 VS Code |
| `inheritProfile` 配置块 | 插件自己的配置键（`parents` 等），通过 `vscode.workspace.getConfiguration` 读取 |
| `inheritProfile.parents` | ⚠️ **必须用扁平格式** `"inheritProfile.parents": [...]`，禁止嵌套 `"inheritProfile": { "parents": ... }`（见下方风险说明） |
| `inheritProfile._insertionBoundary` | 内部门牌设置 |
| inherited 标记块 | 插件自己写入的 `// --- INHERITED SETTINGS MARKER ...` 注释块 |

**风险**：🟡 中。VS Code 对 settings.json 的读写兼容所有 JSONC 变体；唯一注意点是 VS Code 1.127+ 将部分 Profile 跟踪移入内部运行时状态后，**插件通过文件 watcher 监听 settings.json 变更仍有效**（文件本身仍是事实来源）。

> 🔴 **Settings Sync 覆盖陷阱（2026-08-05 实测确认）**：VS Code 设置同步（`User/sync/`）按 Profile 同步 settings.json，其合并引擎 `settingsMerge.parseSettings` **只识别顶层 key**。嵌套 `inheritProfile: { parents }` 会被当作整体节点、无法正确合并 → Sync 拉取应用时用云端（无 parents）版本覆盖本地，**导致继承树消失、继承扩展被清除**。
>
> **开发强制要求**：
> 1. **写 parents 一律用扁平 key** `"inheritProfile.parents"`（jsonc-parser `modify(raw, ["inheritProfile.parents"], ...)`），同时先删旧嵌套 parents（`modify(raw, ["inheritProfile", "parents"], undefined, ...)`）防双份歧义
> 2. `writeParentProfiles` 写入后必须同步 `inheritProfile.parentSnapshots`（globalState）快照；`syncProfileByName` 每次同步刷新快照
> 3. 读 parents 统一走 `getParentNamesFromProfile()`（文件 → 快照恢复），**禁止**用 `vscode.workspace.getConfiguration("inheritProfile").get("parents")`（配置缓存读不到文件已丢失/已恢复的 parents）
> 4. `reconcileAllProfiles` 开头必须先 `restoreParentsFromSnapshot` 恢复所有缺失 parents，再构建继承图

### 3. `extensions.json`（每个 Profile 目录内）— 🔴 高

**路径**：`<用户目录>/profiles/<id>/extensions.json`（Default 在用户目录根）
**读写函数**：`profiles.ts` → `collectInheritedExtensions()` / `mergeInheritedExtensions()`（`profileSettings.ts`）

| 依赖点 | 说明 |
|--------|------|
| 条目结构 `{identifier: {id}, metadata, disabled}` | 扩展 ID 取自 `identifier.id`，标记写入 `metadata.inheritProfile` |
| `metadata` 附加字段 | VS Code 允许扩展往 metadata 写自定义字段（`inheritProfile`），但**不保证**未来不被清理 |
| 文件位置 | `extensionsResource = joinPath(location, 'extensions.json')`（源码确认 1.131 未变） |

**验证方法**：搜索 `extensionsResource` / `extensionsProfileScannerService.ts` 确认条目 schema 与存储位置。

### 4. `state.vscdb`（SQLite，Profile 的 globalStorage 内）— 🔴 高

**路径**：`<用户目录>/profiles/<id>/globalStorage/state.vscdb`
**读取函数**：`disabledExtensions.ts` → `getDisabledExtensions()`（用 sql.js 直接查 SQLite）

| 依赖点 | 说明 |
|--------|------|
| 表 `ItemTable`（`key`/`value` 列） | ✅ 1.131 源码确认未变 |
| 键 `extensionsIdentifiers/disabled` | ✅ 1.131 源码确认未变（`DISABLED_EXTENSIONS_STORAGE_PATH`） |
| value 格式 `[{id, ...}]` | 解析 `item.id` 列表 |

**验证方法**：搜索 `DISABLED_EXTENSIONS_STORAGE_PATH` 与 `ItemTable`。**这是最脆弱点之一**——VS Code 若把禁用状态改存别处（如直接写 extensions.json 的 `disabled` 字段），此模块失效。

### 5. `mcp.json`（每个 Profile 目录内）— 🔴 高（功能缺口）

**路径**：`<用户目录>/profiles/<id>/mcp.json`（`mcpResource`）
**当前状态**：❌ **插件未继承此文件**。VS Code 将 MCP 服务器配置按 Profile 存储（源码：`mcpResource: joinPath(location, 'mcp.json')`，随 MCP 功能引入，约 1.95+），父 Profile 配置的 MCP 服务器不会同步到子 Profile。
**建议**：若你的 Profile 分层使用 MCP，应评估将其纳入继承流程（或至少提供开关）。

---

## 二、VS Code 扩展 API 依赖（公开但需关注）

| API | 使用位置 | 脆弱度 | 备注 |
|-----|---------|--------|------|
| `vscode.commands.registerCommand` | `extension.ts`（5 个命令） | 🟢 低 | 稳定 |
| `vscode.ExtensionContext`（`globalStorageUri` / `globalState` / `subscriptions` / `extension.packageJSON`） | 全部模块 | 🟢 低 | 稳定；`globalStorageUri` 的路径结构是内部依赖的间接来源 |
| `context.globalState.setKeysForSync` | `extension.ts`（同步 extensionMarkers + parentSnapshots） | 🟡 中 | 键名自定，无风险；同步行为可能变化 |
| `vscode.workspace.getConfiguration("inheritProfile")` | 多处读取配置 | 🟢 低 | 稳定 |
| `vscode.workspace.workspaceFile` / `workspaceFolders` | `getCurrentProfileName()` 工作区关联检测 | 🟢 低 | 稳定 |
| `vscode.workspace.createFileSystemWatcher` + `vscode.RelativePattern` | `profileWatchers.ts` 全部监听 | 🟡 中 | **已知陷阱**：监听工作区外文件必须用 RelativePattern 包装绝对路径，否则事件不触发（代码已有注释说明） |
| `vscode.workspace.onDidChangeConfiguration` | `profileWatchers.ts`（parents 配置变更） | 🟢 低 | 稳定 |
| `vscode.window.showQuickPick` / `showInformationMessage` / `showErrorMessage` | `extension.ts` / `profiles.ts` | 🟢 低 | 稳定 |
| `vscode.window.createOutputChannel` | `profiles.ts`（继承树展示） | 🟢 低 | 稳定 |

---

## 三、package.json 清单依赖

| 字段 | 当前值 | 说明 |
|------|--------|------|
| `engines.vscode` | `^1.131.0` | **约定：始终跟随编译时的 VS Code 最新版**（当前 2026-07-31 为 1.131）。VS Code 大版本更新后需同步上调 |
| `activationEvents` | `["onStartupFinished"]` | 启动后自动激活；VS Code 未废弃此事件 |
| `extensionKind` | `["ui"]` | 本地 UI 扩展；因直接读写本地文件系统，**不能**改为 workspace |
| `contributes.commands` | 5 个命令 | 稳定 |
| `contributes.configuration` | `inheritProfile.*` 8 个配置项（含内部 `_insertionBoundary`） | 稳定 |

---

## 四、第三方 npm 依赖

| 包 | 版本 | 用途 | 说明 |
|----|------|------|------|
| `sql.js` | `^1.14.1` | 纯 JS/WASM 读 SQLite（state.vscdb） | 保持最新版即可；WASM 文件路径硬编码在 `disabledExtensions.ts`（`node_modules/sql.js/dist`），打包时注意 |
| `jsonc-parser` | `^3.3.1` | 解析带注释 JSON | 稳定 |
| `@types/vscode` | `^1.125.0` | 类型定义 | ⚠️ **npm 发布滞后于 VS Code 本体**（2026-07-31 时 VS Code 已 1.131，类型包最新仅 1.125）。升级 `engines.vscode` 时类型包可能跟不上，取 npm 实际最新即可；类型缺失不影响运行 |

---

## 五、检查记录

> VS Code 大版本更新后，在此追加一行记录检查结果。检查范围：第一节全部 🔴 项 + 第二节 🟡 项。

| 日期 | VS Code 版本 | 检查结果 | 需要修改的点 |
|------|-------------|---------|-------------|
| 2026-07-31 | 1.131 | ✅ 全部兼容 | ① `submenuitem.Profiles` 分支确认死代码（1.127 起已删），建议清理；② `mcp.json` 未纳入继承（功能缺口，见 一.5） |
| 2026-08-05 | 1.131 | ⚠️ 发现 Settings Sync 覆盖风险 | ① **parents 必须扁平格式**（`inheritProfile.parents`），嵌套格式会被 Settings Sync 覆盖删除 → 已修复（见 一.2 风险说明）；② 新增 parents 快照 `parentSnapshots` + `getParentNamesFromProfile` 统一读取 + `restoreParentsFromSnapshot` 自动恢复；③ `getInheritedSettings`/`collectInheritedExtensions` 不再用 `config.get("parents")`（缓存问题） |

---

## 附：快速自查命令（PowerShell）

```powershell
# 查看当前 VS Code 版本
code --version

# 查看本机 storage.json 是否还有旧键（验证 submenuitem.Profiles 死代码）
Select-String -Path "$env:APPDATA\Code\User\storage.json" -Pattern "submenuitem.Profiles" -SimpleMatch

# 查看本机 profile 目录结构与 mcp.json 存在性
Get-ChildItem "$env:APPDATA\Code\User\profiles" -Recurse -Filter "mcp.json" | Select-Object FullName
```
