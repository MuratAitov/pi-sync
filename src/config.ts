import * as fs from "node:fs/promises";
import { DEFAULT_POLICY } from "./policy.js";
import { getDefaultPaths, pathExists } from "./paths.js";
import type { PiSyncSuiteConfig, SyncPaths } from "./types.js";

export const CONFIG_VERSION = 1;

export function createDefaultConfig(repoUrl: string, paths: SyncPaths = getDefaultPaths()): PiSyncSuiteConfig {
  return {
    version: CONFIG_VERSION,
    repoUrl,
    repoDir: paths.repoDir,
    autoMode: "full-auto",
    pullIntervalMinutes: 1440,
    pushDebounceMs: 2500,
    chat: {
      autoExport: true,
      autoUpload: true,
      autoDownload: true,
      exportFormat: "both",
      includeMetadata: true,
    },
    retention: {
      keepChatExports: 100,
      keepBackups: 20,
      maxAgeDays: 180,
      autoApply: false,
    },
    policy: DEFAULT_POLICY,
  };
}

export async function loadConfig(paths: SyncPaths = getDefaultPaths()): Promise<PiSyncSuiteConfig | null> {
  if (!(await pathExists(paths.configFile))) return null;
  const raw = JSON.parse(await fs.readFile(paths.configFile, "utf8")) as PiSyncSuiteConfig;
  if (raw.version !== CONFIG_VERSION) {
    throw new Error(`Unsupported pi-sync-suite config version: ${String(raw.version)}`);
  }
  if (/^https?:\/\//i.test(raw.repoUrl)) {
    throw new Error("HTTPS git remotes are not supported. Use an SSH URL.");
  }
  return raw;
}

export async function saveConfig(config: PiSyncSuiteConfig, paths: SyncPaths = getDefaultPaths()): Promise<void> {
  await fs.mkdir(paths.piDir, { recursive: true });
  await fs.writeFile(paths.configFile, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function isAutoPushEnabled(config: PiSyncSuiteConfig): boolean {
  return config.autoMode === "full-auto" || config.autoMode === "config-only-auto";
}

export function isAutoPullEnabled(config: PiSyncSuiteConfig): boolean {
  return config.autoMode === "full-auto" || config.autoMode === "config-only-auto";
}

export function isChatAutoEnabled(config: PiSyncSuiteConfig): boolean {
  return config.autoMode === "full-auto" && config.chat.autoExport;
}
