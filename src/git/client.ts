import type { PiExecApi } from "../types.js";

export interface GitExecOptions {
  repoDir?: string;
}

function gitEnv(): NodeJS.ProcessEnv {
  const authorName = process.env.GIT_AUTHOR_NAME || process.env.GIT_COMMITTER_NAME || "Pi Sync";
  const authorEmail = process.env.GIT_AUTHOR_EMAIL || process.env.GIT_COMMITTER_EMAIL || "pi-sync@local.invalid";
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || authorName,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || authorEmail,
  };
}

export async function cloneIfMissing(pi: PiExecApi, repoUrl: string, repoDir: string): Promise<boolean> {
  const { pathExists } = await import("../utils/paths.js");
  const gitDir = await import("node:path").then((path) => path.join(repoDir, ".git"));
  if (await pathExists(gitDir)) return false;
  const result = await pi.exec("git", ["clone", repoUrl, repoDir], { env: gitEnv() });
  assertOk(result, "git clone failed");
  return true;
}

export async function statusPorcelain(pi: PiExecApi, repoDir: string): Promise<string> {
  const result = await pi.exec("git", ["-C", repoDir, "status", "--porcelain"], {
    env: gitEnv(),
  });
  assertOk(result, "git status failed");
  return result.stdout;
}

export async function commitAll(pi: PiExecApi, repoDir: string, message: string): Promise<boolean> {
  const status = await statusPorcelain(pi, repoDir);
  if (!status.trim()) return false;
  assertOk(await pi.exec("git", ["-C", repoDir, "add", "-A"], { env: gitEnv() }), "git add failed");
  assertOk(
    await pi.exec("git", ["-C", repoDir, "commit", "-m", message], { env: gitEnv() }),
    "git commit failed",
  );
  return true;
}

export async function push(pi: PiExecApi, repoDir: string): Promise<void> {
  assertOk(await pi.exec("git", ["-C", repoDir, "push", "-u", "origin", "HEAD"], { env: gitEnv() }), "git push failed");
}

export async function pushResult(pi: PiExecApi, repoDir: string): Promise<{ ok: boolean; stderr: string }> {
  const result = await pi.exec("git", ["-C", repoDir, "push", "-u", "origin", "HEAD"], { env: gitEnv() });
  return { ok: result.code === 0, stderr: result.stderr };
}

export async function fetch(pi: PiExecApi, repoDir: string): Promise<void> {
  assertOk(await pi.exec("git", ["-C", repoDir, "fetch", "--quiet"], { env: gitEnv() }), "git fetch failed");
}

export async function countIncomingCommits(pi: PiExecApi, repoDir: string): Promise<number> {
  if (!(await hasLocalHead(pi, repoDir))) return 0;
  if (!(await hasUpstream(pi, repoDir))) return 0;
  const result = await pi.exec("git", ["-C", repoDir, "rev-list", "HEAD..@{u}", "--count"], {
    env: gitEnv(),
  });
  assertOk(result, "git rev-list failed");
  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(count) ? count : 0;
}

async function hasLocalHead(pi: PiExecApi, repoDir: string): Promise<boolean> {
  const result = await pi.exec("git", ["-C", repoDir, "rev-parse", "--verify", "HEAD"], {
    env: gitEnv(),
  });
  return result.code === 0;
}

async function hasUpstream(pi: PiExecApi, repoDir: string): Promise<boolean> {
  const result = await pi.exec(
    "git",
    ["-C", repoDir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { env: gitEnv() },
  );
  return result.code === 0;
}

export async function pullFastForward(pi: PiExecApi, repoDir: string): Promise<void> {
  assertOk(
    await pi.exec("git", ["-C", repoDir, "pull", "--ff-only"], { env: gitEnv() }),
    "git pull --ff-only failed",
  );
}

export async function pullRebase(pi: PiExecApi, repoDir: string): Promise<void> {
  const result = await pi.exec("git", ["-C", repoDir, "pull", "--rebase"], { env: gitEnv() });
  if (result.code !== 0) {
    await pi.exec("git", ["-C", repoDir, "rebase", "--abort"], { env: gitEnv() });
    throw new Error(result.stderr?.trim() || "git pull --rebase failed");
  }
}

export function isNonFastForwardPush(stderr: string): boolean {
  return /non-fast-forward|fetch first|rejected.*HEAD|Updates were rejected/i.test(stderr);
}

export async function diffStat(pi: PiExecApi, repoDir: string): Promise<string> {
  const result = await pi.exec("git", ["-C", repoDir, "diff", "--stat"], { env: gitEnv() });
  assertOk(result, "git diff failed");
  return result.stdout.trim();
}

export async function logOneline(pi: PiExecApi, repoDir: string, count = 8): Promise<string> {
  const result = await pi.exec("git", ["-C", repoDir, "log", "--oneline", `-${count}`], { env: gitEnv() });
  assertOk(result, "git log failed");
  return result.stdout.trim();
}

function assertOk(result: { code: number; stderr?: string }, fallback: string): void {
  if (result.code !== 0) {
    throw new Error(result.stderr?.trim() || fallback);
  }
}
