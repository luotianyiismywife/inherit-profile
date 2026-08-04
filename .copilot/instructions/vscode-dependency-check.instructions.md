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
