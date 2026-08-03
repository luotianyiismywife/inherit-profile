// 读取扩展 globalState 备份，查看历史 extensionMarkers
const initSqlJs = require("c:/Users/HJM/Documents/inherit-profile/node_modules/sql.js/dist/sql-wasm.js");
const fs = require("fs");

async function main() {
  const SQL = await initSqlJs();
  const targets = [
    "c:/Users/HJM/AppData/Roaming/Code/User/profiles/-367578e4/globalStorage/state.vscdb",
    "c:/Users/HJM/AppData/Roaming/Code/User/profiles/-332dce57/globalStorage/state.vscdb",
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
        "SELECT key, value FROM ItemTable WHERE key = ?"
      );
      stmt.bind(["luotianyiismywife.inherit-profile-plus"]);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        try {
          const parsed = JSON.parse(row.value);
          console.log(JSON.stringify(parsed, null, 2).slice(0, 3000));
        } catch {
          console.log(row.value.slice(0, 3000));
        }
      } else {
        console.log("  (无此 key)");
      }
      stmt.free();
      db.close();
    } catch (err) {
      console.log(`  读取失败: ${err.message}`);
    }
  }
}

main().catch((e) => console.error(e));
