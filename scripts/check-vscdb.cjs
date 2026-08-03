// 读取 state.vscdb 中指定 profile 的设置存储
const initSqlJs = require("c:/Users/HJM/Documents/inherit-profile/node_modules/sql.js/dist/sql-wasm.js");
const fs = require("fs");

async function main() {
  const SQL = await initSqlJs();
  const targets = [
    "c:/Users/HJM/AppData/Roaming/Code/User/profiles/-367578e4/globalStorage/state.vscdb",
    "c:/Users/HJM/AppData/Roaming/Code/User/profiles/-332dce57/globalStorage/state.vscdb",
    "c:/Users/HJM/AppData/Roaming/Code/User/profiles/10a9f58d/globalStorage/state.vscdb",
    "c:/Users/HJM/AppData/Roaming/Code/User/globalStorage/state.vscdb",
  ];
  for (const p of targets) {
    console.log(`\n===== ${p} =====`);
    if (!fs.existsSync(p)) {
      console.log("  (不存在)");
      continue;
    }
    try {
      const db = new SQL.Database(fs.readFileSync(p));
      const stmt = db.prepare(
        "SELECT key, length(value) as len FROM ItemTable ORDER BY key"
      );
      let count = 0;
      while (stmt.step()) {
        const row = stmt.getAsObject();
        // 只打印与设置/扩展相关的 key
        if (
          row.key.includes("settings") ||
          row.key.includes("extension") ||
          row.key.includes("profile") ||
          row.key.includes("inherit")
        ) {
          console.log(`  ${row.key} (${row.len} bytes)`);
          count++;
        }
      }
      if (count === 0) console.log("  (无匹配 key)");
      stmt.free();
      db.close();
    } catch (err) {
      console.log(`  读取失败: ${err.message}`);
    }
  }
}

main().catch((e) => console.error(e));
