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
    watchIntervalMs: 10000,
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
    policy: structuredClone(DEFAULT_POLICY),
  };
}

export async function loadConfig(paths: SyncPaths = getDefaultPaths()): Promise<PiSyncSuiteConfig | null> {
  if (!(await pathExists(paths.configFile))) return null;
  const raw = JSON.parse(await fs.readFile(paths.configFile, "utf8")) as Partial<PiSyncSuiteConfig>;
  if (raw.version !== CONFIG_VERSION) {
    throw new Error(`Unsupported pi-sync-suite config version: ${String(raw.version)}`);
  }
  if (!raw.repoUrl) {
    throw new Error("Missing repoUrl in pi-sync-suite config.");
  }
  if (/^https?:\/\//i.test(raw.repoUrl)) {
    throw new Error("HTTPS git remotes are not supported. Use an SSH URL.");
  }
  return normalizeConfig(raw, paths);
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

function normalizeConfig(raw: Partial<PiSyncSuiteConfig>, paths: SyncPaths): PiSyncSuiteConfig {
  const defaults = createDefaultConfig(raw.repoUrl ?? "", paths);
  return {
    ...defaults,
    ...raw,
    version: CONFIG_VERSION,
    repoUrl: raw.repoUrl ?? defaults.repoUrl,
    repoDir: raw.repoDir ?? defaults.repoDir,
    chat: { ...defaults.chat, ...raw.chat },
    retention: { ...defaults.retention, ...raw.retention },
    policy: {
      ...defaults.policy,
      ...raw.policy,
      safeRootFiles: raw.policy?.safeRootFiles ?? defaults.policy.safeRootFiles,
      safeDirs: raw.policy?.safeDirs ?? defaults.policy.safeDirs,
      optionalFiles: raw.policy?.optionalFiles ?? defaults.policy.optionalFiles,
      optionalDirs: raw.policy?.optionalDirs ?? defaults.policy.optionalDirs,
      includedPaths: raw.policy?.includedPaths ?? defaults.policy.includedPaths,
      excludedPaths: raw.policy?.excludedPaths ?? defaults.policy.excludedPaths,
      neverSyncNames: raw.policy?.neverSyncNames ?? defaults.policy.neverSyncNames,
      strippedSettingsKeys: raw.policy?.strippedSettingsKeys ?? defaults.policy.strippedSettingsKeys,
    },
  };
}
