import type { PiExecApi, PiSyncSuiteConfig, SyncSummary } from "../types.js";
import { getDefaultPaths } from "../utils/paths.js";
import { cloneIfMissing, commitAll, countIncomingCommits, fetch, pullFastForward, push } from "../git/client.js";
import { applySnapshot, stageSnapshot } from "../snapshot/index.js";
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
  const committed = await commitAll(pi, config.repoDir, `pi-sync-suite: ${new Date().toISOString()}`);
  if (!committed) {
    return { changed: false, message: "pi-sync: nothing to upload" };
  }
  await push(pi, config.repoDir);
  config.lastConfigSyncAt = new Date().toISOString();
  if (config.chat.autoUpload || config.chat.rawSessionSync) config.lastChatSyncAt = config.lastConfigSyncAt;
  await saveConfig(config, paths);
  return { changed: true, message: `pi-sync: uploaded ${staged.length} snapshot item(s)` };
}

export async function pullSnapshot(pi: PiExecApi, config: PiSyncSuiteConfig): Promise<SyncSummary> {
  const paths = getDefaultPaths();
  const cloned = await cloneIfMissing(pi, config.repoUrl, config.repoDir);
  if (cloned) {
    const backup = await createBackup(config, paths, "before applying initial clone");
    const applied = await applySnapshot(config, paths.piDir);
    config.lastConfigSyncAt = new Date().toISOString();
    if (config.chat.autoDownload || config.chat.rawSessionSync) config.lastChatSyncAt = config.lastConfigSyncAt;
    await saveConfig(config, paths);
    return {
      changed: true,
      message: `pi-sync: cloned remote, backed up ${backup.includedPaths.length} item(s), applied ${applied.length} item(s)`,
    };
  }
  await fetch(pi, config.repoDir);
  const incoming = await countIncomingCommits(pi, config.repoDir);
  if (incoming === 0) {
    return { changed: false, message: "pi-sync: already up to date" };
  }
  await pullFastForward(pi, config.repoDir);
  const backup = await createBackup(config, paths, `before applying ${incoming} remote commit(s)`);
  const applied = await applySnapshot(config, paths.piDir);
  config.lastConfigSyncAt = new Date().toISOString();
  if (config.chat.autoDownload || config.chat.rawSessionSync) config.lastChatSyncAt = config.lastConfigSyncAt;
  await saveConfig(config, paths);
  return {
    changed: true,
    message: `pi-sync: pulled ${incoming} commit(s), backed up ${backup.includedPaths.length} item(s), applied ${applied.length} item(s)`,
  };
}
