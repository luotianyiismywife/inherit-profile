---
description: "Use when: 检查 VS Code 新版本兼容性、更新 engines.vscode 或 @types/vscode、维护依赖清单、升级 VS Code 后验证插件、项目实际结构变更后需更新 .copilot/instructions/ 下的文档"
---

# VS Code 依赖检查约定

本项目默认跟随编译时的 VS Code 最新版。VS Code 发布大版本更新后，必须执行以下检查流程。

## 触发时机

- VS Code 发布大版本更新（1.132、1.133...）后
- 用户要求"检查新版本兼容性"、"看看 VS Code 更新了什么"等
- 用户要求升级 `engines.vscode` 或 `@types/vscode`
- **项目实际结构变更后**（新增/删除/移动/重命名源码文件、目录或文档）

## 必须执行的检查流程

1. **对照依赖清单逐项验证**：打开 `.copilot/instructions/Dependencies of the plugin.instructions.md`，按第一节 🔴 项（storage.json 字段、extensions.json 结构、state.vscdb 键、mcp.json）逐一核实
   - 验证方法：在 `microsoft/vscode` 源码仓库搜索文档中列出的键名（`PROFILES_KEY`、`saveStoredProfileAssociations`、`windowsStateStorageKey`、`DISABLED_EXTENSIONS_STORAGE_PATH`、`extensionsResource` 等）
2. **同步升级 package.json**：
   - `engines.vscode` → 最新 VS Code 版本号
   - `@types/vscode` → npm 实际最新版（先 `npm view @types/vscode version` 查询，可能滞后于 VS Code 本体，取 npm 实际最新即可）
3. **验证**：`npm install` + `npm run compile` 确保编译通过
4. **登记**：在依赖清单文末"检查记录"表追加一行（日期 / VS Code 版本 / 检查结果 / 需要修改的点）

## 项目文档维护约定

`.copilot/instructions/` 存放本项目所有有助于理解的文档，Copilot 处理本项目时会自动加载：

| 文件 | 内容 | 何时更新 |
|------|------|---------|
| `结构.instructions.md` | src 源码结构、模块职责、函数清单、继承/重建流程 | **每次修改 src/ 下源码文件后** |
| `Dependencies of the plugin.instructions.md` | VS Code 内部结构/API/npm 依赖清单 | **每次 VS Code 大版本更新后** |
| `vscode开发经验.instructions.md` | 浏览器自动化操作（市场上传/GitHub Release）、MCP 配置与排障、文档同步约定 | **现实环境变化后**（市场版本、MCP、Profile 结构、浏览器流程变化等） |

> ℹ️ `vscode配置文件及其配置明细(开发者自用).md`（项目根目录）是开发者个人配置文件清单，**不属于** `.copilot/instructions/` 项目文档，无需 Copilot 自动加载，也不要移入。

**必须遵守**：
- 项目实际结构变更（新增/删除/移动/重命名文件或目录）后，同步更新 `结构.instructions.md` 的文件树和函数表
- 新增有助于理解的文档时，优先放入 `.copilot/instructions/` 而非项目根目录（README 除外，它是 marketplace 发布物）
- 移入的文件必须带 YAML frontmatter（`description`），否则 Copilot 不会自动加载
- 文档位置变化后，检查是否有其他文件引用旧路径并同步更新

## 注意事项

- `@types/vscode` 在 npm 上的发布滞后于 VS Code 本体（2026-07-31 时 VS Code 1.131、类型包 1.125）
- `submenuitem.Profiles` 分支是死代码（VS Code 1.127 起已从源码删除该键），见到可清理
- `mcp.json`（Profile 级 MCP 配置）未被插件纳入继承，是已知功能缺口
- Profile 切换检测在 1.127+ 已不可靠（跟踪移入内部运行时状态），README 已声明，Force Reconcile 兜底

## Profile 扩展备份检查（每次打开本项目必须执行）

**目的**：`vscode配置文件及其配置明细(开发者自用).md`（项目根目录）是用户 Profile 扩展清单的**唯一权威备份**。1.8.4 曾因清空 `extensions.json` 导致分层信息丢失无法脚本恢复，本规则防止再次发生。

**触发时机**：**每次打开本项目**、以及用户提到"Profile / 扩展 / 文档同步"时。

**检查步骤**：

