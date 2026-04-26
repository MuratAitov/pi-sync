import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BackupManifest, PiSyncSuiteConfig, SyncPaths } from "./types.js";
import { ensureDir, pathExists, resolveInside, timestampForFile } from "./paths.js";
import { getSnapshotPaths } from "./snapshot.js";

const MANIFEST_FILE = "manifest.json";

export async function createBackup(
  config: PiSyncSuiteConfig,
  paths: SyncPaths,
  reason: string,
): Promise<BackupManifest> {
  const id = timestampForFile();
  const backupRoot = path.join(paths.backupDir, id);
  const filesDir = path.join(backupRoot, "files");
  const includedPaths: string[] = [];
  await ensureDir(filesDir);

  for (const portablePath of getSnapshotPaths(config, config.chat.autoDownload)) {
    const source = resolveInside(paths.piDir, portablePath);
    if (!(await pathExists(source))) continue;
    const target = resolveInside(filesDir, portablePath);
    await copyEntry(source, target);
    includedPaths.push(portablePath);
  }

  const manifest: BackupManifest = {
    id,
    createdAt: new Date().toISOString(),
    reason,
    piDir: paths.piDir,
    filesDir,
    includedPaths,
  };
  await fs.writeFile(path.join(backupRoot, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

export async function listBackups(paths: SyncPaths): Promise<BackupManifest[]> {
  if (!(await pathExists(paths.backupDir))) return [];
  const entries = await fs.readdir(paths.backupDir, { withFileTypes: true });
  const manifests: BackupManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(paths.backupDir, entry.name, MANIFEST_FILE);
    if (!(await pathExists(manifestPath))) continue;
    manifests.push(JSON.parse(await fs.readFile(manifestPath, "utf8")) as BackupManifest);
  }
  return manifests.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function restoreBackup(
  paths: SyncPaths,
  idOrLatest = "latest",
): Promise<BackupManifest | null> {
  const backups = await listBackups(paths);
  const manifest = idOrLatest === "latest" ? backups[0] : backups.find((backup) => backup.id === idOrLatest);
  if (!manifest) return null;

  for (const portablePath of manifest.includedPaths) {
    const source = resolveInside(manifest.filesDir, portablePath);
    const target = resolveInside(paths.piDir, portablePath);
    if (await pathExists(source)) {
      await copyEntry(source, target);
    }
  }
  return manifest;
}

async function copyEntry(source: string, target: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.rm(target, { recursive: true, force: true });
    await ensureDir(target);
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      await copyEntry(path.join(source, entry.name), path.join(target, entry.name));
    }
    return;
  }
  await ensureDir(path.dirname(target));
  await fs.copyFile(source, target);
}
