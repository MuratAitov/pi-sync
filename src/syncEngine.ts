import type { PiExecApi, PiSyncSuiteConfig, SyncSummary } from "./types.js";
import { getDefaultPaths } from "./paths.js";
import { cloneIfMissing, commitAll, countIncomingCommits, fetch, pullFastForward, push } from "./git.js";
import { applySnapshot, stageSnapshot } from "./snapshot.js";
import { saveConfig } from "./config.js";
import { exportPiChats } from "./chat/index.js";

export async function pushSnapshot(pi: PiExecApi, config: PiSyncSuiteConfig): Promise<SyncSummary> {
  const paths = getDefaultPaths();
  await cloneIfMissing(pi, config.repoUrl, config.repoDir);
  if (config.autoMode === "full-auto" && config.chat.autoExport && config.chat.autoUpload) {
    await exportPiChats({ piDir: paths.piDir, exportsDir: paths.chatExportDir });
  }
  const staged = await stageSnapshot(config, paths.piDir);
  const committed = await commitAll(pi, config.repoDir, `pi-sync-suite: ${new Date().toISOString()}`);
  if (!committed) {
    return { changed: false, message: "pi-sync: nothing to upload" };
  }
  await push(pi, config.repoDir);
  config.lastConfigSyncAt = new Date().toISOString();
  if (config.chat.autoUpload) config.lastChatSyncAt = config.lastConfigSyncAt;
  await saveConfig(config, paths);
  return { changed: true, message: `pi-sync: uploaded ${staged.length} snapshot item(s)` };
}

export async function pullSnapshot(pi: PiExecApi, config: PiSyncSuiteConfig): Promise<SyncSummary> {
  const paths = getDefaultPaths();
  await cloneIfMissing(pi, config.repoUrl, config.repoDir);
  await fetch(pi, config.repoDir);
  const incoming = await countIncomingCommits(pi, config.repoDir);
  if (incoming === 0) {
    return { changed: false, message: "pi-sync: already up to date" };
  }
  await pullFastForward(pi, config.repoDir);
  const applied = await applySnapshot(config, paths.piDir);
  config.lastConfigSyncAt = new Date().toISOString();
  if (config.chat.autoDownload) config.lastChatSyncAt = config.lastConfigSyncAt;
  await saveConfig(config, paths);
  return { changed: true, message: `pi-sync: pulled ${incoming} commit(s), applied ${applied.length} item(s)` };
}
