import * as assert from "assert";
import * as path from "path";
import {
  mergeInheritedExtensions,
  stripInheritedExtensions,
  isInheritedExtension,
  isOptedOutExtension,
  markExtensionAsInherited,
  markExtensionAsOptedOut,
  convertOldMarkers,
  resolveParentExtensionsPaths,
  compareVersions,
  ExtensionEntry,
  INHERITED_PROFILE_META_KEY,
} from "../../profileSettings";

suite("mergeInheritedExtensions full reconciliation", () => {
  // ── 辅助函数测试 ──

  test("isInheritedExtension returns true when inheritProfile.inherited is set", () => {
    assert.strictEqual(
      isInheritedExtension({ identifier: { id: "a.b" }, metadata: { inheritProfile: { inherited: true } } }),
      true,
    );
    assert.strictEqual(
      isInheritedExtension({ identifier: { id: "a.b" } }),
      false,
    );
  });

  test("isOptedOutExtension returns true when inheritProfile.optedOut is set", () => {
    assert.strictEqual(
      isOptedOutExtension({ identifier: { id: "a.b" }, metadata: { inheritProfile: { optedOut: true } } }),
      true,
    );
    assert.strictEqual(
      isOptedOutExtension({ identifier: { id: "a.b" } }),
      false,
    );
  });

  test("markExtensionAsInherited adds inheritProfile.inherited metadata", () => {
    const ext: ExtensionEntry = { identifier: { id: "a.b" } };
    const result = markExtensionAsInherited(ext);
    assert.strictEqual(result.metadata?.inheritProfile?.inherited, true);
    // Preserves existing metadata
    const extWithMeta: ExtensionEntry = { identifier: { id: "a.b" }, metadata: { pinned: true } };
    const result2 = markExtensionAsInherited(extWithMeta);
    assert.strictEqual(result2.metadata?.pinned, true);
    assert.strictEqual(result2.metadata?.inheritProfile?.inherited, true);
  });

  test("markExtensionAsOptedOut creates a minimal entry with only identifier.id", () => {
    const result = markExtensionAsOptedOut("a.b");
    assert.deepStrictEqual(result, {
      identifier: { id: "a.b" },
      metadata: { inheritProfile: { optedOut: true } },
    });
  });

  test("convertOldMarkers converts inheritedFromProfile to inheritProfile.inherited", () => {
    const oldExt: any = { identifier: { id: "a.b" }, metadata: { inheritedFromProfile: "Base", pinned: true } };
    const result = convertOldMarkers(oldExt);
    assert.strictEqual(result.metadata?.inheritProfile?.inherited, true);
    assert.strictEqual(result.metadata?.inheritedFromProfile, undefined);
    assert.strictEqual(result.metadata?.pinned, true);
  });

  test("convertOldMarkers leaves new format unchanged", () => {
    const newExt: any = { identifier: { id: "a.b" }, metadata: { inheritProfile: { inherited: true } } };
    const result = convertOldMarkers(newExt);
    assert.deepStrictEqual(result, newExt);
  });

  // ── compareVersions 版本比较（issue #6：1.8.5 回滚时被连带删除，现已恢复）──

  test("compareVersions compares semver segments (higher wins)", () => {
    assert.ok(compareVersions("1.13.0", "1.12.3") > 0, "1.13.0 > 1.12.3");
    assert.ok(compareVersions("1.12.3", "1.13.0") < 0, "1.12.3 < 1.13.0");
    assert.strictEqual(compareVersions("1.5.0", "1.5.0"), 0);
  });

  test("compareVersions tolerates a leading v prefix and undefined", () => {
    assert.strictEqual(compareVersions("v1.2.3", "1.2.3"), 0);
    assert.ok(compareVersions("1.10.0", "1.9.0") > 0, "1.10.0 > 1.9.0 (not lexicographic)");
    // undefined / 空串按 0 处理
    assert.ok(compareVersions(undefined, "0.1.0") < 0, "undefined < 0.1.0");
    assert.strictEqual(compareVersions(undefined, undefined), 0);
  });

  // ── 子 Profile 升级继承扩展不被父级回退（issue #6 回归）──

  test("inherited extension upgraded in child is preserved when version >= parent (issue #6)", () => {
    // 子级手动升级到更高版本（VSIX / 直接升级），reconcile 后应保留子级版本而非被父级覆盖回退。
    const child: any = [
      { identifier: { id: "ext.a" }, version: "1.13.0", metadata: { inheritProfile: { inherited: true } } },
    ];
    const parent: any = { profileName: "Base", extensions: [{ identifier: { id: "ext.a" }, version: "1.12.3" }] };
    const r = mergeInheritedExtensions<any>(child, [parent], []);
    const merged = r.merged.find(e => e.identifier?.id === "ext.a")!;
    assert.strictEqual(merged.version, "1.13.0", "child's higher version must be preserved");
    assert.strictEqual(merged.metadata?.inheritProfile?.inherited, true);
  });

  test("parent higher version still syncs down to child (issue #6)", () => {
    const child: any = [
      { identifier: { id: "ext.b" }, version: "1.0.0", metadata: { inheritProfile: { inherited: true } } },
    ];
    const parent: any = { profileName: "Base", extensions: [{ identifier: { id: "ext.b" }, version: "2.0.0" }] };
    const r = mergeInheritedExtensions<any>(child, [parent], []);
    const merged = r.merged.find(e => e.identifier?.id === "ext.b")!;
    assert.strictEqual(merged.version, "2.0.0", "parent higher version should win");
  });

  test("equal version preserves child entry (issue #6)", () => {
    const child: any = [
      { identifier: { id: "ext.c" }, version: "1.5.0", metadata: { inheritProfile: { inherited: true } } },
    ];
    const parent: any = { profileName: "Base", extensions: [{ identifier: { id: "ext.c" }, version: "1.5.0" }] };
    const r = mergeInheritedExtensions<any>(child, [parent], []);
    const merged = r.merged.find(e => e.identifier?.id === "ext.c")!;
    assert.strictEqual(merged.version, "1.5.0");
  });

  test("own extension taken over by parent keeps child version (issue #6)", () => {
    const child: any = [{ identifier: { id: "ext.d" }, version: "3.0.0" }]; // own
    const parent: any = { profileName: "Base", extensions: [{ identifier: { id: "ext.d" }, version: "1.0.0" }] };
    const r = mergeInheritedExtensions<any>(child, [parent], []);
    const merged = r.merged.find(e => e.identifier?.id === "ext.d")!;
    assert.strictEqual(merged.version, "3.0.0", "own branch preserves child version");
  });

  test("resolveParentExtensionsPaths returns correct paths", () => {
    const profiles = { "Base": "/user/profiles/base", "Dev": "/user/profiles/dev" };
    const result = resolveParentExtensionsPaths(["Base", "Dev", "Missing"], profiles);
    assert.deepStrictEqual(result, [
      path.join("/user/profiles/base", "extensions.json"),
      path.join("/user/profiles/dev", "extensions.json"),
    ]);
  });

  // ── 核心对账算法测试 ──

  test("empty extensions with no parents returns empty", () => {
    const r = mergeInheritedExtensions([], [], []);
    assert.strictEqual(r.merged.length, 0);
    assert.strictEqual(r.originallyOwnExtensions.length, 0);
    assert.deepStrictEqual(r.parentNameMap, {});
  });

  test("own extensions survive when no parents", () => {
    const own: any = [{ identifier: { id: "a" } }];
    const r = mergeInheritedExtensions(own, [], []);
    assert.strictEqual(r.merged.length, 1);
    assert.strictEqual(r.merged[0].identifier?.id, "a");
    assert.strictEqual(r.merged[0].metadata?.inheritProfile, undefined);
  });

  test("inherited extensions are preserved as own when no parents (issue #5)", () => {
    // 无父级（根 Profile）时绝不清理 inherited 扩展（防止 VS Code 降级清空根 Profile）。
    // 'b' 虽带 inherited 标记且不在 originallyOwn，也应退还为 own 保留而非丢弃。
    const input: any = [
      { identifier: { id: "a" } },
      { identifier: { id: "b" }, metadata: { inheritProfile: { inherited: true } } },
    ];
    const r = mergeInheritedExtensions(input, [], ["a"]);
    assert.strictEqual(r.merged.length, 2, "b should be preserved as own, not discarded");
    const b = r.merged.find(e => e.identifier?.id === "b")!;
    assert.strictEqual(b.metadata?.inheritProfile, undefined, "b should be reverted to own (marker removed)");
    const a = r.merged.find(e => e.identifier?.id === "a")!;
    assert.strictEqual(a.metadata?.inheritProfile, undefined, "a stays own");
  });

  test("parent provides new extensions as inherited", () => {
    const parent: any = { profileName: "Base", extensions: [{ identifier: { id: "x" } }, { identifier: { id: "y" } }] };
    const r = mergeInheritedExtensions<any>([], [parent], []);
    assert.strictEqual(r.merged.length, 2);
    for (const ext of r.merged) {
      assert.strictEqual(ext.metadata?.inheritProfile?.inherited, true, `${ext.identifier?.id} should be inherited`);
    }
  });

  test("own extension becomes inherited when parent also has it (own→inherited)", () => {
    const parent: any = { profileName: "Base", extensions: [{ identifier: { id: "x" } }] };
    const r = mergeInheritedExtensions(
      [{ identifier: { id: "x" } }] as any,
      [parent],
      [],
    );
    const x = r.merged.find(e => e.identifier?.id === "x")!;
    assert.strictEqual(x.metadata?.inheritProfile?.inherited, true, "x should be inherited after takeover");
    assert.strictEqual(r.originallyOwnExtensions.includes("x"), true, "x should be recorded in originallyOwn");
    assert.strictEqual(r.parentNameMap["x"], "Base", "x parentName should be Base");
  });

  test("optedOut extensions are preserved and never become inherited", () => {
    const parent: any = { profileName: "Base", extensions: [{ identifier: { id: "a" } }] };
    const current: any = [{ identifier: { id: "a" }, metadata: { inheritProfile: { optedOut: true } } }];
    const r = mergeInheritedExtensions(current, [parent], []);
    const a = r.merged.find(e => e.identifier?.id === "a")!;
    assert.strictEqual(a.metadata?.inheritProfile?.optedOut, true, "a should stay optedOut");
    assert.strictEqual(a.metadata?.inheritProfile?.inherited, undefined, "a should NOT become inherited");
    assert.strictEqual(r.parentNameMap["a"], undefined, "a should NOT be in parentNameMap");
  });

  test("revert to own when parent no longer provides an originallyOwn extension", () => {
    const r = mergeInheritedExtensions(
      [{ identifier: { id: "a" }, metadata: { inheritProfile: { inherited: true } } }],
      [],
      ["a"],
    );
    const a = r.merged.find(e => e.identifier?.id === "a")!;
    assert.strictEqual(a.metadata?.inheritProfile, undefined, "a should have no inheritProfile after revert");
    assert.strictEqual(r.originallyOwnExtensions.includes("a"), false, "a should be removed from originallyOwn");
  });

  test("first parent wins when multiple parents declare the same extension", () => {
    const parents: any = [
      { profileName: "Default", extensions: [{ identifier: { id: "eslint" } }] },
      { profileName: "Work", extensions: [{ identifier: { id: "eslint" } }] },
    ];
    const r = mergeInheritedExtensions([], parents, []);
    assert.strictEqual(r.merged.length, 1);
    assert.strictEqual(r.parentNameMap["eslint"], "Default");
  });

  test("empty parentProfiles array returns unchanged with empty originallyOwn", () => {
    const current = [{ identifier: { id: "a" } }];
    const r = mergeInheritedExtensions(current, [], []);
    assert.deepStrictEqual(r.merged, current);
  });

  test("stripInheritedExtensions keeps optedOut entries", () => {
    const result = stripInheritedExtensions([
      { identifier: { id: "own" } } as any,
      { identifier: { id: "inh" }, metadata: { inheritProfile: { inherited: true } } } as any,
      { identifier: { id: "opt" }, metadata: { inheritProfile: { optedOut: true } } } as any,
    ]);
    assert.strictEqual(result.length, 2);
    assert.ok(result.some(e => e.identifier?.id === "own"));
    assert.ok(result.some(e => e.identifier?.id === "opt"));
    assert.ok(!result.some(e => e.identifier?.id === "inh"));
  });

  test("parentNameMap only includes entries from inherited extensions", () => {
    const parent: any = { profileName: "Base", extensions: [{ identifier: { id: "a" } }] };
    const current: any = [{ identifier: { id: "a" }, metadata: { inheritProfile: { optedOut: true } } }];
    const r = mergeInheritedExtensions(current, [parent], []);
    // 'a' is optedOut, should not appear in parentNameMap
    assert.strictEqual(r.parentNameMap["a"], undefined);
  });
});
