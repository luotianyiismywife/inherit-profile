---
description: "Use when: 需要操作浏览器（市场上传/审核、GitHub Release 创建等网页操作）、配置或排查 VS Code MCP（Model Context Protocol）、查看开发环境约定（VS Code 版本/Profile 架构/常用命令），以及文档需随现实变化同步更新时参考"
---

# VS Code 开发经验 · 通用手册

> **用途**：记录 VS Code 开发环境的通用经验，包括**浏览器自动化操作**（市场上传、GitHub Release 等）、**MCP 配置与排障**、以及**文档同步更新约定**。本项目可能同时在多台机器上开发，本文档内容应保持**机器无关**，不要写入具体机器相关的路径/版本。
> **更新原则**：现实环境变化（VS Code 升级、市场审核流程变化、MCP 服务器新增/删除、Profile 结构变化等）后，必须同步修改本文档。

> **📌 项目身份（2026-10-14 起）**：本仓库**不再是 fork**，已从 `luotianyiismywife/inherit-profile` 改名为 **`luotianyiismywife/inherit-profile-plus`**（与扩展 ID 一致），是**主仓库**。上游 `alexjthomson/inherit-profile` 已长期停更，本地 `upstream` remote 已移除。所有仓库 URL（package.json / README / 源码注释 / 文档）统一指向新仓库名。

---

## 一、浏览器自动化操作经验（Copilot 内置浏览器工具）

> Copilot 在 VS Code 中有内置浏览器（`open_browser_page` / `click_element` / `type_in_page` / `run_playwright_code` 等工具），可用于登录第三方网站、上传扩展、创建 Release 等操作。

### 1.1 通用操作要点

| 要点 | 说明 |
|------|------|
| **登录页需用户手动** | 涉及账号密码（GitHub / Microsoft）的登录**必须由用户亲自完成**，Copilot 不能代输密码（安全红线）。Copilot 打开页面后，提示用户登录，登录完再继续 |
| **登录态不跨页面共享** | 每次 `open_browser_page` 新开的浏览器页**不保留**之前的登录 cookie。切换页面（如市场→GitHub）需要重新登录 |
| **元素点击超时** | 微软/谷歌系页面（marketplace、reCAPTCHA）的按钮常因动画/iframe 导致 `click_element` 超时。**解决方案**：用 `run_playwright_code` + `page.evaluate(() => btn.click())` 强制触发 JS 点击 |
| **iframe 内元素** | reCAPTCHA 验证框、部分对话框在 iframe 内，快照里可见但需用户手动交互（如"选择包含小轿车的图片"） |
| **文件上传** | 用 `page.setInputFiles('<input选择器>', '绝对路径')` 直接设文件。**隐藏的 `input[type=file]` 也能注入**（Playwright 可操作 hidden input）——市场用 `#file-upload`，GitHub Release 用 `#releases-upload`。注入后按钮从 disabled 变 enabled |
| **上传后状态** | 市场上传后显示 `Verifying <版本>`，需等待审核（通常数小时）；reCAPTCHA 验证通过后上传自动继续 |

### 1.2 VS Code 市场（Marketplace）上传流程

> ⚠️ **升级已有扩展 ≠ 发新扩展**！升级走**扩展行的 More Actions → Update**；顶部菜单的 **More commands → New extension → Visual Studio Code** 是**发布全新扩展**，对已存在的扩展用它会报错/走错流程。

1. 打开 `https://marketplace.visualstudio.com/manage/publishers/<publisherId>` → 用户登录 Microsoft 账号
2. **悬停目标扩展所在行**（More Actions 按钮默认隐藏，悬停才出现）→ 点行内 **More Actions...** → 菜单选 **Update**
3. 上传对话框出现：`page.setInputFiles('#file-upload', 'xxx.vsix')`（`#file-upload` 是 hidden input，可直接注入）
4. 点击 **Upload** → 列表行变为 `<旧版本> Verifying <新版本> ... just now`
5. 等待验证通过转 Public（通常几分钟到数小时）

> **实测（2026-10-14 v1.9.4）**：Update 流程中 reCAPTCHA 显示"已超出免费配额"但**不阻塞上传**（Update 可能不强制验证码）；`setInputFiles` 注入 hidden input 成功，Upload 按钮随即启用。

> ⚠️ **关键教训**：vsix 打包必须**包含 dependencies**！用 `npx vsce package`（**不要加 `--no-dependencies`**），否则插件装不上 node_modules，用户激活直接崩溃（报"命令未找到"）。打包后务必 `npx vsce ls` 确认 `node_modules/` 在包内。

> ⚠️ **打包前必查 `.vscodeignore`**：新增了项目根目录的文件/目录后，**先确认 `.vscodeignore` 是否要同步更新**再打包！1.8.6 曾把 `backup-profiles-*/`（用户 profile 完整备份，含 settings.json / extensions.json / state.vscdb）打包进 VSIX，属于**严重隐私泄露**。检查清单：
> - 项目根目录是否有**非发布物**（备份目录、临时脚本、`*.bak`、`*-out.txt`、`*.vsix`）→ 必须加进 `.vscodeignore`
> - 打包前跑 `npx vsce ls` 检查文件列表，**确认没有** `backup-*`、`*.bak*`、`state.vscdb`、`settings.json`、`*.md`（除 README）等敏感/多余文件
> - 本地测试用的 VSIX 打完包**删掉或移出项目目录**（避免下次再被打包）

