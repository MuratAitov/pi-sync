#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createDefaultConfig, saveConfig } from "../dist/config/index.js";
import { pushSnapshot, pullSnapshot } from "../dist/engine/syncEngine.js";
import { getDefaultPaths, timestampForFile } from "../dist/utils/paths.js";

const execFileAsync = promisify(execFile);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-two-pi-"));
  const branch = options.branch ?? `pi-sync-e2e-${timestampForFile().toLowerCase()}-${process.pid}`;
  let remoteUrl = options.remote ?? process.env.PI_SYNC_E2E_REMOTE;
  const useLocalRemote = options.local || !remoteUrl;
  const cleanupRemoteBranch = !useLocalRemote && !options.keepRemoteBranch;
  const previousPiDir = process.env.PI_CODING_AGENT_DIR;
  const previousGitEnv = snapshotGitEnv();

  try {
    if (useLocalRemote) {
      remoteUrl = path.join(root, "remote.git");
      await git(["init", "--bare", remoteUrl], { env: gitEnv() });
    }

    const deviceA = path.join(root, "device-a");
    const deviceB = path.join(root, "device-b");
    const messageA = `pi-sync-e2e device-a ${Date.now()}`;
    const messageB = `pi-sync-e2e device-b ${Date.now()}`;
    const sessionA = path.join("sessions", "--pi-sync-e2e--", `${timestampForFile()}_device-a.jsonl`);
    const sessionB = path.join("sessions", "--pi-sync-e2e--", `${timestampForFile()}_device-b.jsonl`);
    const pi = createPiExecApi({ branch });

    console.log(`Remote: ${remoteUrl}`);
    console.log(`Branch: ${branch}`);
    console.log(`Device A: ${deviceA}`);
    console.log(`Device B: ${deviceB}`);

    const configA = await createRawSessionConfig(deviceA, remoteUrl);
    const configB = await createRawSessionConfig(deviceB, remoteUrl);

    await writeSession(deviceA, sessionA, [
      { timestamp: new Date().toISOString(), role: "user", content: messageA },
    ]);

    await withPiDir(deviceA, () => pushSnapshot(pi, configA));
    console.log("A -> remote: pushed raw session snapshot");

    const pullToB = await withPiDir(deviceB, () => pullSnapshot(pi, configB));
    console.log(`remote -> B: ${pullToB.message}`);
    await assertContains(path.join(deviceB, sessionA), messageA, "Device B did not receive Device A session");
    console.log("B check: received Device A session");

    await writeSession(deviceB, sessionB, [
      { timestamp: new Date().toISOString(), role: "assistant", content: messageB },
    ]);

    await withPiDir(deviceB, () => pushSnapshot(pi, configB));
    console.log("B -> remote: pushed reply session snapshot");

    const pullToA = await withPiDir(deviceA, () => pullSnapshot(pi, configA));
    console.log(`remote -> A: ${pullToA.message}`);
    await assertContains(path.join(deviceA, sessionB), messageB, "Device A did not receive Device B session");
    console.log("A check: received Device B reply session");

    if (cleanupRemoteBranch) {
      await git(["-C", configA.repoDir, "push", "origin", "--delete", branch], { env: gitEnv() }).catch((error) => {
        console.warn(`Warning: could not delete remote branch ${branch}: ${error.message}`);
      });
    }

    console.log("");
    console.log("OK: two isolated Pi agent dirs exchanged raw session files through git.");
  } finally {
    restoreGitEnv(previousGitEnv);
    restoreEnv("PI_CODING_AGENT_DIR", previousPiDir);
    if (options.keep) {
      console.log(`Kept temp root: ${root}`);
    } else {
      await rm(root, { recursive: true, force: true });
    }
  }
}

