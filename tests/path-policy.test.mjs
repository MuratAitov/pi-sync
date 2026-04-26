import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { normalizePortablePath, resolveInside, toRepoPath } from "../dist/utils/paths.js";
import {
  DEFAULT_POLICY,
  getOptionalStoreChoices,
  getPortableSyncPaths,
  shouldNeverSync,
} from "../dist/snapshot/policy.js";

test("portable path helpers reject traversal and normalize safe paths", () => {
  assert.equal(normalizePortablePath("./themes\\dark/./config.json"), "themes/dark/config.json");
  assert.equal(normalizePortablePath("/settings.json"), "settings.json");
  assert.equal(toRepoPath("prompts\\daily.md"), "prompts/daily.md");

  assert.throws(() => normalizePortablePath("../settings.json"), /Unsafe relative path/);
  assert.throws(() => normalizePortablePath("themes/../../auth.json"), /Unsafe relative path/);
});

test("resolveInside keeps portable paths within the requested root", () => {
  const root = path.resolve("/tmp/pi-sync-root");

  assert.equal(resolveInside(root, "settings.json"), path.join(root, "settings.json"));
  assert.equal(resolveInside(root, "/themes/default.json"), path.join(root, "themes", "default.json"));

  assert.throws(() => resolveInside(root, "../outside.json"), /Unsafe relative path/);
});

test("store-this-too policy exposes optional safe choices and blocks never-sync names", () => {
  const policy = structuredClone(DEFAULT_POLICY);
  policy.optionalFiles.push("sessions/transcript.jsonl", "local/AGENTS.md");
  policy.optionalDirs.push("node_modules/package");
  policy.includedPaths.push("CLAUDE.md", "extensions");
  policy.excludedPaths.push("extensions");

  assert.deepEqual(getOptionalStoreChoices(policy), [
    "AGENTS.md",
    "CLAUDE.md",
    "extensions",
    "local/AGENTS.md",
    "sync-suite-chat-exports",
  ]);
  assert.equal(shouldNeverSync("sessions/transcript.jsonl", policy), true);
  assert.equal(shouldNeverSync("local/AGENTS.md", policy), false);

  assert.deepEqual(getPortableSyncPaths(policy), [
    "CLAUDE.md",
    "keybindings.json",
    "prompts",
    "settings.json",
    "skills",
    "themes",
  ]);
});
