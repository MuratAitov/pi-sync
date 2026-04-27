import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutoSyncMode, PiSyncSuiteConfig } from "../types.js";
import { createDefaultConfig, isAutoPullEnabled, isAutoPushEnabled, loadConfig, saveConfig } from "../config/index.js";
import { getDefaultPaths, normalizePortablePath } from "../utils/paths.js";
import { getOptionalStoreChoices, shouldNeverSync } from "../snapshot/policy.js";
import { pushSnapshot, pullSnapshot } from "../engine/syncEngine.js";
import { applyCleanup, planCleanup } from "../cleanup/index.js";
import { formatCleanupPreview, formatStatus, formatStatusWidget } from "../ui/formatters.js";
import { createSnapshotFingerprint } from "../watcher/fingerprint.js";
import { createBackup, listBackups, restoreBackup } from "../backup/index.js";
import { formatDoctor, runDoctor } from "../doctor/index.js";
import { cloneIfMissing, diffStat, logOneline } from "../git/client.js";
import { stageSnapshot } from "../snapshot/index.js";

type RuntimeContext = {
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus?(key: string, value: string): void;
    setWidget?(key: string, value: string[], options?: unknown): void;
    select?(title: string, options: string[]): Promise<string | undefined>;
    input?(title: string, placeholder?: string): Promise<string | undefined>;
    confirm?(title: string, message: string): Promise<boolean>;
  };
};

