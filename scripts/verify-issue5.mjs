/**
 * 验证脚本：issue #5 是否修复 —— 根 Profile 无父级时，绝不因 inherited 标记清空扩展。
 *
 * 直接调用编译产物 out/profileSettings.js 的 mergeInheritedExtensions()。
 * 修复提交 f524d6d 加了 noParents 分支：parentProfiles 为空时，
 * 所有 inherited 扩展一律退还为 own 保留（而非丢弃）。
 *
 * 运行：node scripts/verify-issue5.mjs
 */
import { createRequire } from "module";
import * as path from "path";
import * as url from "url";

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

console.log("=== issue #5 验证：根 Profile 无父级时保留 inherited 扩展 ===\n");

// 场景1：inherited 扩展不在 originallyOwn，父级为空 → 应退还为 own，不丢弃
// （issue #5 核心：VS Code 降级打乱元数据后，根 Profile 的 inherited 扩展不被清空）
{
  const input = [
    { identifier: { id: "a" } },
    { identifier: { id: "b" }, metadata: { inheritProfile: { inherited: true } } },
  ];
  const r = ps.mergeInheritedExtensions(input, [], ["a"]);
  check(
    "inherited 扩展 b 被保留（共2条）",
    r.merged.length === 2,
    `实际 ${r.merged.length}`,
  );
  const b = r.merged.find((e) => e.identifier?.id === "b");
  check(
    "b 退还为 own（移除 inherited 标记）",
    !!b && !b.metadata?.inheritProfile,
    JSON.stringify(b?.metadata),
  );
  const a = r.merged.find((e) => e.identifier?.id === "a");
  check("a 保持 own", !!a && !a.metadata?.inheritProfile, JSON.stringify(a?.metadata));
}

// 场景2：纯 inherited 扩展（不在 originallyOwn，父级为空）→ 也应保留为 own，而非丢弃
{
  const input = [
    { identifier: { id: "x" }, metadata: { inheritProfile: { inherited: true } } },
  ];
  const r = ps.mergeInheritedExtensions(input, [], []);
  check(
    "无 originallyOwn 的 inherited 扩展 x 也被保留",
    r.merged.length === 1,
    `实际 ${r.merged.length}`,
  );
  const x = r.merged[0];
  check("x 标记已移除（退回 own）", !!x && !x.metadata?.inheritProfile, JSON.stringify(x?.metadata));
}

// 场景3：originallyOwn 里指向已被退还为 own 的 id，悬空引用被清理
{
  const input = [
    { identifier: { id: "own1" } },
    { identifier: { id: "gone" }, metadata: { inheritProfile: { inherited: true } } },
  ];
  const r = ps.mergeInheritedExtensions(input, [], ["own1", "gone"]);
  check(
    "originallyOwn 里 'gone' 的悬空引用被清理（不再返回）",
    !r.originallyOwnExtensions.includes("gone"),
    `实际 ${JSON.stringify(r.originallyOwnExtensions)}`,
  );
}

// 场景4：父级存在时，父级提供的扩展仍标记为 inherited（回归保护）
{
  const parent = { profileName: "Base", extensions: [{ identifier: { id: "y" } }] };
  const r = ps.mergeInheritedExtensions([], [parent], []);
  check(
    "有父级时，父级扩展 y 被标记为 inherited",
    r.merged.length === 1 && r.merged[0].metadata?.inheritProfile?.inherited === true,
    `实际 ${JSON.stringify(r.merged[0]?.metadata?.inheritProfile)}`,
  );
}

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
if (fail > 0) {
  console.log("❌ issue #5 未修好");
  process.exit(1);
}
console.log("✅ issue #5 已修复（全部断言通过）");