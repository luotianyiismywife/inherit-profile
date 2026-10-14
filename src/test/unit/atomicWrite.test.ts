import * as assert from "assert";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  DEFAULT_MAX_ATTEMPTS,
  writeFileAtomic,
} from "../../atomicWrite";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inherit-profile-atomic-"));
}

/** 列出目录下所有以 .tmp 结尾的残留临时文件。 */
function listTempFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

/** 构造一个带 errno code 的错误。 */
function errnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

suite("writeFileAtomic", () => {
  test("writes content and leaves no temp file behind", async () => {
    const dir = makeTempDir();
    try {
      const target = path.join(dir, "settings.json");
      await writeFileAtomic(target, "{\n    \"a\": 1\n}\n");

      assert.strictEqual(
        fs.readFileSync(target, "utf8"),
        "{\n    \"a\": 1\n}\n",
      );
      assert.deepStrictEqual(listTempFiles(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("overwrites existing content atomically", async () => {
    const dir = makeTempDir();
    try {
      const target = path.join(dir, "settings.json");
      fs.writeFileSync(target, "old", "utf8");

      await writeFileAtomic(target, "new");

      assert.strictEqual(fs.readFileSync(target, "utf8"), "new");
      assert.deepStrictEqual(listTempFiles(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("temp file lives in the same directory as the target", async () => {
    const dir = makeTempDir();
    try {
      const target = path.join(dir, "settings.json");
      const seen: string[] = [];

      await writeFileAtomic(target, "content", {
        deps: {
          writeFile: async (p, content) => {
            seen.push(p);
            await fsp.writeFile(p, content, "utf8");
          },
        },
      });

      assert.strictEqual(seen.length, 1);
      assert.strictEqual(path.dirname(seen[0]), dir);
      assert.ok(
        path.basename(seen[0]).startsWith("settings.json."),
        `temp name should derive from target: ${seen[0]}`,
      );
      assert.ok(seen[0].endsWith(".tmp"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses a unique temp name per call (no collision)", async () => {
    const dir = makeTempDir();
    try {
      const target = path.join(dir, "settings.json");
      const seen: string[] = [];

      await writeFileAtomic(target, "a", {
        deps: {
          writeFile: async (p, content) => {
            seen.push(p);
            await fsp.writeFile(p, content, "utf8");
          },
        },
      });
      await writeFileAtomic(target, "b", {
        deps: {
          writeFile: async (p, content) => {
            seen.push(p);
            await fsp.writeFile(p, content, "utf8");
          },
        },
      });

      assert.strictEqual(seen.length, 2);
      assert.notStrictEqual(seen[0], seen[1]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retries rename on EPERM and eventually succeeds", async () => {
    const dir = makeTempDir();
    try {
      const target = path.join(dir, "settings.json");
      let attempts = 0;
      let sleeps = 0;

      await writeFileAtomic(target, "content", {
        maxAttempts: 5,
        retryDelayMs: 1,
        deps: {
          rename: async (from, to) => {
            attempts++;
            if (attempts < 3) {
              throw errnoError("EPERM");
            }
            await fsp.rename(from, to);
          },
          sleep: async () => {
            sleeps++;
          },
        },
      });

      assert.strictEqual(attempts, 3, "should retry until success");
      assert.strictEqual(sleeps, 2, "should sleep between retries");
      assert.strictEqual(fs.readFileSync(target, "utf8"), "content");
      assert.deepStrictEqual(listTempFiles(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retries on EBUSY and EACCES too", async () => {
    const dir = makeTempDir();
    try {
      const target = path.join(dir, "settings.json");
      const codes = ["EBUSY", "EACCES"];
      let attempts = 0;

      await writeFileAtomic(target, "content", {
        maxAttempts: 5,
        retryDelayMs: 1,
        deps: {
          rename: async (from, to) => {
            const code = codes[attempts];
            attempts++;
            if (code) {
              throw errnoError(code);
            }
            await fsp.rename(from, to);
          },
          sleep: async () => {},
        },
      });

      assert.strictEqual(attempts, 3);
      assert.strictEqual(fs.readFileSync(target, "utf8"), "content");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gives up after maxAttempts, leaves target unchanged, cleans temp", async () => {
    const dir = makeTempDir();
    try {
      const target = path.join(dir, "settings.json");
      fs.writeFileSync(target, "original", "utf8");
      let attempts = 0;

      await assert.rejects(
        writeFileAtomic(target, "new", {
          maxAttempts: 3,
          retryDelayMs: 1,
          deps: {
            rename: async () => {
              attempts++;
              throw errnoError("EPERM");
            },
            sleep: async () => {},
          },
        }),
        /simulated EPERM/,
      );

      assert.strictEqual(attempts, 3, "should try exactly maxAttempts times");
      assert.strictEqual(
        fs.readFileSync(target, "utf8"),
        "original",
        "target must keep its previous content",
      );
      assert.deepStrictEqual(listTempFiles(dir), [], "temp must be cleaned");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not retry on non-retryable rename errors (ENOENT)", async () => {
    const dir = makeTempDir();
    try {
      const target = path.join(dir, "settings.json");
      let attempts = 0;
      let sleeps = 0;

      await assert.rejects(
        writeFileAtomic(target, "content", {
          maxAttempts: 5,
          retryDelayMs: 1,
          deps: {
            rename: async () => {
              attempts++;
              throw errnoError("ENOENT");
            },
            sleep: async () => {
              sleeps++;
            },
          },
        }),
        /simulated ENOENT/,
      );

      assert.strictEqual(attempts, 1, "non-retryable error should not retry");
      assert.strictEqual(sleeps, 0, "should not sleep on non-retryable error");
      assert.deepStrictEqual(listTempFiles(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cleans up temp file when writing the temp file itself fails", async () => {
    const dir = makeTempDir();
    try {
      const target = path.join(dir, "settings.json");
      fs.writeFileSync(target, "original", "utf8");

      await assert.rejects(
        writeFileAtomic(target, "content", {
          deps: {
            writeFile: async (p) => {
              // 先落一个半成品，再抛错，模拟写临时文件失败
              await fsp.writeFile(p, "partial", "utf8");
              throw errnoError("ENOSPC");
            },
          },
        }),
        /simulated ENOSPC/,
      );

      assert.strictEqual(fs.readFileSync(target, "utf8"), "original");
      assert.deepStrictEqual(listTempFiles(dir), [], "temp must be cleaned");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("default maxAttempts is used when not specified", async () => {
    const dir = makeTempDir();
    try {
      const target = path.join(dir, "settings.json");
      let attempts = 0;

      await assert.rejects(
        writeFileAtomic(target, "content", {
          retryDelayMs: 1,
          deps: {
            rename: async () => {
              attempts++;
              throw errnoError("EPERM");
            },
            sleep: async () => {},
          },
        }),
      );

      assert.strictEqual(attempts, DEFAULT_MAX_ATTEMPTS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("concurrent writes never produce a torn file", async () => {
    const dir = makeTempDir();
    try {
      const target = path.join(dir, "settings.json");
      // 每个内容都是"完整合法"的标记串，便于断言最终文件必为其中之一
      const contents = Array.from(
        { length: 40 },
        (_, i) => `{"writer":${i},"payload":"${"x".repeat(500)}"}\n`,
      );

      await Promise.all(
        contents.map((c) => writeFileAtomic(target, c)),
      );

      const final = fs.readFileSync(target, "utf8");
      assert.ok(
        contents.includes(final),
        "final content must be exactly one of the written contents (no torn mix)",
      );
      assert.deepStrictEqual(
        listTempFiles(dir),
        [],
        "no temp files should remain after concurrent writes",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves the target's original mode via chmod before rename", async () => {
    const dir = makeTempDir();
    try {
      const target = path.join(dir, "settings.json");
      const originalMode = 0o600;
      const chmodCalls: Array<{ path: string; mode: number }> = [];

      await writeFileAtomic(target, "content", {
        deps: {
          statMode: async () => originalMode,
          chmod: async (p, mode) => {
            chmodCalls.push({ path: p, mode });
          },
        },
      });

      assert.strictEqual(chmodCalls.length, 1, "chmod should be called once");
      assert.strictEqual(chmodCalls[0].mode, originalMode);
      assert.ok(
        chmodCalls[0].path.endsWith(".tmp"),
        "chmod should target the temp file",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not chmod when the target does not exist yet", async () => {
    const dir = makeTempDir();
    try {
      const target = path.join(dir, "settings.json");
      let chmodCalled = false;

      await writeFileAtomic(target, "content", {
        deps: {
          statMode: async () => undefined,
          chmod: async () => {
            chmodCalled = true;
          },
        },
      });

      assert.strictEqual(chmodCalled, false);
      assert.strictEqual(fs.readFileSync(target, "utf8"), "content");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a chmod failure does not abort the write", async () => {
    const dir = makeTempDir();
    try {
      const target = path.join(dir, "settings.json");

      await writeFileAtomic(target, "content", {
        deps: {
          statMode: async () => 0o600,
          chmod: async () => {
            throw errnoError("EPERM");
          },
        },
      });

      assert.strictEqual(fs.readFileSync(target, "utf8"), "content");
      assert.deepStrictEqual(listTempFiles(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // POSIX 专属：真实文件系统上验证 rename 后权限被保留。
  // Windows 上 chmod 基本是 no-op，跳过。
  (process.platform === "win32" ? test.skip : test)(
    "preserves real file mode on POSIX after rename",
    async () => {
      const dir = makeTempDir();
      try {
        const target = path.join(dir, "settings.json");
        fs.writeFileSync(target, "old", "utf8");
        fs.chmodSync(target, 0o600);

        await writeFileAtomic(target, "new");

        const mode = fs.statSync(target).mode & 0o777;
        assert.strictEqual(
          mode,
          0o600,
          `expected mode 0600, got 0${mode.toString(8)}`,
        );
        assert.strictEqual(fs.readFileSync(target, "utf8"), "new");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
