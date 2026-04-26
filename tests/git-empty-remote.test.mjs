import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { cloneIfMissing, countIncomingCommits } from "../dist/git/client.js";

const execFileAsync = promisify(execFile);

test("empty cloned remote has no incoming commits instead of throwing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-empty-remote-"));
  try {
    const remoteDir = path.join(root, "remote.git");
    const cloneDir = path.join(root, "clone");
    await execFileAsync("git", ["init", "--bare", remoteDir]);
    const pi = createExecApi();

    await cloneIfMissing(pi, remoteDir, cloneDir);

    assert.equal(await countIncomingCommits(pi, cloneDir), 0);
  } finally {
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
