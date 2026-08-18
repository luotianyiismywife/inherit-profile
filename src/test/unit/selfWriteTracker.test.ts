import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  SelfWriteTracker,
  WRITE_TOKEN_SUFFIX,
  readWriteTokenHash,
  sha1Hex,
  writeTokenPathFor,
  writeWriteToken,
} from "../../selfWriteTracker";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inherit-profile-test-"));
}

suite("SelfWriteTracker", () => {
  test("isSelfWrite returns false for a path that has never been recorded", () => {
    const tracker = new SelfWriteTracker();
    assert.strictEqual(tracker.isSelfWrite("/settings.json", "content"), false);
  });

  test("isSelfWrite returns true when content matches the last recorded write", () => {
    const tracker = new SelfWriteTracker();
    tracker.record("/settings.json", "{ \"a\": 1 }");
    assert.strictEqual(
      tracker.isSelfWrite("/settings.json", "{ \"a\": 1 }"),
      true,
    );
  });

  test("isSelfWrite returns false when content differs from the last recorded write", () => {
    const tracker = new SelfWriteTracker();
    tracker.record("/settings.json", "{ \"a\": 1 }");
    assert.strictEqual(
      tracker.isSelfWrite("/settings.json", "{ \"a\": 2 }"),
      false,
    );
  });

  test("tracks multiple paths independently", () => {
    const tracker = new SelfWriteTracker();
    tracker.record("/a/settings.json", "A");
    tracker.record("/b/settings.json", "B");

    assert.strictEqual(tracker.isSelfWrite("/a/settings.json", "A"), true);
    assert.strictEqual(tracker.isSelfWrite("/b/settings.json", "B"), true);
    assert.strictEqual(tracker.isSelfWrite("/a/settings.json", "B"), false);
  });

  test("record overwrites the previously recorded content for the same path", () => {
    const tracker = new SelfWriteTracker();
    tracker.record("/settings.json", "first");
    tracker.record("/settings.json", "second");

    assert.strictEqual(tracker.isSelfWrite("/settings.json", "first"), false);
    assert.strictEqual(tracker.isSelfWrite("/settings.json", "second"), true);
  });

  test("forget makes the next change to a path be treated as external", () => {
    const tracker = new SelfWriteTracker();
    tracker.record("/settings.json", "content");
    tracker.forget("/settings.json");

    assert.strictEqual(
      tracker.isSelfWrite("/settings.json", "content"),
      false,
    );
  });

  test("sha1Hex is deterministic and content-sensitive", () => {
    assert.strictEqual(sha1Hex("abc"), sha1Hex("abc"));
    assert.notStrictEqual(sha1Hex("abc"), sha1Hex("abd"));
    assert.strictEqual(sha1Hex("abc").length, 40);
  });

  test("writeWriteToken creates a sibling marker file and readWriteTokenHash round-trips", () => {
    const dir = makeTempDir();
    try {
      const target = path.join(dir, "settings.json");
      const content = "{\n    \"a\": 1\n}\n";

      writeWriteToken(target, content);

      // 标记文件必须与目标文件同目录、同名加后缀
      const tokenPath = path.join(dir, "settings.json" + WRITE_TOKEN_SUFFIX);
      assert.ok(fs.existsSync(tokenPath), "marker file should exist");
      assert.strictEqual(writeTokenPathFor(target), tokenPath);

      // 哈希比对命中
      assert.strictEqual(readWriteTokenHash(target), sha1Hex(content));

      // 内容变化 → 哈希不匹配（模拟外部编辑）
      assert.notStrictEqual(
        readWriteTokenHash(target),
        sha1Hex(content + "// extra\n"),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeWriteToken overwrites the previous marker for the same target", () => {
    const dir = makeTempDir();
    try {
      const target = path.join(dir, "extensions.json");

      writeWriteToken(target, "first");
      const firstHash = readWriteTokenHash(target);
      assert.strictEqual(firstHash, sha1Hex("first"));

      writeWriteToken(target, "second");
      assert.strictEqual(readWriteTokenHash(target), sha1Hex("second"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readWriteTokenHash returns undefined when no marker file exists", () => {
    const dir = makeTempDir();
    try {
      assert.strictEqual(
        readWriteTokenHash(path.join(dir, "settings.json")),
        undefined,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readWriteTokenHash returns undefined for a corrupt marker file", () => {
    const dir = makeTempDir();
    try {
      const target = path.join(dir, "settings.json");
      fs.writeFileSync(
        target + WRITE_TOKEN_SUFFIX,
        "not-json{{{",
        "utf8",
      );
      assert.strictEqual(readWriteTokenHash(target), undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
