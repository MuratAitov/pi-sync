import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
        "Chat History",
        "Resumable Sessions",
        "Chat History",
        "No Chat Sync",
        "Chat History",
        "Readable Archive",
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
      selects: ["Chat History", "Back", "Cancel"],
    });
    extension(harness.pi);

    await harness.commands.get("sync-settings").handler("", harness.ctx);

    const mainChoices = harness.selectCalls[0].choices.map(stripAnsi);
    assert.ok(mainChoices.some((choice) => /^View Status - current setup/.test(choice)));
    assert.ok(mainChoices.some((choice) => /^Sync Mode \[manual\].*push\/pull only when commanded/.test(choice)));
    assert.ok(mainChoices.some((choice) => /^Chat History \[off\].*skip chats/.test(choice)));
    assert.ok(mainChoices.some((choice) => /^Environment Tools \[manual\].*extra npm\/Pi tools/.test(choice)));
    assert.ok(mainChoices.some((choice) => /^Local Packages \[off\].*sync local package paths/.test(choice)));
    assert.ok(mainChoices.some((choice) => /^Diagnostics - doctor \/ diff \/ log/.test(choice)));
    assert.deepEqual(
      harness.selectCalls.map((call) => call.title),
      ["Pi Sync settings", "Chat history", "Pi Sync settings"],
    );
    assert.ok(harness.selectCalls[1].choices.map(stripAnsi).some((choice) => /^Resumable Sessions \[resume\].*raw private sessions/.test(choice)));
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
    const harness = createHarness({ selects: ["View Status"] });
    extension(harness.pi);

    await harness.commands.get("sync-settings").handler("", harness.ctx);

    assert.deepEqual(
      harness.selectCalls.map((call) => call.title),
      ["Pi Sync settings"],
    );
    assert.match(harness.notifications.join("\n"), /Pi Sync/);
    assert.match(harness.notifications.join("\n"), /Sync mode: manual - push\/pull only when commanded/);
    assert.match(harness.notifications.join("\n"), /Chat history: off - skip chats/);
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
      selects: ["Chat History", "Resumable Sessions", "Config Paths", "Manual Include", "Cancel"],
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

test("settings environment restore installs missing packages after confirmation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-settings-env-"));
  const previousPiDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const piDir = path.join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = piDir;
    const { createDefaultConfig, saveConfig } = await import("../dist/config/index.js");
    const { getDefaultPaths } = await import("../dist/utils/paths.js");
    const paths = getDefaultPaths(piDir);
    await saveConfig(createDefaultConfig("git@example.com:team/pi-config.git", paths), paths);
    await writeFile(
      path.join(piDir, "pi-sync-environment.json"),
      JSON.stringify({ npm: ["typescript@5.8.0"], pi: ["npm:@team/pi-extension"] }),
      "utf8",
    );

    const extension = (await import("../dist/index.js")).default;
    const execCalls = [];
    const harness = createHarness({
      selects: ["Environment", "Install Missing", "All Missing", "Cancel"],
      confirms: [true],
      exec: async (command, args) => {
        execCalls.push([command, args]);
        if (command === "npm" && args[0] === "ls") {
          return { code: 0, stdout: JSON.stringify({ dependencies: {} }), stderr: "" };
        }
        if (command === "pi" && args[0] === "list" && args[1] === "--json") {
          return { code: 0, stdout: JSON.stringify([]), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    extension(harness.pi);

    await harness.commands.get("sync-settings").handler("", harness.ctx);

    assert.ok(harness.selectCalls[0].choices.map(stripAnsi).some((choice) => /^Environment Tools \[manual\].*extra npm\/Pi tools/.test(choice)));
    assert.match(harness.notifications.join("\n"), /npm:typescript@5\.8\.0 \[missing\]/);
    assert.match(harness.notifications.join("\n"), /pi:npm:@team\/pi-extension \[missing\]/);
    assert.match(harness.notifications.join("\n"), /installed 2 environment package/);
    assert.deepEqual(execCalls.slice(-2), [
      ["npm", ["install", "-g", "typescript@5.8.0"]],
      ["pi", ["install", "npm:@team/pi-extension"]],
    ]);
  } finally {
    restoreEnv("PI_CODING_AGENT_DIR", previousPiDir);
    await rm(root, { recursive: true, force: true });
  }
});

test("settings can enable environment prompts and local package path sync", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-settings-package-flags-"));
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
      selects: ["Environment", "Auto Prompt", "Local Packages", "Cancel"],
      confirms: [true],
    });
    extension(harness.pi);

    await harness.commands.get("sync-settings").handler("", harness.ctx);

    const config = JSON.parse(await readFile(path.join(piDir, "pi-sync-suite.json"), "utf8"));
    assert.equal(config.environment.autoPromptAfterPull, true);
    assert.equal(config.policy.syncLocalPackagePaths, true);
    assert.match(harness.notifications.join("\n"), /environment tools auto prompt enabled/);
    assert.match(harness.notifications.join("\n"), /local package path sync enabled/);
  } finally {
    restoreEnv("PI_CODING_AGENT_DIR", previousPiDir);
    await rm(root, { recursive: true, force: true });
  }
});

