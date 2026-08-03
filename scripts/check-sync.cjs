const fs = require("fs");
const path = require("path");

const PROFILES_DIR = "c:/Users/HJM/AppData/Roaming/Code/User/profiles";
const mapping = {
  "10a9f58d": "Base",
  "-367578e4": "Base->Dev",
  "-332dce57": "Base->Writing",
};

const exts = {};
for (const [dir, name] of Object.entries(mapping)) {
  const p = path.join(PROFILES_DIR, dir, "extensions.json");
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    exts[name] = raw.map((e) => e.identifier?.id).filter(Boolean);
    console.log(`${name}: ${exts[name].length} entries, parse OK`);
  } catch (err) {
    console.log(`${name}: PARSE FAILED - ${err.message}`);
    exts[name] = [];
  }
}

const base = exts["Base"] || [];
for (const child of ["Base->Dev", "Base->Writing"]) {
  console.log(`\n=== ${child} 有但 Base 没有 (own/optedOut) ===`);
  for (const id of exts[child]) {
    if (!base.includes(id)) console.log("  " + id);
  }
  console.log(`=== Base 有但 ${child} 没有 (缺失) ===`);
  for (const id of base) {
    if (!exts[child].includes(id)) console.log("  " + id);
  }
}

console.log("\n=== 子 profile 中 metadata.inheritProfile 标记统计 ===");
for (const [dir, name] of Object.entries(mapping)) {
  const p = path.join(PROFILES_DIR, dir, "extensions.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const inherited = raw.filter((e) => e.metadata?.inheritProfile?.inherited).length;
  const optedOut = raw.filter((e) => e.metadata?.inheritProfile?.optedOut).length;
  const disabled = raw.filter((e) => e.disabled).length;
  console.log(`${name}: inherited=${inherited} optedOut=${optedOut} disabled=${disabled}`);
}