export default function piSyncSuite(pi: ExtensionAPI): void {
  let configPromise = loadConfig().catch(() => null);
  let pullTimer: ReturnType<typeof setInterval> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let pushDebounce: ReturnType<typeof setTimeout> | undefined;
  let lastSnapshotFingerprint: string | undefined;
  let autoPushRunning = false;
  let lastAutoPushError: string | undefined;

  const paths = getDefaultPaths();

  async function currentConfig() {
    return configPromise;
  }

  async function reloadConfig() {
    configPromise = loadConfig().catch(() => null);
    return configPromise;
  }

  function stopBackgroundWork() {
    if (pullTimer) clearInterval(pullTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (pushDebounce) clearTimeout(pushDebounce);
    pullTimer = undefined;
    pollTimer = undefined;
    pushDebounce = undefined;
    lastSnapshotFingerprint = undefined;
  }

  function startBackgroundWork(ctx: RuntimeContext) {
    stopBackgroundWork();
    void currentConfig().then((config) => {
      if (!config) return;
      if (isAutoPullEnabled(config)) {
        const intervalMs = Math.max(1, config.pullIntervalMinutes) * 60 * 1000;
        pullTimer = setInterval(() => {
          void pullSnapshot(pi, config).catch((error: unknown) => {
            ctx.ui.notify(`pi-sync pull error: ${errorMessage(error)}`, "error");
          });
        }, intervalMs);
      }
      if (isAutoPushEnabled(config)) {
        void createSnapshotFingerprint(config, paths).then((fingerprint) => {
          lastSnapshotFingerprint = fingerprint;
        });
        pollTimer = setInterval(() => {
          void createSnapshotFingerprint(config, paths)
            .then((fingerprint) => {
              if (lastSnapshotFingerprint === undefined) {
                lastSnapshotFingerprint = fingerprint;
                return;
              }
              if (fingerprint !== lastSnapshotFingerprint) {
                scheduleAutoPush(config, ctx);
              }
            })
            .catch((error: unknown) => {
              ctx.ui.notify(`pi-sync watcher error: ${errorMessage(error)}`, "error");
            });
        }, Math.max(5000, config.watchIntervalMs));
      }
    });
  }

  function scheduleAutoPush(config: PiSyncSuiteConfig, ctx: RuntimeContext): void {
    if (pushDebounce) clearTimeout(pushDebounce);
    pushDebounce = setTimeout(() => {
      if (autoPushRunning) return;
      autoPushRunning = true;
      void pushSnapshot(pi, config)
        .then(async () => {
          lastSnapshotFingerprint = await createSnapshotFingerprint(config, paths);
        })
        .catch((error: unknown) => {
          const message = errorMessage(error);
          if (message !== lastAutoPushError) {
            ctx.ui.notify(`pi-sync push error: ${message}`, "error");
            lastAutoPushError = message;
          }
        })
        .finally(() => {
          autoPushRunning = false;
        });
    }, config.pushDebounceMs);
  }

  pi.on("session_start", async (_event, ctx) => {
    const config = await reloadConfig();
    if (!config) {
      ctx.ui.setStatus("pi-sync", "not configured");
      ctx.ui.setWidget("pi-sync", formatStatusWidget(null), { placement: "belowEditor" });
      return;
    }
    ctx.ui.setStatus("pi-sync", `${config.autoMode} -> ${config.repoUrl}`);
    ctx.ui.setWidget("pi-sync", formatStatusWidget(config), { placement: "belowEditor" });
    startBackgroundWork(ctx);
    if (isAutoPullEnabled(config)) {
      await pullSnapshot(pi, config).catch((error: unknown) => {
        ctx.ui.notify(`pi-sync pull error: ${errorMessage(error)}`, "error");
      });
    }
  });

  pi.on("session_shutdown", async () => {
    stopBackgroundWork();
  });

  pi.registerCommand("sync-setup", {
    description: "Configure Pi Sync Suite: /sync-setup <ssh-repo-url> [pull-interval-minutes]",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const enteredRepo = parts[0] ?? (await ctx.ui.input("Git repository URL (SSH)", "git@github.com:you/pi-config.git"));
      const repoUrl = enteredRepo?.trim();
      if (!repoUrl) {
        ctx.ui.notify("pi-sync: setup cancelled", "warning");
        return;
      }
      if (/^https?:\/\//i.test(repoUrl)) {
        ctx.ui.notify("pi-sync: use an SSH git URL, not HTTPS", "error");
        return;
      }

      const interval = Number.parseInt(parts[1] ?? "1440", 10);
      if (!Number.isFinite(interval) || interval < 1) {
        ctx.ui.notify("pi-sync: interval must be a positive number of minutes", "error");
        return;
      }

      const config = createDefaultConfig(repoUrl, paths);
      config.pullIntervalMinutes = interval;
      setChatSyncMode(config, "Off");
      await saveAndRefresh(config, ctx);
      ctx.ui.notify(`pi-sync configured: ${repoUrl}`, "info");
      await pullSnapshot(pi, config);
      await pushSnapshot(pi, config);
      startBackgroundWork(ctx);
    },
  });

  pi.registerCommand("sync-push", {
    description: "Upload the current Pi Sync Suite snapshot",
    handler: async (_args, ctx) => {
      const config = await requireConfig(ctx);
      if (!config) return;
      const summary = await pushSnapshot(pi, config);
      ctx.ui.notify(summary.message, "info");
    },
  });

  pi.registerCommand("sync-pull", {
    description: "Download and apply the latest Pi Sync Suite snapshot",
    handler: async (_args, ctx) => {
      const config = await requireConfig(ctx);
      if (!config) return;
      const summary = await pullSnapshot(pi, config);
      ctx.ui.notify(summary.message, "info");
    },
  });

  pi.registerCommand("sync-settings", {
    description: "Open Pi Sync Suite settings",
    handler: async (_args, ctx) => {
      await openSettings(ctx);
    },
  });

  async function openSettings(ctx: RuntimeContext): Promise<void> {
    if (!ctx.ui.select) {
      ctx.ui.notify(formatStatus(await currentConfig(), paths), "info");
      return;
    }

    const section = await ctx.ui.select("Pi Sync Suite settings", SETTINGS_SECTIONS);
    if (!section || section === "Cancel") return;

    if (section === "Status") {
      ctx.ui.notify(formatStatus(await currentConfig(), paths), "info");
      return;
    }

    const config = await requireConfig(ctx);
    if (!config) return;

    if (section === "Sync Mode") {
      await runSyncModeSettings(config, ctx);
    } else if (section === "Chat Sync") {
      await runChatSettings(config, ctx);
    } else if (section === "Config Paths") {
      await runPathSettings(config, ctx);
    } else if (section === "Cleanup") {
      await runCleanupSettings(config, ctx);
    } else if (section === "Backups") {
      await runBackupSettings(config, ctx);
    } else if (section === "Diagnostics") {
      await runDiagnosticsSettings(config, ctx);
    }
  }

  async function runSyncModeSettings(config: PiSyncSuiteConfig, ctx: RuntimeContext): Promise<void> {
    const selected = await ctx.ui.select?.("Sync mode", SYNC_MODE_CHOICES);
    const mode = parseSyncModeChoice(selected);
    if (!mode) return;
    config.autoMode = mode;
    await saveAndRefresh(config, ctx);
    startBackgroundWork(ctx);
    ctx.ui.notify(`pi-sync: sync mode set to ${selected}`, "info");
  }

  async function runChatSettings(config: PiSyncSuiteConfig, ctx: RuntimeContext): Promise<void> {
    const selected = await ctx.ui.select?.("Chat sync", CHAT_SYNC_CHOICES);
    if (!isChatSyncChoice(selected)) return;
    if (selected === "Resume") {
      const confirmed = await ctx.ui.confirm?.(
        "Enable Resume chat sync?",
        "Resume sync uploads raw Pi session files. They may contain prompts, outputs, tool logs, file paths, and secrets. Use only with a private repository.",
      );
      if (!confirmed) {
        ctx.ui.notify("pi-sync: resume chat sync cancelled", "warning");
        return;
      }
    }
    setChatSyncMode(config, selected);
    await saveAndRefresh(config, ctx);
    ctx.ui.notify(`pi-sync: chat sync set to ${selected}`, selected === "Resume" ? "warning" : "info");
  }

  async function runPathSettings(config: PiSyncSuiteConfig, ctx: RuntimeContext): Promise<void> {
    const choices = buildPathChoices(config);
    const selected = await ctx.ui.select?.("Config paths", choices);
    if (!selected || selected === "Cancel") return;
    if (selected === "Manual Include") {
      await updatePathPolicy(undefined, ctx, "include");
      return;
    }
    if (selected === "Manual Exclude") {
      await updatePathPolicy(undefined, ctx, "exclude");
      return;
    }

    const [action, ...pathParts] = selected.split(" ");
    const portablePath = pathParts.join(" ");
    await updatePathPolicy(portablePath, ctx, action === "Exclude" ? "exclude" : "include");
  }

  async function runCleanupSettings(config: PiSyncSuiteConfig, ctx: RuntimeContext): Promise<void> {
    const selected = await ctx.ui.select?.("Cleanup", CLEANUP_CHOICES);
    if (!selected || selected === "Cancel") return;

    if (selected === "Preview") {
      const candidates = await planCleanup(config, paths);
      ctx.ui.notify(formatCleanupPreview(candidates), "info");
      return;
    }

    if (selected === "Run") {
      const candidates = await planCleanup(config, paths);
      ctx.ui.notify(formatCleanupPreview(candidates), candidates.length ? "warning" : "info");
      if (candidates.length === 0) return;
      const confirmed = await ctx.ui.confirm?.("pi-sync cleanup", `Delete ${candidates.length} cleanup candidate(s)?`);
      if (!confirmed) {
        ctx.ui.notify("pi-sync cleanup cancelled", "warning");
        return;
      }
      const deleted = await applyCleanup(candidates);
      ctx.ui.notify(`pi-sync cleanup: deleted ${deleted} item(s)`, "info");
      return;
    }

    await updateRetentionPolicy(config, ctx);
  }

  async function runBackupSettings(config: PiSyncSuiteConfig, ctx: RuntimeContext): Promise<void> {
    const selected = await ctx.ui.select?.("Backups", BACKUP_CHOICES);
    if (!selected || selected === "Cancel") return;
    if (selected === "Create Backup") {
      const backup = await createBackup(config, paths, "manual backup");
      ctx.ui.notify(`pi-sync: backup ${backup.id} created with ${backup.includedPaths.length} item(s)`, "info");
      return;
    }
    if (selected === "List Backups") {
      const backups = await listBackups(paths);
      ctx.ui.notify(
        backups.length
          ? backups.map((backup) => `${backup.id}  ${backup.reason}  ${backup.includedPaths.length} item(s)`).join("\n")
          : "pi-sync: no backups",
        "info",
      );
      return;
    }
    const id = (await ctx.ui.input?.("Backup id", "latest"))?.trim() || "latest";
    const restored = await restoreBackup(paths, id);
    ctx.ui.notify(restored ? `pi-sync: restored backup ${restored.id}` : `pi-sync: backup not found: ${id}`, restored ? "info" : "error");
  }

  async function runDiagnosticsSettings(config: PiSyncSuiteConfig, ctx: RuntimeContext): Promise<void> {
    const selected = await ctx.ui.select?.("Diagnostics", DIAGNOSTIC_CHOICES);
    if (!selected || selected === "Cancel") return;
    if (selected === "Doctor") {
      ctx.ui.notify(formatDoctor(await runDoctor(pi, config, paths)), "info");
      return;
    }
    await cloneIfMissing(pi, config.repoUrl, config.repoDir);
    if (selected === "Diff") {
      await stageSnapshot(config, paths.piDir);
      ctx.ui.notify((await diffStat(pi, config.repoDir)) || "pi-sync: no local snapshot diff", "info");
      return;
    }
    ctx.ui.notify((await logOneline(pi, config.repoDir)) || "pi-sync: no commits", "info");
  }

  async function updateRetentionPolicy(config: PiSyncSuiteConfig, ctx: RuntimeContext): Promise<void> {
    if (!ctx.ui.input) {
      ctx.ui.notify("pi-sync: this Pi UI cannot edit retention values", "error");
      return;
    }

    const chat = parseOptionalPositiveInt(
      await ctx.ui.input("Keep chat export files", String(config.retention.keepChatExports)),
    );
    const backups = parseOptionalPositiveInt(
      await ctx.ui.input("Keep backup files", String(config.retention.keepBackups)),
    );
    const days = parseOptionalPositiveInt(
      await ctx.ui.input("Delete files older than days", String(config.retention.maxAgeDays)),
    );
    if (chat === undefined || backups === undefined || days === undefined) {
      ctx.ui.notify("pi-sync: retention values must be non-negative numbers", "error");
      return;
    }
    config.retention.keepChatExports = chat;
    config.retention.keepBackups = backups;
    config.retention.maxAgeDays = days;
    config.retention.autoApply = (await ctx.ui.confirm?.("Auto cleanup", "Automatically apply cleanup during future maintenance?")) ?? false;
    await saveAndRefresh(config, ctx);
    ctx.ui.notify(
      `pi-sync cleanup policy: chat=${chat}, backups=${backups}, days=${days}, auto=${config.retention.autoApply ? "on" : "off"}`,
      "info",
    );
  }

  async function saveAndRefresh(config: PiSyncSuiteConfig, ctx?: RuntimeContext): Promise<void> {
    await saveConfig(config, paths);
    configPromise = Promise.resolve(config);
    ctx?.ui.setStatus?.("pi-sync", `${config.autoMode} -> ${config.repoUrl}`);
    ctx?.ui.setWidget?.("pi-sync", formatStatusWidget(config), { placement: "belowEditor" });
  }

  async function requireConfig(ctx: RuntimeContext): Promise<PiSyncSuiteConfig | null> {
    const config = await currentConfig();
    if (!config) {
      ctx.ui.notify("pi-sync: not configured. Run /sync-setup <ssh-repo-url>", "warning");
    }
    return config;
  }

  async function updatePathPolicy(
    args: string | undefined,
    ctx: RuntimeContext,
    action: "include" | "exclude",
  ): Promise<void> {
    const config = await requireConfig(ctx);
    if (!config) return;
    const entered = (args ?? "").trim() || (await ctx.ui.input?.(`Path to ${action}`, "AGENTS.md"))?.trim();
    if (!entered) {
      ctx.ui.notify(`pi-sync: ${action} cancelled`, "warning");
      return;
    }
    const portablePath = normalizePortablePath(entered);
    if (!portablePath || shouldNeverSync(portablePath, config.policy)) {
      ctx.ui.notify(`pi-sync: refusing unsafe path ${entered}`, "error");
      return;
    }
    if (action === "include") {
      addUnique(config.policy.includedPaths, portablePath);
      config.policy.excludedPaths = config.policy.excludedPaths.filter((item) => item !== portablePath);
    } else {
      addUnique(config.policy.excludedPaths, portablePath);
      config.policy.includedPaths = config.policy.includedPaths.filter((item) => item !== portablePath);
    }
    await saveAndRefresh(config, ctx);
    ctx.ui.notify(`pi-sync: ${action}d ${portablePath}`, "info");
  }
}

