import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultConfig } from "../dist/config/index.js";
import { getDefaultPaths } from "../dist/utils/paths.js";
import { stageSnapshot } from "../dist/snapshot/index.js";
import { scanForSecrets } from "../dist/snapshot/policy.js";

test("secret-like portable config blocks snapshot staging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-secret-config-"));
  try {
    const piDir = path.join(root, "agent");
    const paths = getDefaultPaths(piDir);
    const config = createDefaultConfig("git@example.com:team/pi-config.git", paths);
    config.policy.includedPaths.push("prompts/secret.md");

    await mkdir(path.join(piDir, "prompts"), { recursive: true });
    await writeFile(path.join(piDir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    await writeFile(path.join(piDir, "prompts", "secret.md"), "api_key = abcdefghijklmnopqrstuvwxyz\n", "utf8");

    await assert.rejects(() => stageSnapshot(config, piDir), /Secret-like content detected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source symlinks are refused or skipped", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-symlink-"));
  try {
    const piDir = path.join(root, "agent");
    const paths = getDefaultPaths(piDir);
    const config = createDefaultConfig("git@example.com:team/pi-config.git", paths);
    config.policy.includedPaths.push("prompts/link.md");

    await mkdir(path.join(piDir, "prompts"), { recursive: true });
    await writeFile(path.join(piDir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    await writeFile(path.join(root, "outside.md"), "outside\n", "utf8");
    try {
      await symlink(path.join(root, "outside.md"), path.join(piDir, "prompts", "link.md"));
    } catch (error) {
      t.skip(`symlink unavailable on this platform: ${error.message}`);
      return;
    }

    await assert.rejects(() => stageSnapshot(config, piDir), /Refusing to sync symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secret scanner ignores binary and oversized files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-secret-scan-"));
  try {
    const png = path.join(root, "token.png");
    const large = path.join(root, "large.txt");
    await writeFile(png, "token = abcdefghijklmnopqrstuvwxyz", "utf8");
    await writeFile(large, `${"x".repeat(1024 * 1024 + 1)}token = abcdefghijklmnopqrstuvwxyz`, "utf8");

    assert.deepEqual(await scanForSecrets(png), []);
    assert.deepEqual(await scanForSecrets(large), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
