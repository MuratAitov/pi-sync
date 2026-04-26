import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CleanupCandidate, PiSyncSuiteConfig, SyncPaths } from "./types.js";
import { pathExists } from "./paths.js";

export async function planCleanup(
  config: PiSyncSuiteConfig,
  paths: SyncPaths,
): Promise<CleanupCandidate[]> {
  const candidates = [
    ...(await oldFiles(paths.chatExportDir, config.retention.keepChatExports, config.retention.maxAgeDays)),
    ...(await oldFiles(paths.backupDir, config.retention.keepBackups, config.retention.maxAgeDays)),
  ];
  return candidates.sort((left, right) => (left.modifiedAt ?? "").localeCompare(right.modifiedAt ?? ""));
}

export async function applyCleanup(candidates: CleanupCandidate[]): Promise<number> {
  let deleted = 0;
  for (const candidate of candidates) {
    await fs.rm(candidate.path, { recursive: true, force: true });
    deleted += 1;
  }
  return deleted;
}

async function oldFiles(root: string, keepCount: number, maxAgeDays: number): Promise<CleanupCandidate[]> {
  if (!(await pathExists(root))) return [];
  const files = await listFiles(root);
  const newestFirst = files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const keep = new Set(newestFirst.slice(Math.max(0, keepCount)).map((file) => file.path));
  const cutoffMs = Date.now() - Math.max(1, maxAgeDays) * 24 * 60 * 60 * 1000;
  return newestFirst
    .filter((file) => !keep.has(file.path) || file.mtimeMs < cutoffMs)
    .map((file) => ({
      path: file.path,
      reason: !keep.has(file.path) ? `exceeds newest ${keepCount} files` : `older than ${maxAgeDays} days`,
      sizeBytes: file.size,
      modifiedAt: new Date(file.mtimeMs).toISOString(),
    }));
}

async function listFiles(root: string): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
    } else if (entry.isFile()) {
      const stat = await fs.stat(fullPath);
      files.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return files;
}
