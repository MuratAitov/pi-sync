import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("extension setup can push to a fresh local bare git remote", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-extension-"));
  const previousPiDir = process.env.PI_CODING_AGENT_DIR;
  const previousAuthorName = process.env.GIT_AUTHOR_NAME;
  const previousAuthorEmail = process.env.GIT_AUTHOR_EMAIL;
  const previousCommitterName = process.env.GIT_COMMITTER_NAME;
  const previousCommitterEmail = process.env.GIT_COMMITTER_EMAIL;

  try {
    const piDir = path.join(root, "agent");
    const remoteDir = path.join(root, "remote.git");
    process.env.PI_CODING_AGENT_DIR = piDir;
    process.env.GIT_AUTHOR_NAME = "Pi Sync Suite Test";
    process.env.GIT_AUTHOR_EMAIL = "pi-sync-suite@example.invalid";
    process.env.GIT_COMMITTER_NAME = "Pi Sync Suite Test";
    process.env.GIT_COMMITTER_EMAIL = "pi-sync-suite@example.invalid";

    await mkdir(path.join(piDir, "sessions", "2026"), { recursive: true });
    await mkdir(path.join(piDir, "prompts"), { recursive: true });
    await writeFile(
      path.join(piDir, "settings.json"),
      JSON.stringify({ theme: "dark", lastChangelogVersion: "local-only" }, null, 2),
      "utf8",
    );
    await writeFile(path.join(piDir, "keybindings.json"), JSON.stringify({ save: "ctrl+s" }), "utf8");
    await writeFile(path.join(piDir, "prompts", "daily.md"), "Ship it.\n", "utf8");
    await writeFile(
      path.join(piDir, "sessions", "2026", "demo.jsonl"),
      `${JSON.stringify({ role: "user", content: "hello" })}\n`,
      "utf8",
    );
    await execFileAsync("git", ["init", "--bare", remoteDir]);

    const extension = (await import("../dist/index.js")).default;
    const harness = createHarness({ selects: ["Chat Sync", "Archive"] });
    extension(harness.pi);

    await harness.commands.get("sync-setup").handler(`${remoteDir} 1440`, harness.ctx);
    await harness.commands.get("sync-settings").handler("", harness.ctx);
    await harness.commands.get("sync-push").handler("", harness.ctx);
    await harness.events.get("session_shutdown")?.({}, harness.ctx);

    const config = JSON.parse(await readFile(path.join(piDir, "pi-sync-suite.json"), "utf8"));
    assert.equal(config.repoUrl, remoteDir);
    assert.equal(config.autoMode, "full-auto");

    const repoSettings = JSON.parse(await readFile(path.join(piDir, "sync-suite-repo", "settings.json"), "utf8"));
    assert.deepEqual(repoSettings, { theme: "dark" });
    assert.match(
      await readFile(path.join(piDir, "sync-suite-repo", "sync-suite-chat-exports", "2026__demo.md"), "utf8"),
      /hello/,
    );

    const remoteLog = await execFileAsync("git", ["--git-dir", remoteDir, "log", "--oneline"]);
    assert.match(remoteLog.stdout, /pi-sync-suite:/);

    const notifications = harness.notifications.join("\n");
    assert.match(notifications, /pi-sync configured/);
    assert.match(notifications, /chat sync set to Archive/);
  } finally {
    restoreEnv("PI_CODING_AGENT_DIR", previousPiDir);
    restoreEnv("GIT_AUTHOR_NAME", previousAuthorName);
    restoreEnv("GIT_AUTHOR_EMAIL", previousAuthorEmail);
    restoreEnv("GIT_COMMITTER_NAME", previousCommitterName);
    restoreEnv("GIT_COMMITTER_EMAIL", previousCommitterEmail);
    await rm(root, { recursive: true, force: true });
  }
});

function createHarness(options = {}) {
  const commands = new Map();
  const events = new Map();
  const notifications = [];
  const selects = [...(options.selects ?? [])];
  const ctx = {
    ui: {
      notify(message) {
        notifications.push(message);
      },
      setStatus() {},
      setWidget() {},
      input: async () => undefined,
      select: async (_title, choices) => selects.shift() ?? choices[0],
      confirm: async () => true,
    },
  };
  const pi = {
    on(name, handler) {
      events.set(name, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    exec: async (command, args, options) => {
      try {
        const result = await execFileAsync(command, args, {
          cwd: options?.cwd,
          env: options?.env,
        });
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        return {
          code: typeof error.code === "number" ? error.code : 1,
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? error.message,
        };
      }
    },
  };
  return { commands, ctx, events, notifications, pi };
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
