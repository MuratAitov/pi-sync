import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createDefaultConfig } from "../dist/config/index.js";
import { pushSnapshot, pullSnapshot } from "../dist/engine/syncEngine.js";
import { getDefaultPaths } from "../dist/utils/paths.js";

const execFileAsync = promisify(execFile);

test("initial clone applies remote snapshot into a clean Pi directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-initial-clone-"));
  const previousPiDir = process.env.PI_CODING_AGENT_DIR;
  const previousAuthorName = process.env.GIT_AUTHOR_NAME;
  const previousAuthorEmail = process.env.GIT_AUTHOR_EMAIL;
  const previousCommitterName = process.env.GIT_COMMITTER_NAME;
  const previousCommitterEmail = process.env.GIT_COMMITTER_EMAIL;

  try {
    process.env.GIT_AUTHOR_NAME = "Pi Sync Test";
    process.env.GIT_AUTHOR_EMAIL = "pi-sync@example.invalid";
    process.env.GIT_COMMITTER_NAME = "Pi Sync Test";
    process.env.GIT_COMMITTER_EMAIL = "pi-sync@example.invalid";

    const remoteDir = path.join(root, "remote.git");
    await execFileAsync("git", ["init", "--bare", remoteDir]);
    const pi = createExecApi();

    const sourcePiDir = path.join(root, "source-agent");
    process.env.PI_CODING_AGENT_DIR = sourcePiDir;
    const sourcePaths = getDefaultPaths();
    const sourceConfig = createDefaultConfig(remoteDir, sourcePaths);
    sourceConfig.chat.autoUpload = false;
    await mkdir(sourcePiDir, { recursive: true });
    await writeFile(
      path.join(sourcePiDir, "settings.json"),
      JSON.stringify({ theme: "dark", packages: ["npm:pi-lens"] }),
      "utf8",
    );
    await writeFile(path.join(sourcePiDir, "keybindings.json"), JSON.stringify({ save: "ctrl+s" }), "utf8");
    await pushSnapshot(pi, sourceConfig);

    const targetPiDir = path.join(root, "target-agent");
    process.env.PI_CODING_AGENT_DIR = targetPiDir;
    const targetPaths = getDefaultPaths();
    const targetConfig = createDefaultConfig(remoteDir, targetPaths);
    targetConfig.chat.autoDownload = false;

    const summary = await pullSnapshot(pi, targetConfig);

    assert.equal(summary.changed, true);
    assert.match(summary.message, /cloned remote/);
    assert.match(summary.message, /packages changed; reload Pi/);
    assert.deepEqual(JSON.parse(await readFile(path.join(targetPiDir, "settings.json"), "utf8")), {
      theme: "dark",
      packages: ["npm:pi-lens"],
    });
    assert.deepEqual(JSON.parse(await readFile(path.join(targetPiDir, "keybindings.json"), "utf8")), {
      save: "ctrl+s",
    });
  } finally {
    restoreEnv("PI_CODING_AGENT_DIR", previousPiDir);
    restoreEnv("GIT_AUTHOR_NAME", previousAuthorName);
    restoreEnv("GIT_AUTHOR_EMAIL", previousAuthorEmail);
    restoreEnv("GIT_COMMITTER_NAME", previousCommitterName);
    restoreEnv("GIT_COMMITTER_EMAIL", previousCommitterEmail);
    await rm(root, { recursive: true, force: true });
  }
});

test("push integrates remote commits before retrying non-fast-forward upload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-push-integrates-"));
  const previousPiDir = process.env.PI_CODING_AGENT_DIR;
  const previousAuthorName = process.env.GIT_AUTHOR_NAME;
  const previousAuthorEmail = process.env.GIT_AUTHOR_EMAIL;
  const previousCommitterName = process.env.GIT_COMMITTER_NAME;
  const previousCommitterEmail = process.env.GIT_COMMITTER_EMAIL;

  try {
    process.env.GIT_AUTHOR_NAME = "Pi Sync Test";
    process.env.GIT_AUTHOR_EMAIL = "pi-sync@example.invalid";
    process.env.GIT_COMMITTER_NAME = "Pi Sync Test";
    process.env.GIT_COMMITTER_EMAIL = "pi-sync@example.invalid";

    const remoteDir = path.join(root, "remote.git");
    await execFileAsync("git", ["init", "--bare", remoteDir]);
    const pi = createExecApi();

    const sourcePiDir = path.join(root, "source-agent");
    process.env.PI_CODING_AGENT_DIR = sourcePiDir;
    const sourcePaths = getDefaultPaths();
    const sourceConfig = createDefaultConfig(remoteDir, sourcePaths);
    await mkdir(sourcePiDir, { recursive: true });
    await writeFile(path.join(sourcePiDir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    await pushSnapshot(pi, sourceConfig);

    const targetPiDir = path.join(root, "target-agent");
    process.env.PI_CODING_AGENT_DIR = targetPiDir;
    const targetPaths = getDefaultPaths();
    const targetConfig = createDefaultConfig(remoteDir, targetPaths);
    await pullSnapshot(pi, targetConfig);
    await writeFile(path.join(targetPiDir, "keybindings.json"), JSON.stringify({ save: "cmd+s" }), "utf8");

    process.env.PI_CODING_AGENT_DIR = sourcePiDir;
    await mkdir(path.join(sourcePiDir, "prompts"), { recursive: true });
    await writeFile(path.join(sourcePiDir, "prompts", "remote.md"), "Remote prompt\n", "utf8");
    await pushSnapshot(pi, sourceConfig);

    process.env.PI_CODING_AGENT_DIR = targetPiDir;
    const summary = await pushSnapshot(pi, targetConfig);

    assert.equal(summary.changed, true);
    assert.match(summary.message, /integrated remote changes/);
    assert.deepEqual(JSON.parse(await readFile(path.join(targetPiDir, "keybindings.json"), "utf8")), {
      save: "cmd+s",
    });
    assert.equal(await readFile(path.join(targetPiDir, "prompts", "remote.md"), "utf8"), "Remote prompt\n");
    assert.equal(await readFile(path.join(targetPaths.repoDir, "prompts", "remote.md"), "utf8"), "Remote prompt\n");
  } finally {
    restoreEnv("PI_CODING_AGENT_DIR", previousPiDir);
    restoreEnv("GIT_AUTHOR_NAME", previousAuthorName);
    restoreEnv("GIT_AUTHOR_EMAIL", previousAuthorEmail);
    restoreEnv("GIT_COMMITTER_NAME", previousCommitterName);
    restoreEnv("GIT_COMMITTER_EMAIL", previousCommitterEmail);
    await rm(root, { recursive: true, force: true });
  }
});

function createExecApi() {
  return {
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
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