1. 读取文档 2.1（Base）/ 2.2（Dev）的扩展清单，与各 Profile 实际 `extensions.json` 对比：
   - Base → `%APPDATA%\Code\User\profiles\10a9f58d\extensions.json`
   - Base->Dev → `%APPDATA%\Code\User\profiles\-367578e4\extensions.json`
   - Base->Writing → `%APPDATA%\Code\User\profiles\-332dce57\extensions.json`（应为空数组 `[]`，纯继承 Base）
2. 若发现**文档没有的扩展**已出现在 Profile 清单中 → **先询问用户归属**（Base / Dev / 未归类），确认后再更新文档
3. 若发现**文档有的扩展**从 Profile 清单消失 → 提示用户（可能是被禁用/卸载，需确认）
4. 有任何增删改 → **同步更新文档**（扩展表格 + 各 Profile 标题括号内的个数 + 顶部整体架构计数）

**文档更新要点**（与文档 7.1 工作流一致）：
- 新增扩展：在对应 Profile 表格追加一行 `| <扩展ID> | <名称> | <用途> |`
- 删除扩展：移除该行
- 跨 Profile 移动：从源表格删除，在目标表格添加
- 同步更新：一、整体架构个数、各 Profile 标题括号个数、Base->Writing 说明文字个数、Default Profile 计数、三、Mermaid 继承关系图

**示例**（对比脚本，可复用）：
```powershell
# 查看某 Profile 实际启用的扩展
$j = Get-Content "$env:APPDATA\Code\User\profiles\10a9f58d\extensions.json" -Raw | ConvertFrom-Json
$j | ForEach-Object { $_.identifier.id }
# 查看全局已安装（文档 2.6 未归类扩展参考）
Get-ChildItem "$env:USERPROFILE\.vscode\extensions" -Directory | Select-Object Name
```

## 1.8.4 事故经验教训（修改插件代码时必须遵守）

**背景**：1.8.4 因 `isBalancedSettingsFile` 校验误杀 `extensions.json`（数组）导致所有 Profile 扩展被清空，市场紧急回滚发 1.8.5。以下四条是血泪教训，**任何对本插件代码的修改都必须对照检查**：

1. **防御性校验必须作用在"专属路径"，不能塞进共享函数**
   - 反例：`readJSON()` 是通用函数（同时服务 settings.json 对象 `{}` 和 extensions.json 数组 `[]`），1.8.4 却在里面加了"顶层必须是 `{`"的 settings 专属假设 → 数组被误判损坏
   - 正例：settings 专属校验只放在 settings 写入路径（`writeInheritedSettings` / `removeInheritedSettingsFromFile`），通用读取只做 `{`/`[` 都合法的平衡校验

2. **校验失败要"跳过写入 + 告警"，绝不能静默当"空数据"继续对账**
   - 反例：1.8.4 的 `readJSON` 校验失败返回 `{}`，下游 `collectInheritedExtensions` 无法区分"文件真空"和"校验误杀"，静默清空扩展
   - 正例：失败时 `console.warn` 明确告警，并跳过本次写入，绝不把失败当作正常空数据流向下游

3. **新函数必须覆盖所有调用方形态的测试**
   - 反例：`isBalancedSettingsFile` 的测试全是 settings 对象场景，没有覆盖"readJSON 读 extensions.json 数组"这条真实路径 → bug 漏网发布
   - 正例：通用函数的测试必须覆盖对象 + 数组 + 边界（空文件、不平衡、注释/字符串内含 `{}`）

4. **发布前确认 VSIX 打包内容干净**
   - 反例：1.8.5 打包时把临时文件 `vsce-out.txt` 卷进了 VSIX（重定向输出残留）
   - 正例：`vsce package` 前确认工作区无临时文件（`*.out.txt`、`*.bak` 等），打包后可用 `vsce ls` 检查包含的文件列表

**发布流程约束**：
- 修改 `readJSON` / `mergeInheritedExtensions` / `splitRawSettingsByClosingBrace` 等通用函数 → 必须同时跑 `npm run unit-test` 并人工检查数组路径测试
- 任何改动发布前 → 对照上述四条逐条自检
- 若历史版本（如 1.8.4）目录残留在 `~/.vscode/extensions/` → 提醒用户删除，否则 VS Code 可能仍加载旧版出 bug
