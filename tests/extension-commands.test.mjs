import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("extension commands mutate config policy and automation flags", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-commands-"));
  const previousPiDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const piDir = path.join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = piDir;
    const { createDefaultConfig, saveConfig } = await import("../dist/config/index.js");
    const { getDefaultPaths } = await import("../dist/utils/paths.js");
    const paths = getDefaultPaths(piDir);
    const initialConfig = createDefaultConfig("git@example.com:team/pi-config.git", paths);
    initialConfig.pullIntervalMinutes = 15;
    await saveConfig(initialConfig, paths);

    const extension = (await import("../dist/index.js")).default;
    const harness = createHarness();
    extension(harness.pi);

    await harness.commands.get("sync-sessions").handler("on", harness.ctx);
    await harness.commands.get("sync-chat-auto").handler("upload off", harness.ctx);
    await harness.commands.get("sync-include").handler("AGENTS.md", harness.ctx);
    await harness.commands.get("sync-exclude").handler("prompts/private.md", harness.ctx);
    await harness.commands.get("sync-clean-policy").handler("chat=7 backups=4 days=9 auto=on", harness.ctx);

    const config = JSON.parse(await readFile(path.join(piDir, "pi-sync-suite.json"), "utf8"));
    assert.equal(config.pullIntervalMinutes, 15);
    assert.equal(config.chat.rawSessionSync, true);
    assert.equal(config.chat.autoUpload, false);
    assert.ok(config.policy.dangerouslyAllowedNames.includes("sessions"));
    assert.ok(config.policy.includedPaths.includes("sessions"));
    assert.ok(config.policy.includedPaths.includes("AGENTS.md"));
    assert.ok(config.policy.excludedPaths.includes("prompts/private.md"));
    assert.deepEqual(config.retention, {
      keepChatExports: 7,
      keepBackups: 4,
      maxAgeDays: 9,
      autoApply: true,
    });

    await harness.commands.get("sync-sessions").handler("off", harness.ctx);
    await harness.commands.get("sync-include").handler("auth.json", harness.ctx);
    const updated = JSON.parse(await readFile(path.join(piDir, "pi-sync-suite.json"), "utf8"));
    assert.equal(updated.chat.rawSessionSync, false);
    assert.ok(!updated.policy.dangerouslyAllowedNames.includes("sessions"));
    assert.ok(!updated.policy.includedPaths.includes("sessions"));
    assert.ok(!updated.policy.includedPaths.includes("auth.json"));
  } finally {
    restoreEnv("PI_CODING_AGENT_DIR", previousPiDir);
    await rm(root, { recursive: true, force: true });
  }
});

test("setup rejects unsafe or invalid inputs before git execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-setup-validation-"));
  const previousPiDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const piDir = path.join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = piDir;
    const extension = (await import("../dist/index.js")).default;
    const harness = createHarness();
    extension(harness.pi);

    await harness.commands.get("sync-setup").handler("https://github.com/team/pi-config.git 15", harness.ctx);
    await harness.commands.get("sync-setup").handler("git@example.com:team/pi-config.git 0", harness.ctx);

    await assert.rejects(() => readFile(path.join(piDir, "pi-sync-suite.json"), "utf8"), /ENOENT/);
    assert.equal(harness.execCalls, 0);
    assert.match(harness.notifications.join("\n"), /SSH git URL/);
    assert.match(harness.notifications.join("\n"), /positive number/);
  } finally {
    restoreEnv("PI_CODING_AGENT_DIR", previousPiDir);
    await rm(root, { recursive: true, force: true });
  }
});

function createHarness() {
  const commands = new Map();
  let execCalls = 0;
  const notifications = [];
  const ctx = {
    ui: {
      notify(message) {
        notifications.push(message);
      },
      setStatus() {},
      setWidget() {},
      input: async () => undefined,
      select: async (_title, options) => options[0],
      confirm: async () => true,
    },
  };
  const pi = {
    on() {},
    registerCommand(name, options) {
      commands.set(name, options);
    },
    exec: async () => {
      execCalls += 1;
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return {
    commands,
    ctx,
    get execCalls() {
      return execCalls;
    },
    notifications,
    pi,
  };
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