function parseArgs(args) {
  const options = {
    branch: undefined,
    help: false,
    keep: false,
    keepRemoteBranch: false,
    local: false,
    remote: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--local") options.local = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--keep-remote-branch") options.keepRemoteBranch = true;
    else if (arg === "--remote") options.remote = requiredValue(args, ++index, "--remote");
    else if (arg === "--branch") options.branch = requiredValue(args, ++index, "--branch");
    else throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

async function createRawSessionConfig(piDir, remoteUrl) {
  process.env.PI_CODING_AGENT_DIR = piDir;
  const paths = getDefaultPaths(piDir);
  const config = createDefaultConfig(remoteUrl, paths);
  config.autoMode = "manual";
  config.chat.autoExport = false;
  config.chat.autoUpload = false;
  config.chat.autoDownload = false;
  config.chat.rawSessionSync = true;
  addUnique(config.policy.dangerouslyAllowedNames, "sessions");
  addUnique(config.policy.includedPaths, "sessions");
  await mkdir(piDir, { recursive: true });
  await writeFile(path.join(piDir, "settings.json"), `${JSON.stringify({ e2e: true }, null, 2)}\n`, "utf8");
  await saveConfig(config, paths);
  return config;
}

async function writeSession(piDir, portablePath, records) {
  const target = path.join(piDir, portablePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

async function assertContains(filePath, expected, message) {
  const actual = await readFile(filePath, "utf8");
  if (!actual.includes(expected)) {
    throw new Error(`${message}: ${filePath}`);
  }
}

async function withPiDir(piDir, fn) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = piDir;
    return await fn();
  } finally {
    restoreEnv("PI_CODING_AGENT_DIR", previous);
  }
}

function createPiExecApi({ branch }) {
  return {
    exec: async (command, args, options) => {
      try {
        const result = await execFileAsync(command, args, {
          cwd: options?.cwd,
          env: gitEnv(options?.env),
        });
        if (command === "git" && args[0] === "clone") {
          const repoDir = args[args.length - 1];
          await checkoutE2eBranch(repoDir, branch);
        }
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

async function checkoutE2eBranch(repoDir, branch) {
  const remoteBranch = await git(["-C", repoDir, "ls-remote", "--exit-code", "--heads", "origin", branch], {
    env: gitEnv(),
    reject: false,
  });

  if (remoteBranch.code === 0) {
    await git(["-C", repoDir, "fetch", "origin", branch], { env: gitEnv() });
    await git(["-C", repoDir, "checkout", "-B", branch, `origin/${branch}`], { env: gitEnv() });
    return;
  }

  await git(["-C", repoDir, "checkout", "--orphan", branch], { env: gitEnv() });
  await git(["-C", repoDir, "rm", "-rf", ".", "--ignore-unmatch"], { env: gitEnv(), reject: false });
  await git(["-C", repoDir, "clean", "-fdx"], { env: gitEnv(), reject: false });
}

async function git(args, options = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd: options.cwd,
      env: options.env ?? gitEnv(),
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const result = {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
    };
    if (options.reject === false) return result;
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

function gitEnv(extra = {}) {
  return {
    ...process.env,
    ...extra,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "Pi Sync E2E",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "pi-sync-e2e@example.invalid",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "Pi Sync E2E",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "pi-sync-e2e@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function snapshotGitEnv() {
  return {
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
  };
}

function restoreGitEnv(values) {
  for (const [name, value] of Object.entries(values)) {
    restoreEnv(name, value);
  }
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function addUnique(values, value) {
  if (!values.includes(value)) values.push(value);
  values.sort();
}

function printHelp() {
  console.log(`Usage:
  npm run e2e:two-pi-sessions -- --local
  npm run e2e:two-pi-sessions -- --remote git@github.com:you/private-test-repo.git

Options:
  --local                 Use a temporary local bare git remote. This is the default when no remote is provided.
  --remote <git-url>      Use a real remote, for example a private GitHub repo.
  --branch <name>         Use a specific remote branch. Defaults to pi-sync-e2e-<timestamp>-<pid>.
  --keep                  Keep temporary Pi agent dirs after the run.
  --keep-remote-branch    Do not delete the temporary remote branch after a successful GitHub run.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
