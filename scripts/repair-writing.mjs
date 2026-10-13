/**
 * 手动修复 Writing profile (-332dce57) settings.json 的双顶层闭合损坏。
 *
 * 形态：两个 settings 对象被拼接，第二个对象丢了开头的 `{`，
 * 形成 `{...}\n{残留对象体...}}`（open=34 / close=35，非法 JSON）。
 *
 * 处理：strip 继承块 + 截断到第一个顶层闭合丢弃残留 + 校验 isSettingsDocument。
 * 修复前已备份（settings.json.bak）。
 */
import { createRequire } from "module";
import * as path from "path";
import * as url from "url";
import * as fs from "fs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ps = require(path.join(__dirname, "..", "out", "profileSettings.js"));

// 用系统标准环境变量 APPDATA 推导 VS Code profile 目录（避免硬编码用户名/绝对路径）
const appData =
  process.env.APPDATA ||
  path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
const profilesDir = path.join(appData, "Code", "User", "profiles");
const target =
  process.argv[2] || path.join(profilesDir, "-332dce57", "settings.json");

const raw = fs.readFileSync(target, "utf8");

// 步骤A：strip 继承标记块
const { cleaned: stripped, removedCount } = ps.stripInheritedSettingsBlocks(raw);
console.log(`strip 清理了 ${removedCount} 个块`);

// 步骤B：removeTrailingComma + 确保以 } 结尾（与 removeInheritedSettingsFromFile 一致）
let cleaned = ps.removeTrailingComma(stripped);
if (!cleaned.endsWith("}")) cleaned += "\n}";

// 步骤C：截断到第一个顶层闭合
function truncateAtFirstTopLevelClose(s) {
  let depth = 0, inString = false, stringChar = "", inLine = false, inBlock = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (inLine) { if (c === "\n") inLine = false; continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inString) { if (c === "\\") { i++; continue; } if (c === stringChar) inString = false; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    if (c === '"' || c === "'") { inString = true; stringChar = c; continue; }
    if (c === "{") { depth++; continue; }
    if (c === "}") { depth--; if (depth === 0) return s.slice(0, i + 1); if (depth < 0) return s; }
  }
  return s;
}

if (!ps.isSettingsDocument(cleaned)) {
  const truncated = truncateAtFirstTopLevelClose(cleaned);
  if (truncated !== cleaned) {
    console.log("截断到第一个顶层闭合（丢弃残留对象）");
    cleaned = truncated;
  }
}

const isDoc = ps.isSettingsDocument(cleaned);
console.log(`isSettingsDocument: ${isDoc}`);

if (isDoc) {
  const open = (cleaned.split("").filter((c) => c === "{")).length;
  const close = (cleaned.split("").filter((c) => c === "}")).length;
  console.log(`修复后花括号: open=${open} close=${close}`);
  // 写回
  fs.writeFileSync(target, cleaned + "\n", "utf8");
  console.log("已写回。");
  // 验证写回的文件结构仍合法（settings.json 可能含 // 注释，不能用 JSON.parse）
  const verify = fs.readFileSync(target, "utf8");
  console.log(`写回后 isSettingsDocument: ${ps.isSettingsDocument(verify)}`);
  if (!ps.isSettingsDocument(verify)) {
    console.log("❌ 写回后结构校验失败");
    process.exit(1);
  }
  console.log("写回后结构校验通过 ✅");
} else {
  console.log("❌ 修复失败：结果仍不是合法 settings 对象，未写回。");
  process.exit(1);
}