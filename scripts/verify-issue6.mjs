/**
 * 验证脚本：issue #6 —— 子 Profile 升级继承扩展后会被父级旧版本回退。
 *
 * 现状确认：mergeInheritedExtensions 的 else if(!inheritedMap[id]) 分支
 * 无条件用父级条目覆盖子级，缺失 compareVersions 版本比较（1.8.5 回滚时被连带删除）。
 *
 * 运行：node scripts/verify-issue6.mjs
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
    console.log(`  OK ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? " -> " + detail : ""}`);
  }
}

console.log("=== issue #6 现状确认：子 Profile 升级继承扩展被父级回退 ===\n");

// 场景1：子级已 inherited 且版本高于父级 → 应保留子级版本（不回归）
// 父级 tokenrhythm 1.12.3，子级手动升级到 1.13.0 且仍标 inherited
{
  const child = [
    {
      identifier: { id: "ext.a" },
      version: "1.13.0",
      metadata: { inheritProfile: { inherited: true } },
    },
  ];
  const parent = {
    profileName: "Base",
    extensions: [{ identifier: { id: "ext.a" }, version: "1.12.3" }],
  };
  const r = ps.mergeInheritedExtensions(child, [parent], []);
  const merged = r.merged.find((e) => e.identifier?.id === "ext.a");
  check(
    "子级升级的 inherited 扩展版本保留（1.13.0）",
    merged?.version === "1.13.0",
    `实际版本 ${merged?.version}`,
  );
}

// 场景2：父级版本更高 → 应同步父级版本（正常继承）
{
  const child = [
    {
      identifier: { id: "ext.b" },
      version: "1.0.0",
      metadata: { inheritProfile: { inherited: true } },
    },
  ];
  const parent = {
    profileName: "Base",
    extensions: [{ identifier: { id: "ext.b" }, version: "2.0.0" }],
  };
  const r = ps.mergeInheritedExtensions(child, [parent], []);
  const merged = r.merged.find((e) => e.identifier?.id === "ext.b");
  check(
    "父级版本更高时同步父级（2.0.0）",
    merged?.version === "2.0.0",
    `实际版本 ${merged?.version}`,
  );
}

// 场景3：同版本 → 保留子级（不覆盖，避免无谓回退）
{
  const child = [
    {
      identifier: { id: "ext.c" },
      version: "1.5.0",
      metadata: { inheritProfile: { inherited: true } },
    },
  ];
  const parent = {
    profileName: "Base",
    extensions: [{ identifier: { id: "ext.c" }, version: "1.5.0" }],
  };
  const r = ps.mergeInheritedExtensions(child, [parent], []);
  const merged = r.merged.find((e) => e.identifier?.id === "ext.c");
  check(
    "同版本保留子级（1.5.0）",
    merged?.version === "1.5.0",
    `实际版本 ${merged?.version}`,
  );
}

// 场景4：own 扩展被父级接管 → 保留子级 own 版本（own 优先）
{
  const child = [{ identifier: { id: "ext.d" }, version: "3.0.0" }]; // own（无 inherited 标记）
  const parent = {
    profileName: "Base",
    extensions: [{ identifier: { id: "ext.d" }, version: "1.0.0" }],
  };
  const r = ps.mergeInheritedExtensions(child, [parent], []);
  const merged = r.merged.find((e) => e.identifier?.id === "ext.d");
  check(
    "own 扩展被接管时保留子级版本（3.0.0）",
    merged?.version === "3.0.0",
    `实际版本 ${merged?.version}`,
  );
}

console.log("\n=== 结果：" + pass + " 通过，" + fail + " 失败 ===");
if (fail > 0) {
  console.log("FAIL issue #6 仍存在（子级升级被回退）");
  process.exit(1);
}
console.log("OK issue #6 修复验证通过（子级升级不再被回退）");