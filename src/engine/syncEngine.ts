import * as path from "node:path";
import type { PiExecApi, PiSyncSuiteConfig, SyncSummary } from "../types.js";
import { getDefaultPaths } from "../utils/paths.js";
import {
  cloneIfMissing,
  commitAll,
  countIncomingCommits,
  fetch,
  isNonFastForwardPush,
  pullFastForward,
  pullRebase,
  push,
  pushResult,
} from "../git/client.js";
import { applySnapshot, packageListsDiffer, readSettingsPackages, stageSnapshot } from "../snapshot/index.js";
import { saveConfig } from "../config/index.js";
import { exportPiChats } from "../chat/index.js";
import { createBackup } from "../backup/index.js";

export async function pushSnapshot(pi: PiExecApi, config: PiSyncSuiteConfig): Promise<SyncSummary> {
  const paths = getDefaultPaths();
  await cloneIfMissing(pi, config.repoUrl, config.repoDir);
  if (config.chat.autoExport && config.chat.autoUpload) {
    await exportPiChats({ piDir: paths.piDir, exportsDir: paths.chatExportDir });
  }
  const staged = await stageSnapshot(config, paths.piDir);
  const committed = await commitAll(pi, config.repoDir, `pi-sync: ${new Date().toISOString()}`);
  if (!committed) {
    return { changed: false, message: "pi-sync: nothing to upload" };
  }
  const pushSummary = await pushWithRemoteIntegration(pi, config, staged.length);
  config.lastConfigSyncAt = new Date().toISOString();
  if (config.chat.autoUpload || config.chat.rawSessionSync) config.lastChatSyncAt = config.lastConfigSyncAt;
  await saveConfig(config, paths);
  return { changed: true, message: pushSummary };
}

export async function pullSnapshot(pi: PiExecApi, config: PiSyncSuiteConfig): Promise<SyncSummary> {
  const paths = getDefaultPaths();
  const cloned = await cloneIfMissing(pi, config.repoUrl, config.repoDir);
  if (cloned) {
    const settingsPath = path.join(paths.piDir, "settings.json");
    const packagesBefore = await readSettingsPackages(settingsPath);
    const backup = await createBackup(config, paths, "before applying initial clone");
    const applied = await applySnapshot(config, paths.piDir);
    const packagesAfter = await readSettingsPackages(settingsPath);
    config.lastConfigSyncAt = new Date().toISOString();
    if (config.chat.autoDownload || config.chat.rawSessionSync) config.lastChatSyncAt = config.lastConfigSyncAt;
    await saveConfig(config, paths);
    return {
      changed: true,
      message: appendReloadNotice(
        `pi-sync: cloned remote, backed up ${backup.includedPaths.length} item(s), applied ${applied.length} item(s)`,
        applied,
        packagesBefore,
        packagesAfter,
      ),
    };
  }
  await fetch(pi, config.repoDir);
  const incoming = await countIncomingCommits(pi, config.repoDir);
  if (incoming === 0) {
    return { changed: false, message: "pi-sync: already up to date" };
  }
  await pullFastForward(pi, config.repoDir);
  const settingsPath = path.join(paths.piDir, "settings.json");
  const packagesBefore = await readSettingsPackages(settingsPath);
  const backup = await createBackup(config, paths, `before applying ${incoming} remote commit(s)`);
  const applied = await applySnapshot(config, paths.piDir);
  const packagesAfter = await readSettingsPackages(settingsPath);
  config.lastConfigSyncAt = new Date().toISOString();
  if (config.chat.autoDownload || config.chat.rawSessionSync) config.lastChatSyncAt = config.lastConfigSyncAt;
  await saveConfig(config, paths);
  return {
    changed: true,
    message: appendReloadNotice(
      `pi-sync: pulled ${incoming} commit(s), backed up ${backup.includedPaths.length} item(s), applied ${applied.length} item(s)`,
      applied,
      packagesBefore,
      packagesAfter,
    ),
  };
}

async function pushWithRemoteIntegration(
  pi: PiExecApi,
  config: PiSyncSuiteConfig,
  stagedCount: number,
): Promise<string> {
  const paths = getDefaultPaths();
  const firstPush = await pushResult(pi, config.repoDir);
  if (firstPush.ok) {
    return `pi-sync: uploaded ${stagedCount} snapshot item(s)`;
  }
  if (!isNonFastForwardPush(firstPush.stderr)) {
    throw new Error(firstPush.stderr.trim() || "git push failed");
  }

  await fetch(pi, config.repoDir);
  try {
    await pullRebase(pi, config.repoDir);
  } catch (error) {
    throw new Error(
      [
        "Remote has changes that could not be integrated automatically.",
        "Run /sync-pull to inspect/apply remote changes, resolve any conflicts, then run /sync-push again.",
        error instanceof Error ? error.message : String(error),
      ].join("\n"),
    );
  }

  const backup = await createBackup(config, paths, "before applying remote changes during push retry");
  const applied = await applySnapshot(config, paths.piDir);
  await push(pi, config.repoDir);
  return `pi-sync: integrated remote changes, backed up ${backup.includedPaths.length} item(s), applied ${applied.length} item(s), uploaded ${stagedCount} snapshot item(s)`;
}

function appendReloadNotice(message: string, applied: string[], packagesBefore: string[], packagesAfter: string[]): string {
  if (applied.includes("settings.json") && packageListsDiffer(packagesBefore, packagesAfter)) {
    return `${message}\npi-sync: packages changed; reload Pi to load extension changes`;
  }
  return message;
}
