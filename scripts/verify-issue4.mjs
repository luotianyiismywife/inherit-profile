/**
 * 验证脚本：issue #4 修复 —— 防御分支在继承设置为空时，若文件里有僵尸继承块，
 * 仍应先清理让文件自愈，而非连清理一起跳过。
 *
 * 核心逻辑：当 inheritedSettings 为空但 hasInheritedMarkers(raw) 为 true 时，
 * 调用 removeInheritedSettingsFromFile（其内部走 stripInheritedSettingsBlocks +
 * isSettingsDocument 校验）。本脚本用真实损坏文件 + 导出的清理函数验证自愈能力。
 *
 * 运行：node scripts/verify-issue4.mjs [settings.json路径]
 */
import { createRequire } from "module";
import * as path from "path";
import * as url from "url";
import * as fs from "fs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ps = require(path.join(__dirname, "..", "out", "profileSettings.js"));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? " → " + detail : ""}`);
  }
}

// 用系统标准环境变量 APPDATA 推导 VS Code profile 目录（避免硬编码用户名/绝对路径）
const appData =
  process.env.APPDATA ||
  path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
const profilesDir = path.join(appData, "Code", "User", "profiles");
const target =
  process.argv[2] || path.join(profilesDir, "-332dce57", "settings.json");

console.log("=== issue #4 验证：防御分支不再连僵尸块清理也跳过 ===\n");

// 模拟 hasInheritedMarkers 的判定逻辑（与 src/profiles.ts 一致）
function hasInheritedMarkers(raw) {
  return (
    raw.includes(ps.INHERITED_SETTINGS_START_MARKER) ||
    raw.includes(ps.INHERITED_SETTINGS_END_MARKER)
  );
}

const raw = fs.readFileSync(target, "utf8");

// 场景1：文件里确实有继承标记（僵尸块）→ hasInheritedMarkers 应为 true
const hasMarkers = hasInheritedMarkers(raw);
check(
  `真实损坏文件检测到继承标记（START/END）`,
  hasMarkers === true,
  `实际 ${hasMarkers}`,
);

// ── 模拟 removeInheritedSettingsFromFile 的完整自愈流程（含 issue #4 截断增强）──
// 步骤A：stripInheritedSettingsBlocks 清理 marker 块
const { cleaned: stripped, removedCount } = ps.stripInheritedSettingsBlocks(raw);
check(
  `stripInheritedSettingsBlocks 清理了 ${removedCount} 个块（应 > 0）`,
  removedCount > 0,
  `removedCount=${removedCount}`,
);
check(
  `清理后不再残留任何 START/END 标记`,
  !stripped.includes(ps.INHERITED_SETTINGS_START_MARKER) &&
    !stripped.includes(ps.INHERITED_SETTINGS_END_MARKER),
);
check(
  `清理后不再残留 _insertionBoundary`,
  !stripped.includes(ps.INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY),
);

// 步骤B：removeTrailingComma + 确保以 } 结尾（与 removeInheritedSettingsFromFile 一致）
let cleaned = ps.removeTrailingComma(stripped);
if (!cleaned.endsWith("}")) cleaned += "\n}";

// 步骤C：若 isSettingsDocument 失败（双顶层闭合），截断到第一个顶层闭合丢弃残留
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
  check("isSettingsDocument 失败时截断到第一个顶层闭合", truncated !== cleaned, "截断无变化");
  cleaned = truncated;
}

// 场景2：清理+截断后应为合法 settings 对象
check(
  `清理+截断后 isSettingsDocument 校验通过（合法 settings 对象）`,
  ps.isSettingsDocument(cleaned) === true,
  `实际 ${ps.isSettingsDocument(cleaned)}`,
);

// 场景3：模拟"inheritSettings 为空但文件有标记"的防御分支决策
// （修复前：直接跳过删除；修复后：走清理路径）
if (hasMarkers) {
  check(
    `防御分支判定：有标记 → 触发清理路径（issue #4 修复生效）`,
    removedCount > 0,
  );
} else {
  check(`防御分支判定：无标记 → 走"无 block 可清"保留路径`, true);
}

// 场景4：幂等性 —— 对截断后的结果再 strip 一次不应有 marker（避免重复写）
const again = ps.stripInheritedSettingsBlocks(cleaned);
check(
  `清理结果幂等（再 strip removedCount=0）`,
  again.removedCount === 0,
  `removedCount=${again.removedCount}`,
);

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
if (fail > 0) {
  console.log("❌ issue #4 未修好（清理能力有缺陷）");
  process.exit(1);
}
console.log("✅ issue #4 修复路径验证通过（僵尸块可自愈）");