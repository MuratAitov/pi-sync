import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PiSyncSuiteConfig, SyncPaths } from "../types.js";
import { pathExists, resolveInside } from "../utils/paths.js";
import { getSnapshotPaths } from "../snapshot/index.js";

export async function createSnapshotFingerprint(
  config: PiSyncSuiteConfig,
  paths: SyncPaths,
): Promise<string> {
  const rows: string[] = [];
  for (const portablePath of getSnapshotPaths(config, config.chat.autoUpload)) {
    const absolute = resolveInside(paths.piDir, portablePath);
    if (!(await pathExists(absolute))) {
      rows.push(`${portablePath}:missing`);
      continue;
    }
    await collectFingerprintRows(absolute, portablePath, rows);
  }
  return rows.sort().join("\n");
}

async function collectFingerprintRows(absolute: string, portablePath: string, rows: string[]): Promise<void> {
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) {
    rows.push(`${portablePath}:symlink`);
    return;
  }
  if (stat.isDirectory()) {
    rows.push(`${portablePath}:dir`);
    for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
      await collectFingerprintRows(path.join(absolute, entry.name), `${portablePath}/${entry.name}`, rows);
    }
    return;
  }
  if (stat.isFile()) {
    rows.push(`${portablePath}:file:${stat.size}:${Math.trunc(stat.mtimeMs)}`);
  }
}
