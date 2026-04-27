import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBackup, listBackups, restoreBackup } from "../dist/backup/index.js";
import { createDefaultConfig, loadConfig, saveConfig } from "../dist/config/index.js";
import { createSnapshotFingerprint } from "../dist/watcher/fingerprint.js";
import { getDefaultPaths } from "../dist/utils/paths.js";

test("legacy config is normalized with new defaults", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-legacy-config-"));
  try {
    const paths = getDefaultPaths(path.join(root, "agent"));
    await mkdir(paths.piDir, { recursive: true });
    await writeFile(
      paths.configFile,
      JSON.stringify(
        {
          version: 1,
          repoUrl: "git@example.com:team/pi-config.git",
          repoDir: paths.repoDir,
          autoMode: "manual",
          pullIntervalMinutes: 30,
          pushDebounceMs: 10,
          chat: { autoExport: false },
          retention: { keepChatExports: 3 },
          policy: { includedPaths: ["AGENTS.md"] },
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = await loadConfig(paths);

    assert.equal(config.chat.autoExport, false);
    assert.equal(config.chat.rawSessionSync, false);
    assert.equal(config.retention.keepChatExports, 3);
    assert.equal(config.retention.keepBackups, 20);
    assert.deepEqual(config.policy.includedPaths, ["AGENTS.md"]);
    assert.deepEqual(config.policy.dangerouslyAllowedNames, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup list and restore round trip managed files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-backup-"));
  try {
    const piDir = path.join(root, "agent");
    const paths = getDefaultPaths(piDir);
    const config = createDefaultConfig("git@example.com:team/pi-config.git", paths);

    await mkdir(piDir, { recursive: true });
    await writeFile(path.join(piDir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    await writeFile(path.join(piDir, "keybindings.json"), JSON.stringify({ save: "ctrl+s" }), "utf8");

    const backup = await createBackup(config, paths, "test backup");
    await writeFile(path.join(piDir, "settings.json"), JSON.stringify({ theme: "light" }), "utf8");

    assert.equal((await listBackups(paths))[0].id, backup.id);
    const restored = await restoreBackup(paths, backup.id);

    assert.equal(restored.id, backup.id);
    assert.deepEqual(JSON.parse(await readFile(path.join(piDir, "settings.json"), "utf8")), {
      theme: "dark",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot fingerprint changes when managed files change", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-fingerprint-"));
  try {
    const piDir = path.join(root, "agent");
    const paths = getDefaultPaths(piDir);
    const config = createDefaultConfig("git@example.com:team/pi-config.git", paths);
    await mkdir(piDir, { recursive: true });
    await writeFile(path.join(piDir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");

    const before = await createSnapshotFingerprint(config, paths);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(path.join(piDir, "settings.json"), JSON.stringify({ theme: "light" }), "utf8");
    const after = await createSnapshotFingerprint(config, paths);

    assert.notEqual(before, after);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
