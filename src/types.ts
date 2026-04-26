export type NotifyLevel = "info" | "warning" | "error";

export interface PiUi {
  notify(message: string, level?: NotifyLevel | string): void;
  setStatus?(key: string, value: string): void;
  select?(title: string, options: string[]): Promise<string | undefined>;
  confirm?(title: string, message: string): Promise<boolean>;
  input?(prompt: string, defaultValue?: string): Promise<string | undefined>;
}

export interface CommandContext {
  ui: PiUi;
}

export interface PiExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PiExecApi {
  exec(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): Promise<PiExecResult>;
}

export type AutoSyncMode =
  | "full-auto"
  | "config-only-auto"
  | "chats-manual"
  | "manual"
  | "off";

export type ChatExportFormat = "markdown" | "json" | "both";

export interface RetentionPolicy {
  keepChatExports: number;
  keepBackups: number;
  maxAgeDays: number;
  autoApply: boolean;
}

export interface SyncPaths {
  piDir: string;
  configFile: string;
  repoDir: string;
  backupDir: string;
  chatExportDir: string;
}

export interface PathPolicy {
  safeRootFiles: string[];
  safeDirs: string[];
  optionalFiles: string[];
  optionalDirs: string[];
  includedPaths: string[];
  excludedPaths: string[];
  neverSyncNames: string[];
  dangerouslyAllowedNames: string[];
  strippedSettingsKeys: string[];
}

export interface ChatSyncConfig {
  autoExport: boolean;
  autoUpload: boolean;
  autoDownload: boolean;
  rawSessionSync: boolean;
  exportFormat: ChatExportFormat;
  includeMetadata: boolean;
}

export interface PiSyncSuiteConfig {
  version: 1;
  repoUrl: string;
  repoDir: string;
  autoMode: AutoSyncMode;
  pullIntervalMinutes: number;
  pushDebounceMs: number;
  watchIntervalMs: number;
  chat: ChatSyncConfig;
  retention: RetentionPolicy;
  policy: PathPolicy;
  lastConfigSyncAt?: string;
  lastChatSyncAt?: string;
}

export interface SyncSummary {
  changed: boolean;
  message: string;
}

export interface CleanupCandidate {
  path: string;
  reason: string;
  sizeBytes?: number;
  modifiedAt?: string;
}

export interface BackupManifest {
  id: string;
  createdAt: string;
  reason: string;
  piDir: string;
  filesDir: string;
  includedPaths: string[];
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
}
