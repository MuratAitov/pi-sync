import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { planCleanup } from "../dist/cleanup/index.js";
import { createDefaultConfig } from "../dist/config/index.js";
import { getDefaultPaths } from "../dist/utils/paths.js";
import { applySnapshot, stageSnapshot } from "../dist/snapshot/index.js";

test("snapshot strips machine-local settings keys and merges downloaded settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-snapshot-"));
  try {
    const piDir = path.join(root, "agent");
    const paths = getDefaultPaths(piDir);
    const config = createDefaultConfig("git@example.com:team/pi-config.git", paths);
    config.chat.autoUpload = false;

    await mkdir(piDir, { recursive: true });
    await writeFile(
      path.join(piDir, "settings.json"),
      JSON.stringify(
        {
          theme: "dark",
          lastChangelogVersion: "2026.04.01",
          nested: { keep: true },
          packages: ["npm:pi-lens", "../../pi-sync/src", "/Users/me/pi-local"],
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(path.join(piDir, "keybindings.json"), JSON.stringify({ save: "cmd+s" }), "utf8");

    const staged = await stageSnapshot(config, piDir);

    assert.deepEqual(staged, ["keybindings.json", "pi-sync-environment.json", "prompts", "settings.json", "skills", "themes"]);
    const repoSettings = JSON.parse(await readFile(path.join(paths.repoDir, "settings.json"), "utf8"));
    assert.deepEqual(repoSettings, { theme: "dark", nested: { keep: true }, packages: ["npm:pi-lens"] });

    await writeFile(
      path.join(piDir, "settings.json"),
      JSON.stringify(
        {
          theme: "local",
          localOnly: "preserved",
          lastChangelogVersion: "local-version",
          packages: ["npm:local-removed-by-remote", "../../local-dev/src"],
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      path.join(paths.repoDir, "settings.json"),
      JSON.stringify(
        {
          theme: "remote",
          remoteOnly: true,
          lastChangelogVersion: "remote-version",
          packages: ["npm:pi-subagents", "../../other-device/src"],
        },
        null,
        2,
      ),
      "utf8",
    );

    const applied = await applySnapshot(config, piDir);

    assert.deepEqual(applied, ["keybindings.json", "settings.json"]);
    const mergedSettings = JSON.parse(await readFile(path.join(piDir, "settings.json"), "utf8"));
    assert.deepEqual(mergedSettings, {
      theme: "remote",
      localOnly: "preserved",
      lastChangelogVersion: "local-version",
      remoteOnly: true,
      packages: ["npm:pi-subagents", "../../local-dev/src"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local package paths are synced only when explicitly enabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-local-packages-"));
  try {
    const piDir = path.join(root, "agent");
    const paths = getDefaultPaths(piDir);
    const config = createDefaultConfig("git@example.com:team/pi-config.git", paths);
    config.policy.syncLocalPackagePaths = true;

    await mkdir(piDir, { recursive: true });
    await writeFile(
      path.join(piDir, "settings.json"),
      JSON.stringify({ packages: ["npm:pi-lens", "../../pi-sync/src"] }, null, 2),
      "utf8",
    );

    await stageSnapshot(config, piDir);

    const repoSettings = JSON.parse(await readFile(path.join(paths.repoDir, "settings.json"), "utf8"));
    assert.deepEqual(repoSettings.packages, ["npm:pi-lens", "../../pi-sync/src"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup preview plans candidates without deleting files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-cleanup-"));
  try {
    const piDir = path.join(root, "agent");
    const paths = getDefaultPaths(piDir);
    const config = createDefaultConfig("git@example.com:team/pi-config.git", paths);
    config.retention.keepChatExports = 0;
    config.retention.keepBackups = 0;
    config.retention.maxAgeDays = 30;

    await mkdir(paths.chatExportDir, { recursive: true });
    await mkdir(paths.backupDir, { recursive: true });

    const now = Date.now();
    const files = [
      { file: path.join(paths.chatExportDir, "new.md"), ageDays: 1 },
      { file: path.join(paths.chatExportDir, "old.md"), ageDays: 45 },
      { file: path.join(paths.backupDir, "new-a.json"), ageDays: 1 },
      { file: path.join(paths.backupDir, "new-b.json"), ageDays: 2 },
      { file: path.join(paths.backupDir, "old-backup.json"), ageDays: 31 },
    ];
    for (const { file, ageDays } of files) {
      await writeFile(file, path.basename(file), "utf8");
      const time = new Date(now - ageDays * 24 * 60 * 60 * 1000);
      await utimes(file, time, time);
    }

    const candidates = await planCleanup(config, paths);

    assert.deepEqual(
      candidates.map((candidate) => path.basename(candidate.path)).sort(),
      ["old-backup.json", "old.md"],
    );
    assert.match(candidates.find((candidate) => candidate.path.endsWith("old.md")).reason, /older than 30 days/);
    assert.match(
      candidates.find((candidate) => candidate.path.endsWith("old-backup.json")).reason,
      /older than 30 days/,
    );

    for (const { file } of files) {
      assert.ok((await stat(file)).isFile(), `${file} should remain after preview planning`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot skips chat exports with secret-like content instead of failing push", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-secret-chat-"));
  try {
    const piDir = path.join(root, "agent");
    const paths = getDefaultPaths(piDir);
    const config = createDefaultConfig("git@example.com:team/pi-config.git", paths);
    config.chat.autoUpload = true;

    await mkdir(paths.chatExportDir, { recursive: true });
    await writeFile(path.join(piDir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    await writeFile(path.join(paths.chatExportDir, "safe.md"), "hello\n", "utf8");
    await writeFile(path.join(paths.chatExportDir, "blocked.md"), "token = abcdefghijklmnopqrstuvwxyz\n", "utf8");

    await stageSnapshot(config, piDir);

    assert.equal(await readFile(path.join(paths.repoDir, "sync-suite-chat-exports", "safe.md"), "utf8"), "hello\n");
    await assert.rejects(
      () => readFile(path.join(paths.repoDir, "sync-suite-chat-exports", "blocked.md"), "utf8"),
      /ENOENT/,
    );
    const report = await readFile(
      path.join(paths.repoDir, "sync-suite-chat-exports", ".pi-sync-skipped-secrets.jsonl"),
      "utf8",
    );
    assert.match(report, /blocked\.md/);
    assert.match(report, /secret-like content detected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("raw session sync is explicit and applies live Pi sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-raw-sessions-"));
  try {
    const piDir = path.join(root, "agent");
    const paths = getDefaultPaths(piDir);
    const config = createDefaultConfig("git@example.com:team/pi-config.git", paths);
    config.chat.rawSessionSync = true;
    config.policy.dangerouslyAllowedNames.push("sessions");
    config.policy.includedPaths.push("sessions");

    const sessionPath = path.join(piDir, "sessions", "--tmp-project--", "2026-04-26T00-00-00-000Z_test.jsonl");
    await mkdir(path.dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, `${JSON.stringify({ role: "user", content: "secret = abcdefghijklmnopqrstuvwxyz" })}\n`, "utf8");

    await stageSnapshot(config, piDir);
    const gitignore = await readFile(path.join(paths.repoDir, ".gitignore"), "utf8");
    assert.doesNotMatch(gitignore, /^sessions\/$/m);
    await rm(path.join(piDir, "sessions"), { recursive: true, force: true });
    await applySnapshot(config, piDir);

    assert.match(await readFile(sessionPath, "utf8"), /secret = abcdefghijklmnopqrstuvwxyz/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
