import * as assert from "assert";
import * as path from "path";

import {
  buildInheritedSettingsBlock,
  ExtensionEntry,
  findTabValue,
  flattenSettings,
  INHERITED_SETTINGS_END_MARKER,
  INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY,
  INHERITED_SETTINGS_START_MARKER,
  insertBeforeClose,
  mergeFlattenedSettings,
  mergeInheritedExtensions,
  NON_FLATTENABLE_SETTINGS,
  removeTrailingComma,
  stripInheritedSettingsBlocks,
  resolveParentSettingsPaths,
  resolveParentExtensionsPaths,
  sortSettings,
  splitRawSettingsByClosingBrace,
  isBalancedJsonc,
  isSettingsDocument,
  stripInheritedExtensions,
  stripManagedProfileSettings,
  subtractSettings,
  isInheritedExtension,
  isOptedOutExtension,
  markExtensionAsInherited,
  markExtensionAsOptedOut,
  convertOldMarkers,
  INHERITED_PROFILE_META_KEY,
} from "../../profileSettings";

suite("profileSettings helpers", () => {
  test("flattenSettings flattens nested objects and preserves arrays", () => {
    assert.deepStrictEqual(
      flattenSettings({
        editor: {
          fontSize: 14,
          rulers: [80, 100],
        },
        "files.autoSave": "off",
      }),
      {
        "editor.fontSize": 14,
        "editor.rulers": [80, 100],
        "files.autoSave": "off",
      },
    );
  });

  test("flattenSettings does not split keys inside files.exclude (issue #5)", () => {
    assert.deepStrictEqual(
      flattenSettings({
        "files.exclude": {
          "README.md": true,
        },
      }),
      {
        "files.exclude": {
          "README.md": true,
        },
      },
    );
  });

  test("flattenSettings does not split keys inside files.exclude when given nested notation", () => {
    assert.deepStrictEqual(
      flattenSettings({
        files: {
          exclude: {
            "README.md": true,
          },
          autoSave: "off",
        },
      }),
      {
        "files.exclude": {
          "README.md": true,
        },
        "files.autoSave": "off",
      },
    );
  });

  test("flattenSettings preserves every known non-flattenable setting as a single leaf entry", () => {
    for (const key of NON_FLATTENABLE_SETTINGS) {
      const value = { "some.dotted.data.key": true };
      assert.deepStrictEqual(
        flattenSettings({ [key]: value }),
        { [key]: value },
        `Expected "${key}" to be preserved as a single leaf entry.`,
      );
    }
  });

  test("flattenSettings keeps theme-scoped color customizations intact", () => {
    assert.deepStrictEqual(
      flattenSettings({
        "workbench.colorCustomizations": {
          "editor.background": "#000000",
          "[Default Dark+]": {
            "statusBar.background": "#111111",
          },
        },
      }),
      {
        "workbench.colorCustomizations": {
          "editor.background": "#000000",
          "[Default Dark+]": {
            "statusBar.background": "#111111",
          },
        },
      },
    );
  });

  test("flattenSettings still flattens ordinary nested settings that are not opaque data maps", () => {
    assert.deepStrictEqual(
      flattenSettings({
        editor: {
          fontSize: 14,
          rulers: [80, 100],
        },
        terminal: {
          integrated: {
            fontSize: 12,
          },
        },
        "files.autoSave": "off",
      }),
      {
        "editor.fontSize": 14,
        "editor.rulers": [80, 100],
        "terminal.integrated.fontSize": 12,
        "files.autoSave": "off",
      },
    );
  });

  test("mergeFlattenedSettings prefers later profile values", () => {
    assert.deepStrictEqual(
      mergeFlattenedSettings(
        {
          "editor.fontSize": 14,
          "files.autoSave": "off",
        },
        {
          "editor.fontSize": 16,
        },
      ),
      {
        "editor.fontSize": 16,
        "files.autoSave": "off",
      },
    );
  });

  test("subtractSettings removes keys that already exist in the current profile", () => {
    assert.deepStrictEqual(
      subtractSettings(
        {
          "editor.fontSize": 16,
          "files.autoSave": "off",
          "terminal.integrated.fontSize": 12,
        },
        {
          "editor.fontSize": 18,
        },
      ),
      {
        "files.autoSave": "off",
        "terminal.integrated.fontSize": 12,
      },
    );
  });

  test("sortSettings orders inherited keys alphabetically", () => {
    assert.deepStrictEqual(
      Object.keys(
        sortSettings({
          "terminal.integrated.fontSize": 12,
          "editor.fontSize": 16,
          "files.autoSave": "off",
        }),
      ),
      [
        "editor.fontSize",
        "files.autoSave",
        "terminal.integrated.fontSize",
      ],
    );
  });

  test("stripManagedProfileSettings removes the insertion boundary key", () => {
    assert.deepStrictEqual(
      stripManagedProfileSettings({
        "editor.fontSize": 16,
        [INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY]: false,
      }),
      {
        "editor.fontSize": 16,
      },
    );
  });

  test("resolveParentSettingsPaths resolves settings.json for each known parent profile in order", () => {
    assert.deepStrictEqual(
      resolveParentSettingsPaths(["Default", "Work"], {
        Default: "/users/alex/profile-default",
        Work: "/users/alex/profile-work",
      }),
      [
        path.join("/users/alex/profile-default", "settings.json"),
        path.join("/users/alex/profile-work", "settings.json"),
      ],
    );
  });

  test("resolveParentSettingsPaths skips parent profile names that have no known directory", () => {
    assert.deepStrictEqual(
      resolveParentSettingsPaths(["Default", "Missing", "Work"], {
        Default: "/users/alex/profile-default",
        Work: "/users/alex/profile-work",
      }),
      [
        path.join("/users/alex/profile-default", "settings.json"),
        path.join("/users/alex/profile-work", "settings.json"),
      ],
    );
  });

  test("resolveParentSettingsPaths returns an empty array when there are no parent profiles", () => {
    assert.deepStrictEqual(resolveParentSettingsPaths([], {}), []);
  });

  test("removeTrailingComma ignores comments when trimming the final entry", () => {
    assert.strictEqual(
      removeTrailingComma(`{
    "files.autoSave": "off",
    // trailing comment
}
`),
      `{
    "files.autoSave": "off"
    // trailing comment
}
`,
    );
  });

  test("stripInheritedSettingsBlocks removes a single block", () => {
    const { cleaned, removedCount } = stripInheritedSettingsBlocks(
      `{
    "own.setting": true,
    // --- INHERITED SETTINGS MARKER START --- //
    "inherited.setting": 1,
    // --- INHERITED SETTINGS MARKER END --- //
    "inheritProfile._insertionBoundary": false
}
`,
    );
    assert.strictEqual(removedCount, 1);
    assert.ok(cleaned.includes('"own.setting": true'));
    assert.ok(!cleaned.includes("MARKER"));
    assert.ok(!cleaned.includes("_insertionBoundary"));
  });

  test("stripInheritedSettingsBlocks removes ALL stacked blocks", () => {
    const block =
      `    // --- INHERITED SETTINGS MARKER START --- //\n` +
      `    "dup.setting": 1,\n` +
      `    // --- INHERITED SETTINGS MARKER END --- //\n` +
      `    "inheritProfile._insertionBoundary": false,\n`;
    // Two stacked blocks (the historical file-growth bug).
    const { cleaned, removedCount } = stripInheritedSettingsBlocks(
      `{
    "own.setting": true,
${block}${block}}
`,
    );
    assert.strictEqual(removedCount, 2);
    assert.ok(cleaned.includes('"own.setting": true'));
    assert.ok(!cleaned.includes("MARKER"));
    assert.ok(!cleaned.includes("_insertionBoundary"));
  });

  test("stripInheritedSettingsBlocks leaves file unchanged when no markers exist", () => {
    const { cleaned, removedCount } = stripInheritedSettingsBlocks(
      `{
    "own.setting": true
}
`,
    );
    assert.strictEqual(removedCount, 0);
    assert.strictEqual(cleaned, `{
    "own.setting": true
}
`);
  });

  test("stripInheritedSettingsBlocks removes an out-of-object residual block without leaving a duplicate top-level brace", () => {
    // 2026-08-21 实际损坏形态：对象内块（含对象闭合 }）+ 对象外残留块（自带一个
    // 顶层 }）。旧逻辑删除残留块后产生 `}}`，isSettingsDocument 校验失败 →
    // removeInheritedSettingsFromFile 拒绝写入，插件无法自愈。
    const { cleaned, removedCount } = stripInheritedSettingsBlocks(
      `{
    "own.setting": true,
    // --- INHERITED SETTINGS MARKER START --- //
    "inherited.setting": 1,
    // --- INHERITED SETTINGS MARKER END --- //
    "inheritProfile._insertionBoundary": false
}
   // --- INHERITED SETTINGS MARKER START --- //
    // WARNING: Do not remove the inherited settings start and end markers.
    //          The markers are used to identify inserted inherited settings.
    "dup.setting": 2,
    // --- INHERITED SETTINGS MARKER END --- //
    "inheritProfile._insertionBoundary": false
}
`,
    );
    assert.strictEqual(removedCount, 2);
    assert.ok(cleaned.includes('"own.setting": true'));
    assert.ok(!cleaned.includes("MARKER"));
    assert.ok(!cleaned.includes("_insertionBoundary"));
    // 关键：不能留下 `}}`，必须仍是合法 settings 对象
    const { cleaned: finalCleaned } = stripInheritedSettingsBlocks(cleaned);
    assert.strictEqual(finalCleaned, cleaned); // 幂等
    assert.ok(!cleaned.includes("}}"));
    assert.strictEqual(cleaned.trimEnd().endsWith("}"), true);
    // 且结果必须能被 isSettingsDocument 接受
    assert.strictEqual(isSettingsDocument(cleaned), true);
  });

  test("stripInheritedSettingsBlocks stops at an invalid marker order", () => {
    // END before START (e.g. after a VS Code rewrite lost the START marker).
    const { cleaned, removedCount } = stripInheritedSettingsBlocks(
      `{
    "own.setting": true,
    // --- INHERITED SETTINGS MARKER END --- //
    "orphan": 1
}
`,
    );
    assert.strictEqual(removedCount, 0);
    assert.strictEqual(cleaned, `{
    "own.setting": true,
    // --- INHERITED SETTINGS MARKER END --- //
    "orphan": 1
}
`);
  });

  test("findTabValue detects tabs and falls back to four spaces", () => {
    assert.strictEqual(
      findTabValue(`{
\t"files.autoSave": "off"
}
`),
      "\t",
    );
    assert.strictEqual(findTabValue("{\n}\n"), "    ");
  });

  test("buildInheritedSettingsBlock includes markers, values, and the boundary entry", () => {
    const block = buildInheritedSettingsBlock(
      {
        "editor.fontSize": 16,
      },
      "    ",
    );

    assert.ok(block.includes(INHERITED_SETTINGS_START_MARKER));
    assert.ok(block.includes(INHERITED_SETTINGS_END_MARKER));
    assert.ok(block.includes('"editor.fontSize": 16'));
    assert.ok(
      block.includes(`"${INHERITED_SETTINGS_INSERTION_BOUNDARY_KEY}": false`),
    );
  });

  test("insertBeforeClose adds a comma after the last meaningful value before comments", () => {
    assert.strictEqual(
      insertBeforeClose(
        `{
    "editor.fontSize": 14
    // keep this comment
`,
        `    "files.autoSave": "off"
`,
      ),
      `{
    "editor.fontSize": 14,
    // keep this comment
    "files.autoSave": "off"
`,
    );
  });

  test("splitRawSettingsByClosingBrace returns null for an empty document (malformed)", () => {
    assert.strictEqual(splitRawSettingsByClosingBrace(""), null);
  });

  test("splitRawSettingsByClosingBrace returns null when there is no top-level brace", () => {
    assert.strictEqual(splitRawSettingsByClosingBrace("just text"), null);
    assert.strictEqual(splitRawSettingsByClosingBrace("{"), null); // unclosed
  });

  test("splitRawSettingsByClosingBrace splits at the top-level closing brace", () => {
    const split = splitRawSettingsByClosingBrace(
      `{
    "a": 1,
    "b": [1, 2]
}`,
    );
    assert.ok(split, "should not be null for valid input");
    const [beforeClose, afterClose] = split;
    assert.strictEqual(beforeClose, `{
    "a": 1,
    "b": [1, 2]
`);
    assert.strictEqual(afterClose, "}");
  });

  test("splitRawSettingsByClosingBrace ignores } inside string values and comments", () => {
    const raw = `{
    "chat.tools.terminal.autoApprove": {"key with } inside": true},
    // a comment with } inside
    "tokenrhythm.modelPresets": [{"id":"precise"},{"id":"creative"}]
}`;
    const split = splitRawSettingsByClosingBrace(raw);
    assert.ok(split, "should not be null for valid input");
    const [beforeClose, afterClose] = split;
    assert.strictEqual(afterClose, "}");
    assert.strictEqual(beforeClose.includes("autoApprove"), true);
    assert.strictEqual(beforeClose.includes("tokenrhythm"), true);
    assert.strictEqual(beforeClose.trimEnd().endsWith("]"), true);
  });

  test("splitRawSettingsByClosingBrace returns null on unbalanced braces", () => {
    assert.strictEqual(splitRawSettingsByClosingBrace("{\n  \"a\": 1\n"), null); // missing close
    assert.strictEqual(splitRawSettingsByClosingBrace("}\n{"), null); // close before open
  });

  test("splitRawSettingsByClosingBrace returns null on double top-level close (the ]}, corruption)", () => {
    const corrupted = `{
    "inheritProfile.parents": [
        "Base"
    ]
},
    // --- INHERITED SETTINGS MARKER START --- //
    "chat.agent.maxRequests": 300,
    // --- INHERITED SETTINGS MARKER END --- //
    "inheritProfile._insertionBoundary": false
}`;
    assert.strictEqual(splitRawSettingsByClosingBrace(corrupted), null);
  });

  // ── isBalancedJsonc / isSettingsDocument ──

  test("isBalancedJsonc accepts settings object documents", () => {
    assert.strictEqual(isBalancedJsonc(`{
  "a": 1,
  "b": [1, 2],
  "c": {"d": 3}
}`), true);
  });

  test("isBalancedJsonc accepts extensions.json ARRAY documents (1.8.4 regression)", () => {
    // ⚠️ 关键回归测试：1.8.4 曾把数组误判为损坏导致扩展被清空。
    // 通用校验必须接受顶层 [ 数组！
    assert.strictEqual(isBalancedJsonc(`[
  {"identifier": {"id": "a.b"}},
  {"identifier": {"id": "c.d"}}
]`), true);
    assert.strictEqual(isBalancedJsonc("[]"), true);
  });

  test("isBalancedJsonc accepts strings and comments containing braces", () => {
    assert.strictEqual(isBalancedJsonc(`{
  "chat.tools.terminal.autoApprove": {"/regex with } inside/": true},
  // comment with } inside
  "x": "string with } and { and ]"
}`), true);
  });

  test("isBalancedJsonc rejects the ]}, corruption", () => {
    const corrupted = `{
    "inheritProfile.parents": [
        "Base"
    ]
},
    // --- INHERITED SETTINGS MARKER START --- //
    "chat.agent.maxRequests": 300,
    // --- INHERITED SETTINGS MARKER END --- //
    "inheritProfile._insertionBoundary": false
}`;
    assert.strictEqual(isBalancedJsonc(corrupted), false);
  });

  test("isBalancedJsonc rejects unbalanced braces", () => {
    assert.strictEqual(isBalancedJsonc(`{
  "a": 1
`), false); // missing close
    assert.strictEqual(isBalancedJsonc(`{
  "a": 1
}}`), false); // extra close
    assert.strictEqual(isBalancedJsonc(`{
  "a": [1, 2
}`), false); // unbalanced array
  });

  test("isBalancedJsonc rejects content before/after top-level container", () => {
    assert.strictEqual(isBalancedJsonc(`garbage {
  "a": 1
}`), false);
    assert.strictEqual(isBalancedJsonc(`{
  "a": 1
} trailing`), false);
  });

  test("isSettingsDocument accepts settings objects but rejects arrays", () => {
    // settings.json 必须是对象 → [ 顶层被拒绝
    assert.strictEqual(isSettingsDocument(`{
  "a": 1
}`), true);
    assert.strictEqual(isSettingsDocument(`[
  {"a": 1}
]`), false, "array is NOT a valid settings document");
    assert.strictEqual(isSettingsDocument(`{
  "a": 1
`), false); // unclosed
  });

  test("stripInheritedExtensions removes only extensions tagged as inherited (new marker)", () => {
    assert.deepStrictEqual(
      stripInheritedExtensions([
        { identifier: { id: "esbenp.prettier-vscode" } },
        {
          identifier: { id: "ms-python.python" },
          metadata: { inheritProfile: { inherited: true } },
        },
        {
          identifier: { id: "ext.opted" },
          metadata: { inheritProfile: { optedOut: true } },
        },
      ]),
      [
        { identifier: { id: "esbenp.prettier-vscode" } },
        {
          identifier: { id: "ext.opted" },
          metadata: { inheritProfile: { optedOut: true } },
        },
      ],
    );
  });

  test("mergeInheritedExtensions inherits extensions missing from the current profile", () => {
    const result = mergeInheritedExtensions<ExtensionEntry>(
      [{ identifier: { id: "esbenp.prettier-vscode" } }],
      [
        {
          profileName: "Default",
          extensions: [
            { identifier: { id: "ms-python.python" } },
            { identifier: { id: "esbenp.prettier-vscode" } },
          ],
        },
      ],
    );

    assert.deepStrictEqual(
      result.merged.map((extension) => extension.identifier?.id).sort(),
      ["esbenp.prettier-vscode", "ms-python.python"],
    );

    const inherited = result.merged.find(
      (extension) => extension.identifier?.id === "ms-python.python",
    );
    assert.strictEqual(inherited?.metadata?.inheritProfile?.inherited, true);

    // The extension declared by both current and parent profiles is also
    // marked as inherited (own→inherited conversion), since the parent
    // "takes over" its inheritance management. VS Code deduplicates by
    // identifier.id so this does not cause duplication in the UI.
    const existing = result.merged.find(
      (extension) => extension.identifier?.id === "esbenp.prettier-vscode",
    );
    assert.strictEqual(existing?.metadata?.inheritProfile?.inherited, true);
  });

  test("mergeInheritedExtensions prioritises the first parent profile to declare an extension", () => {
    const result = mergeInheritedExtensions<ExtensionEntry>([], [
      {
        profileName: "Default",
        extensions: [{ identifier: { id: "dbaeumer.vscode-eslint" } }],
      },
      {
        profileName: "Work",
        extensions: [{ identifier: { id: "dbaeumer.vscode-eslint" } }],
      },
    ]);

    assert.strictEqual(result.merged.length, 1);
    assert.strictEqual(result.merged[0].metadata?.inheritProfile?.inherited, true);
  });

  test("mergeInheritedExtensions returns the current extensions unchanged when there are no parent profiles", () => {
    const currentExtensions = [{ identifier: { id: "esbenp.prettier-vscode" } }];
    const result = mergeInheritedExtensions(currentExtensions, []);
    assert.deepStrictEqual(
      result.merged,
      currentExtensions,
    );
  });
});