test("manual pull offers environment restore and can install one selected package", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-pull-env-"));
  const previousPiDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const piDir = path.join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = piDir;
    const { createDefaultConfig, saveConfig } = await import("../dist/config/index.js");
    const { getDefaultPaths } = await import("../dist/utils/paths.js");
    const paths = getDefaultPaths(piDir);
    const config = createDefaultConfig("git@example.com:team/pi-config.git", paths);
    config.environment.autoPromptAfterPull = true;
    await saveConfig(config, paths);
    await writeFile(
      path.join(piDir, "pi-sync-environment.json"),
      JSON.stringify({ npm: ["typescript@5.8.0", "prettier"] }),
      "utf8",
    );

    const extension = (await import("../dist/index.js")).default;
    const execCalls = [];
    const harness = createHarness({
      selects: ["Install Missing", "npm:prettier"],
      confirms: [true],
      exec: async (command, args) => {
        execCalls.push([command, args]);
        if (command === "npm" && args[0] === "ls") {
          return { code: 0, stdout: JSON.stringify({ dependencies: {} }), stderr: "" };
        }
        if (command === "pi" && args[0] === "list" && args[1] === "--json") {
          return { code: 0, stdout: JSON.stringify([]), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    extension(harness.pi);

    await harness.commands.get("sync-pull").handler("", harness.ctx);

    assert.match(harness.notifications.join("\n"), /environment tool package\(s\) missing after manual pull/);
    assert.match(harness.notifications.join("\n"), /installed 1 environment package/);
    assert.deepEqual(execCalls.filter(([command, args]) => command === "npm" && args[0] === "install"), [
      ["npm", ["install", "-g", "prettier"]],
    ]);
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

test("setup failure rolls back config and explains SSH auth failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-setup-rollback-"));
  const previousPiDir = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;
  try {
    const piDir = path.join(root, "agent");
    process.env.PI_CODING_AGENT_DIR = piDir;
    process.env.HOME = path.join(root, "home");
    const extension = (await import("../dist/index.js")).default;
    const harness = createHarness({
      exec: async (command, args) => {
        if (command === "git" && args[0] === "clone") {
          return {
            code: 128,
            stdout: "",
            stderr: "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    extension(harness.pi);

    await harness.commands.get("sync-setup").handler("git@github.com:MuratAitov/pi-config.git 1440", harness.ctx);

    await assert.rejects(() => readFile(path.join(piDir, "pi-sync-suite.json"), "utf8"), /ENOENT/);
    assert.match(harness.notifications.join("\n"), /setup failed/);
    assert.match(harness.notifications.join("\n"), /ssh -T git@github\.com/);
    assert.match(harness.notifications.join("\n"), /No SSH public key was found/);
    assert.match(harness.notifications.join("\n"), /ssh-keygen -t ed25519/);
    assert.doesNotMatch(harness.notifications.join("\n"), /pi-sync configured:/);
  } finally {
    restoreEnv("PI_CODING_AGENT_DIR", previousPiDir);
    restoreEnv("HOME", previousHome);
    await rm(root, { recursive: true, force: true });
  }
});

test("setup failure points at an existing SSH public key when one is available", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-setup-keyhint-"));
  const previousPiDir = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;
  try {
    const piDir = path.join(root, "agent");
    const home = path.join(root, "home");
    process.env.PI_CODING_AGENT_DIR = piDir;
    process.env.HOME = home;
    await mkdir(path.join(home, ".ssh"), { recursive: true });
    await writeFile(path.join(home, ".ssh", "id_ed25519.pub"), "ssh-ed25519 AAAATEST pi-sync\n", "utf8");
    const extension = (await import("../dist/index.js")).default;
    const harness = createHarness({
      exec: async (command, args) => {
        if (command === "git" && args[0] === "clone") {
          return {
            code: 128,
            stdout: "",
            stderr: "git@github.com: Permission denied (publickey).",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    extension(harness.pi);

    await harness.commands.get("sync-setup").handler("git@github.com:MuratAitov/pi-config.git 1440", harness.ctx);

    assert.match(harness.notifications.join("\n"), /Found SSH public key: ~\/\.ssh\/id_ed25519\.pub/);
    assert.match(harness.notifications.join("\n"), /pbcopy < ~\/\.ssh\/id_ed25519\.pub/);
    assert.doesNotMatch(harness.notifications.join("\n"), /No SSH public key was found/);
  } finally {
    restoreEnv("PI_CODING_AGENT_DIR", previousPiDir);
    restoreEnv("HOME", previousHome);
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
    exec: async (command, args, execOptions) => {
      execCalls += 1;
      return options.exec ? options.exec(command, args, execOptions) : { code: 0, stdout: "", stderr: "" };
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
