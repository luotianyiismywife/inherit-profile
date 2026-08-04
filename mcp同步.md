# MCP 同步 — MCP 服务器配置的存储与云同步

> **结论先行**：VS Code 的 **Settings Sync（登录账号同步）原生支持 MCP 服务器配置同步**，`mcp.json` 是官方的一等同步资源。MCP 继承（inherit-profile 插件）与云同步是**两件独立的事**，可以各自工作。

---

## 一、MCP 服务器配置存储在哪

| 级别 | 路径 | 说明 |
|------|------|------|
| 用户/Profile 级 | `<用户目录>/profiles/<id>/mcp.json` | **主要位置**。VS Code 1.95+ 起 MCP 服务器按 Profile 存储（`mcpResource: joinPath(location, 'mcp.json')`） |
| 工作区级 | `<项目>/.vscode/mcp.json` | 仅当前工作区生效，随仓库同步 |
| 项目级（Claude 风格） | `<项目>/.mcp.json` | 工作区根目录的 `{ "mcpServers": {...} }` 格式，VS Code 1.1xx 起也支持发现 |
| 历史位置（已废弃） | 用户 `settings.json` 的 `mcp.servers` | 旧版存这里，新版已迁移到独立 `mcp.json` |

### mcp.json 文件格式

```jsonc
{
  // VS Code 官方格式（1.95+）
  "servers": {
    "my-server": {
      "type": "stdio",        // stdio | sse | http
      "command": "npx",
      "args": ["-y", "@some/mcp-server"],
      "env": { "KEY": "value" },
      "cwd": "..."            // 可选
    }
  }
}
```

> ⚠️ **注意格式差异**：VS Code 的 `mcp.json` 用 `"servers"` 顶层键；Claude 风格 `.mcp.json` / 插件清单用 `"mcpServers"`。VS Code 两种都能读（`WorkspaceDotMcpDiscovery` 支持 `mcpServers`，profile 级用 `servers`）。

### 本机现状（2026-08-04 实测）

- 各 profile 目录下**均无 `mcp.json`**（Base/Dev/Writing 都没有）
- 用户级 `mcp.json` 不存在
- `sync/mcp/lastSyncmcp.json` 存在但内容为空（`"syncData": null`）→ 从未同步过 MCP 数据
- firefox-nightly 的 MCP 配置属于**某个项目的工作区级独占配置**，不在本机 VS Code 用户数据中

---

## 二、云同步机制（Settings Sync）

### 2.1 MCP 是官方同步资源

VS Code 源码确认：
- `McpSynchroniser`（`src/vs/platform/userDataSync/common/mcpSync.ts`）— 继承 `AbstractJsonSynchronizer`，同步资源类型 `SyncResource.Mcp`
- 同步的**就是 `<profile>/mcp.json` 文件**，与 settings/keybindings/extensions 并列为一等同步项
- 同步开关：设置 `mcp.sync`（或 Settings Sync 面板勾选 "MCP Servers"）

### 2.2 同步了什么 / 没同步什么

| 内容 | 是否同步 | 说明 |
|------|:---:|------|
| MCP 服务器定义（command/args/env/url） | ✅ | mcp.json 整个文件 |
| 服务器所需的**本地依赖**（npx 包、python 环境等） | ❌ | 只同步 JSON 配置，不装二进制 |
| `env` 里的密钥 | ⚠️ | **跟着 mcp.json 一起同步**，注意泄露风险 |
| 服务器启停状态（state.vscdb 中的 enablement） | ⚠️ | 部分同步（MCP enablement 存在 profile 级 state） |
| OAuth client secret | ❌ | 存于密钥库（`mcp.oauth.clientSecret:*`），不落明文配置文件 |

### 2.3 跨设备注意事项

1. **npx 式服务器最省心**：`npx -y @xxx/mcp-server` 同步后在新机器自动拉取，前提是新机器有 Node.js
2. **本地路径式服务器要小心**：`command: "python"` 或绝对路径的二进制，新机器可能不存在 → 启动失败
3. **密钥会漫游**：`env` 里的 API key 同步到所有设备，建议用 VS Code 密钥存储（OAuth/secret 机制）替代明文 env
4. **Profile 结构前提**：Settings Sync 同步 `mcp.json` 是按 Profile 的，目标设备需要有同名 Profile 才能落位（与 inherit-profile 的跨设备限制一致）

---

## 三、MCP 继承（inherit-profile 插件）≠ 云同步

| | MCP 继承（待实现功能） | MCP 云同步（VS Code 原生） |
|---|---|---|
| 方向 | 父 Profile → 子 Profile（同机） | 本机 → 云端 → 其他机器（同 Profile） |
| 解决什么问题 | Base 配了 MCP，Dev/Writing 自动继承 | 换机器后配置不丢失 |
| 冲突 | 继承写入 mcp.json 后，云同步会把它也带走上云 | 云同步的 MCP 也可能被继承逻辑再次处理 |
| 关系 | 两件事独立，可共存 | 两件事独立，可共存 |

### 若实现 MCP 继承，与云同步的交互要点

- 继承逻辑写入子 profile 的 `mcp.json` 后，**VS Code 云同步会照常把继承结果同步走**（无法区分"用户手动配的"和"插件继承来的"）→ 云同步看到的就是合并后的完整文件
- 继承台账（`_mcpOwn` / `_mcpOptedOut`，若实现）建议加入 `setKeysForSync`，与 `extensionMarkers`/`parentSnapshots` 一样跨设备备份
- 若同一 MCP 服务器在不同机器配置不同（如 `command` 路径不同），云同步 + 继承叠加可能产生覆盖，属于已知边界

---

## 四、排查命令速查

```powershell
# 查看各 profile 下是否有 mcp.json
Get-ChildItem "$env:APPDATA\Code\User\profiles" -Recurse -Filter "mcp.json"

# 查看 MCP 云同步本地缓存
Get-Content "$env:APPDATA\Code\User\sync\mcp\lastSyncmcp.json"

# 查看 MCP 网关日志（确认服务器加载情况）
Get-Content "$env:APPDATA\Code\logs\<最新时间戳>\mcpGateway.log"

# 查看 MCP 服务器定义的 API（VS Code 内置，需在扩展里调用）
# vscode.lm.mcpServerDefinitions（proposed API）
```

---

## 五、相关文档

- `vscode开发经验.instructions.md`（`.copilot/instructions/`）— 二、VS Code MCP（配置格式 + 排障）
- `Dependencies of the plugin.instructions.md`（`.copilot/instructions/`）— 一.5 mcp.json（🔴 高脆弱度，功能缺口）