const SETTINGS_SECTIONS = [
  "Status",
  "Sync Mode",
  "Chat Sync",
  "Config Paths",
  "Cleanup",
  "Backups",
  "Diagnostics",
  "Cancel",
];

const SYNC_MODE_CHOICES = ["Full Sync", "Config Only", "Manual", "Off", "Cancel"];
const CHAT_SYNC_CHOICES = ["Off", "Archive", "Resume", "Cancel"];
const CLEANUP_CHOICES = ["Preview", "Run", "Retention", "Cancel"];
const BACKUP_CHOICES = ["Create Backup", "List Backups", "Restore Latest", "Cancel"];
const DIAGNOSTIC_CHOICES = ["Doctor", "Diff", "Log", "Cancel"];

function parseSyncModeChoice(value: string | undefined): AutoSyncMode | undefined {
  if (value === "Full Sync") return "full-auto";
  if (value === "Config Only") return "config-only-auto";
  if (value === "Manual") return "manual";
  if (value === "Off") return "off";
  return undefined;
}

function isChatSyncChoice(value: string | undefined): value is "Off" | "Archive" | "Resume" {
  return value === "Off" || value === "Archive" || value === "Resume";
}

function setChatSyncMode(config: PiSyncSuiteConfig, mode: "Off" | "Archive" | "Resume"): void {
  config.chat.rawSessionSync = mode === "Resume";
  config.chat.autoExport = mode === "Archive";
  config.chat.autoUpload = mode === "Archive";
  config.chat.autoDownload = mode === "Archive";
  if (mode === "Resume") {
    addUnique(config.policy.dangerouslyAllowedNames, "sessions");
    addUnique(config.policy.includedPaths, "sessions");
    config.policy.excludedPaths = config.policy.excludedPaths.filter((item) => item !== "sessions");
  } else {
    config.policy.dangerouslyAllowedNames = config.policy.dangerouslyAllowedNames.filter((item) => item !== "sessions");
    config.policy.includedPaths = config.policy.includedPaths.filter((item) => item !== "sessions");
  }
}

function buildPathChoices(config: PiSyncSuiteConfig): string[] {
  const optionalChoices = getOptionalStoreChoices(config.policy);
  const choices: string[] = [];
  for (const item of optionalChoices) {
    choices.push(config.policy.includedPaths.includes(item) ? `Exclude ${item}` : `Include ${item}`);
  }
  choices.push("Manual Include", "Manual Exclude", "Cancel");
  return choices;
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
  values.sort();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