### 1.3 GitHub Release 创建流程

1. 打开 `https://github.com/<owner>/<repo>/releases/new?tag=vX.Y.Z` → 用户登录 GitHub（tag 已存在时显示 "Existing tag"）
2. 填好标题 / 描述（URL 参数可预填 tag）
3. 二进制附件上传（vsix 等）：
   ```js
   await page.setInputFiles('#releases-upload', '绝对路径\\xxx.vsix');
   ```
   > **实测（2026-10-14 v1.9.4）**：`#releases-upload` 是**可见**的 file input，`setInputFiles` 直接注入即可，无需 `waitForEvent('filechooser')`。注入后附件区显示文件名 + 大小。
   > ⚠️ **注意**：vsix 不能拖进正文编辑器（GitHub 不支持该类型作为正文附件），必须走**二进制附件区**。
4. 点击 **Publish release** → URL 变 `releases/tag/vX.Y.Z`，Assets 区含 vsix + Source code zip/tar.gz

### 1.4 常见问题排查

| 问题 | 原因 | 解决 |
|------|------|------|
| 点击无反应/超时 | 微软系页面按钮事件绑定在 React 上 | `page.evaluate(() => 元素.click())` |
| 找不到元素 | 快照 ref 过期（页面已变） | 重新 `read_page` 获取新 ref |
| More Actions 按钮看不到 | 默认隐藏，需悬停行才出现 | 先 `hover_element` 目标行，再点行内 More Actions |
| reCAPTCHA 卡住 | 反机器人验证必须真人操作 | 提示用户在 iframe 中完成图片验证；Update 流程可能不强制 |
| 上传失败 | vsix 缺依赖 / 版本号冲突 | 检查 `vsce ls`；市场不能重复上传同版本 |
| 走错入口 | 用 New extension 发已存在的扩展 | 升级必须走 **More Actions → Update** |

---

## 二、VS Code MCP（Model Context Protocol）

> MCP 让 VS Code / Copilot 通过标准协议接入外部工具服务器（GitHub、数据库、文件系统等）。

### 2.1 MCP 配置文件位置

| 级别 | 位置 | 说明 |
|------|------|------|
| 用户级 | `%APPDATA%\Code\User\mcp.json` | 全用户生效（一般各机器独立配置） |
| 工作区级 | `<项目>/.vscode/mcp.json` | 仅当前工作区生效（随仓库同步，多机器一致） |
| 设置项 | `chat.mcp.gallery.enabled` | VS Code 设置中的 MCP 市场开关（按需开启） |

### 2.2 MCP 配置格式（参考）

```jsonc
// .vscode/mcp.json 或 用户 mcp.json
{
  "servers": {
    "my-server": {
      "type": "stdio",                 // stdio | sse | http
      "command": "npx",                // 启动命令
      "args": ["-y", "@some/mcp-server"],
      "env": { "KEY": "value" }        // 可选环境变量
    }
  }
}
```

### 2.3 排障要点

1. **配置了但 Copilot 不识别**：检查文件是否在正确位置（`.vscode/mcp.json`），VS Code 可能需要重载窗口（`Developer: Reload Window`）
2. **stdio 服务器启动失败**：在终端手动运行 `command args` 看报错；确认 `npx` / `node` 在 PATH 中
3. **环境变量不生效**：`env` 里不要放敏感信息（API key 等）到共享文件；确认变量名大小写
4. **MCP 工具未出现在工具列表**：确认 VS Code 版本支持（1.100+ 完善支持），检查输出面板的 MCP 日志
5. **本项目（inherit-profile-plus）**：默认未配置任何 MCP 服务器；若某台机器新增，需在**本节登记**并同步更新依赖清单（`.copilot/instructions/Dependencies of the plugin.instructions.md`），多机器间保持一致

---

## 三、文档同步更新约定（重要）

> **现实环境变化后，必须同步修改本文档及相关指令文件**，保持文档与真实环境一致。

### 触发时机

- VS Code 大版本升级（如 1.131 → 1.132）
- 市场上传/审核结果变化（新版本通过/被拒）
- MCP 服务器新增/删除/迁移
- Profile 结构变化（新增/删除 profile、扩展增减）
- 依赖升级（`@types/vscode`、`sql.js` 等）
- 浏览器自动化流程变化（marketplace 改版等）

### 需要同步更新的文件

| 文件 | 更新内容 |
|------|---------|
| 本文档（`vscode开发经验.instructions.md`） | 浏览器流程、MCP、文档同步约定、本表 |
| `Dependencies of the plugin.instructions.md` | 依赖清单、检查记录表追加 |
| `结构.instructions.md` | 源码结构变更后同步 |
| `vscode-dependency-check.instructions.md` | 检查流程变化时 |

### 流程

1. 现实变化发生 → 立即记录到本文档对应小节
2. 涉及源码/依赖 → 同步更新其他指令文件
3. Profile 变化 → 更新 `vscode配置文件及其配置明细(开发者自用).md`（项目根目录，若存在）
4. 更新后告知用户"文档已同步"
