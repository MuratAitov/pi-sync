import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("extension exposes only the four product commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-command-surface-"));
  const previousPiDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
    const extension = (await import("../dist/index.js")).default;
    const harness = createHarness();
    extension(harness.pi);

    assert.deepEqual([...harness.commands.keys()].sort(), [
      "sync-pull",
      "sync-push",
      "sync-settings",
      "sync-setup",
    ]);
  } finally {
    restoreEnv("PI_CODING_AGENT_DIR", previousPiDir);
    await rm(root, { recursive: true, force: true });
  }
});

test("settings wizard mutates chat, path, mode, and cleanup policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-settings-"));
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
    const harness = createHarness({
      selects: [
        "Chat Sync",
        "Resume",
        "Chat Sync",
        "Off",
        "Chat Sync",
        "Archive",
        "Config Paths",
        "Include AGENTS.md",
        "Config Paths",
        "Manual Exclude",
        "Cleanup",
        "Retention",
        "Sync Mode",
        "Manual",
        "Cancel",
      ],
      inputs: ["prompts/private.md", "7", "4", "9"],
      confirms: [true, true],
    });
    extension(harness.pi);

    await harness.commands.get("sync-settings").handler("", harness.ctx);

    const config = JSON.parse(await readFile(path.join(piDir, "pi-sync-suite.json"), "utf8"));
    assert.equal(config.pullIntervalMinutes, 15);
    assert.equal(config.autoMode, "manual");
    assert.equal(config.chat.rawSessionSync, false);
    assert.equal(config.chat.autoExport, true);
    assert.equal(config.chat.autoUpload, true);
    assert.equal(config.chat.autoDownload, true);
    assert.ok(!config.policy.dangerouslyAllowedNames.includes("sessions"));
    assert.ok(!config.policy.includedPaths.includes("sessions"));
    assert.ok(config.policy.includedPaths.includes("AGENTS.md"));
    assert.ok(config.policy.excludedPaths.includes("prompts/private.md"));
    assert.deepEqual(config.retention, {
      keepChatExports: 7,
      keepBackups: 4,
      maxAgeDays: 9,
      autoApply: true,
    });
  } finally {
    restoreEnv("PI_CODING_AGENT_DIR", previousPiDir);
    await rm(root, { recursive: true, force: true });
  }
});

test("settings menu shows current values and submenu cancel returns to main menu", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-settings-labels-"));
  const previousPiDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const piDir = path.join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = piDir;
    const { createDefaultConfig, saveConfig } = await import("../dist/config/index.js");
    const { getDefaultPaths } = await import("../dist/utils/paths.js");
    const paths = getDefaultPaths(piDir);
    const config = createDefaultConfig("git@example.com:team/pi-config.git", paths);
    config.autoMode = "manual";
    await saveConfig(config, paths);

    const extension = (await import("../dist/index.js")).default;
    const harness = createHarness({
      selects: ["Chat Sync", "Cancel", "Cancel"],
    });
    extension(harness.pi);

    await harness.commands.get("sync-settings").handler("", harness.ctx);

    const mainChoices = harness.selectCalls[0].choices.map(stripAnsi);
    assert.ok(mainChoices.some((choice) => /^Status - show current setup/.test(choice)));
    assert.ok(mainChoices.some((choice) => /^Sync Mode \[manual\].*only syncs when you run push or pull/.test(choice)));
    assert.ok(mainChoices.some((choice) => /^Chat Sync \[off\].*chats are not synced/.test(choice)));
    assert.ok(mainChoices.some((choice) => /^Diagnostics - doctor, diff, and git log/.test(choice)));
    assert.deepEqual(
      harness.selectCalls.map((call) => call.title),
      ["Pi Sync settings", "Chat sync", "Pi Sync settings"],
    );
    assert.ok(harness.selectCalls[1].choices.map(stripAnsi).some((choice) => /^Resume \[resume\].*another Pi can resume/.test(choice)));
  } finally {
    restoreEnv("PI_CODING_AGENT_DIR", previousPiDir);
    await rm(root, { recursive: true, force: true });
  }
});

test("settings status shows status text and exits settings menu", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-settings-status-"));
  const previousPiDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const piDir = path.join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = piDir;
    const { createDefaultConfig, saveConfig } = await import("../dist/config/index.js");
    const { getDefaultPaths } = await import("../dist/utils/paths.js");
    const paths = getDefaultPaths(piDir);
    const config = createDefaultConfig("git@example.com:team/pi-config.git", paths);
    config.autoMode = "manual";
    await saveConfig(config, paths);

    const extension = (await import("../dist/index.js")).default;
    const harness = createHarness({ selects: ["Status"] });
    extension(harness.pi);

    await harness.commands.get("sync-settings").handler("", harness.ctx);

    assert.deepEqual(
      harness.selectCalls.map((call) => call.title),
      ["Pi Sync settings"],
    );
    assert.match(harness.notifications.join("\n"), /Pi Sync/);
    assert.match(harness.notifications.join("\n"), /Sync mode: manual - only syncs when you run push or pull/);
    assert.match(harness.notifications.join("\n"), /Chat sync: off - chats are not synced/);
  } finally {
    restoreEnv("PI_CODING_AGENT_DIR", previousPiDir);
    await rm(root, { recursive: true, force: true });
  }
});

test("settings refuses unsafe manual paths and cancelled resume sync", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-settings-safety-"));
  const previousPiDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const piDir = path.join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = piDir;
    const { createDefaultConfig, saveConfig } = await import("../dist/config/index.js");
    const { getDefaultPaths } = await import("../dist/utils/paths.js");
    const paths = getDefaultPaths(piDir);
    await saveConfig(createDefaultConfig("git@example.com:team/pi-config.git", paths), paths);

    const extension = (await import("../dist/index.js")).default;
    const harness = createHarness({
      selects: ["Chat Sync", "Resume", "Config Paths", "Manual Include", "Cancel"],
      inputs: ["auth.json"],
      confirms: [false],
    });
    extension(harness.pi);

    await harness.commands.get("sync-settings").handler("", harness.ctx);

    const config = JSON.parse(await readFile(path.join(piDir, "pi-sync-suite.json"), "utf8"));
    assert.equal(config.chat.rawSessionSync, false);
    assert.ok(!config.policy.includedPaths.includes("sessions"));
    assert.ok(!config.policy.includedPaths.includes("auth.json"));
    assert.match(harness.notifications.join("\n"), /resume chat sync cancelled/);
    assert.match(harness.notifications.join("\n"), /refusing unsafe path auth\.json/);
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

function createHarness(options = {}) {
  const commands = new Map();
  let execCalls = 0;
  const notifications = [];
  const selects = [...(options.selects ?? [])];
  const inputs = [...(options.inputs ?? [])];
  const confirms = [...(options.confirms ?? [])];
  const selectCalls = [];
  const ctx = {
    ui: {
      notify(message) {
        notifications.push(message);
      },
      setStatus() {},
      setWidget() {},
      input: async () => inputs.shift(),
      select: async (title, choices) => {
        selectCalls.push({ title, choices });
        const requested = selects.shift();
        if (requested !== undefined) {
          return choices.find((choice) => stripAnsi(choice).startsWith(requested)) ?? requested;
        }
        return choices.find((choice) => stripAnsi(choice).startsWith("Cancel")) ?? choices[0];
      },
      confirm: async () => confirms.shift() ?? true,
    },
  };
  const pi = {
    on() {},
    registerCommand(name, command) {
      commands.set(name, command);
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
    selectCalls,
    pi,
  };
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
