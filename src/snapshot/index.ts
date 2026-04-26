import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PiSyncSuiteConfig } from "../types.js";
import { ensureDir, pathExists, resolveInside } from "../utils/paths.js";
import { assertSafeSource, getPortableSyncPaths, scanForSecrets, shouldNeverSync } from "./policy.js";

export async function stageSnapshot(config: PiSyncSuiteConfig, piDir: string): Promise<string[]> {
  const changedPaths: string[] = [];
  await ensureDir(config.repoDir);

  for (const portablePath of getSnapshotPaths(config, config.chat.autoUpload)) {
    if (shouldNeverSync(portablePath, config.policy)) continue;
    const source = resolveInside(piDir, portablePath);
    const target = resolveInside(config.repoDir, portablePath);
    if (!(await pathExists(source))) {
      await fs.rm(target, { recursive: true, force: true });
      changedPaths.push(portablePath);
      continue;
    }
    await assertSafeSource(piDir, portablePath);
    await copySnapshotEntry(source, target, config, portablePath);
    changedPaths.push(portablePath);
  }

  await writeRepoGitignore(config);
  return changedPaths;
}

export async function applySnapshot(config: PiSyncSuiteConfig, piDir: string): Promise<string[]> {
  const applied: string[] = [];
  for (const portablePath of getSnapshotPaths(config, config.chat.autoDownload)) {
    if (shouldNeverSync(portablePath, config.policy)) continue;
    const source = resolveInside(config.repoDir, portablePath);
    if (!(await pathExists(source))) continue;
    const target = resolveInside(piDir, portablePath);
    if (portablePath === "settings.json") {
      await mergeSettings(source, target, config.policy.strippedSettingsKeys);
    } else {
      await replaceSnapshotEntry(source, target);
    }
    applied.push(portablePath);
  }
  return applied;
}

export function getSnapshotPaths(config: PiSyncSuiteConfig, includeChatExports: boolean): string[] {
  const paths = new Set(getPortableSyncPaths(config.policy));
  if (includeChatExports) paths.add("sync-suite-chat-exports");
  return [...paths].sort();
}

async function copySnapshotEntry(
  source: string,
  target: string,
  config: PiSyncSuiteConfig,
  portablePath: string,
): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to sync symlink: ${portablePath}`);
  if (stat.isDirectory()) {
    await fs.rm(target, { recursive: true, force: true });
    await copyDirectory(source, target, config);
    return;
  }
  if (portablePath === "settings.json") {
    await copySettings(source, target, config.policy.strippedSettingsKeys);
    return;
  }
  await copyFileWithSecretScan(source, target, config);
}

async function replaceSnapshotEntry(source: string, target: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isDirectory()) {
    await fs.rm(target, { recursive: true, force: true });
    await copyDirectory(source, target);
    return;
  }
  await ensureDir(path.dirname(target));
  await fs.copyFile(source, target);
}

async function copyDirectory(source: string, target: string, config?: PiSyncSuiteConfig): Promise<void> {
  await ensureDir(target);
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourceEntry = path.join(source, entry.name);
    const targetEntry = path.join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await copyDirectory(sourceEntry, targetEntry, config);
    } else if (entry.isFile()) {
      if (config) await copyFileWithSecretScan(sourceEntry, targetEntry, config);
      else {
        await ensureDir(path.dirname(targetEntry));
        await fs.copyFile(sourceEntry, targetEntry);
      }
    }
  }
}

async function copyFileWithSecretScan(source: string, target: string, config: PiSyncSuiteConfig): Promise<void> {
  if (isRawSessionPath(source) && config.chat.rawSessionSync) {
    await ensureDir(path.dirname(target));
    await fs.copyFile(source, target);
    return;
  }
  const hits = await scanForSecrets(source);
  if (hits.length > 0) {
    if (isChatExportPath(source)) {
      await recordSkippedSecret(config.repoDir, source, hits);
      return;
    }
    throw new Error(`Secret-like content detected in ${source}`);
  }
  await ensureDir(path.dirname(target));
  await fs.copyFile(source, target);
}

function isChatExportPath(filePath: string): boolean {
  return filePath.split(path.sep).includes("sync-suite-chat-exports");
}

function isRawSessionPath(filePath: string): boolean {
  return filePath.split(path.sep).includes("sessions");
}

async function recordSkippedSecret(repoDir: string, source: string, hits: string[]): Promise<void> {
  const reportPath = path.join(repoDir, "sync-suite-chat-exports", ".pi-sync-skipped-secrets.jsonl");
  await ensureDir(path.dirname(reportPath));
  const entry = {
    source,
    skippedAt: new Date().toISOString(),
    reason: "secret-like content detected",
    patterns: hits,
  };
  await fs.appendFile(reportPath, JSON.stringify(entry) + "\n", "utf8");
}

async function copySettings(source: string, target: string, stripKeys: string[]): Promise<void> {
  const settings = JSON.parse(await fs.readFile(source, "utf8")) as Record<string, unknown>;
  for (const key of stripKeys) delete settings[key];
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

async function mergeSettings(source: string, target: string, stripKeys: string[]): Promise<void> {
  const incoming = JSON.parse(await fs.readFile(source, "utf8")) as Record<string, unknown>;
  const local = (await pathExists(target))
    ? (JSON.parse(await fs.readFile(target, "utf8")) as Record<string, unknown>)
    : {};
  for (const key of stripKeys) delete incoming[key];
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, JSON.stringify({ ...local, ...incoming }, null, 2) + "\n", "utf8");
}

async function writeRepoGitignore(config: PiSyncSuiteConfig): Promise<void> {
  const lines = [
    "# Managed by pi-sync-suite",
    "",
    "# Secrets and machine-local state",
    ...config.policy.neverSyncNames.map((name) => `${name}${name.includes(".") ? "" : "/"}`),
    "",
    "*.log",
    ".DS_Store",
    "Thumbs.db",
  ];
  await fs.writeFile(path.join(config.repoDir, ".gitignore"), `${lines.join("\n")}\n`, "utf8");
}
