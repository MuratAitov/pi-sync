import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AutoSyncMode, PiSyncSuiteConfig } from "../types.js";
import { createDefaultConfig, deleteConfig, isAutoPullEnabled, isAutoPushEnabled, loadConfig, saveConfig } from "../config/index.js";
import { getDefaultPaths, normalizePortablePath } from "../utils/paths.js";
import { getOptionalStoreChoices, shouldNeverSync } from "../snapshot/policy.js";
import { pushSnapshot, pullSnapshot } from "../engine/syncEngine.js";
import { OperationQueue } from "../engine/operationQueue.js";
import { applyCleanup, planCleanup } from "../cleanup/index.js";
import { formatCleanupPreview, formatStatus, formatStatusWidget } from "../ui/formatters.js";
import { createSnapshotFingerprint } from "../watcher/fingerprint.js";
import { createBackup, listBackups, restoreBackup } from "../backup/index.js";
import { formatDoctor, runDoctor } from "../doctor/index.js";
import { cloneIfMissing, diffStat, logOneline } from "../git/client.js";
import { stageSnapshot } from "../snapshot/index.js";
import {
  clearIgnoredEnvironmentPackages,
  environmentPackageKey,
  formatEnvironmentRestorePlan,
  ignoreEnvironmentPackage,
  installEnvironmentPackages,
  installMissingEnvironmentPackages,
  missingEnvironmentCount,
  planEnvironmentRestore,
} from "../environment/index.js";

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
  const operationQueue = new OperationQueue();

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
          void queueOperation("auto pull", () => pullSnapshot(pi, config), ctx).catch(() => undefined);
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
      void queueOperation("auto push", () => pushSnapshot(pi, config), ctx)
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
      await queueOperation("session start pull", () => pullSnapshot(pi, config), ctx)
        .then(() => maybePromptEnvironmentRestore("pull", ctx))
        .catch(() => undefined);
    }
  });

  pi.on("session_shutdown", async () => {
    stopBackgroundWork();
  });

  pi.registerCommand("sync-setup", {
    description: "Configure Pi Sync: /sync-setup <ssh-repo-url> [pull-interval-minutes]",
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
      const previousConfig = await currentConfig();
      try {
        ctx.ui.notify(`pi-sync setup: checking ${repoUrl}`, "info");
        await queueOperation("setup pull", () => pullSnapshot(pi, config), ctx);
        await maybePromptEnvironmentRestore("setup pull", ctx);
        await queueOperation("setup push", () => pushSnapshot(pi, config), ctx);
        await saveAndRefresh(config, ctx);
        ctx.ui.notify(`pi-sync configured: ${repoUrl}`, "info");
        startBackgroundWork(ctx);
      } catch (error) {
        await restoreSetupState(previousConfig, config);
        ctx.ui.notify(await formatSetupFailure(repoUrl, error), "error");
      }
    },
  });

  pi.registerCommand("sync-push", {
    description: "Upload the current Pi Sync snapshot",
    handler: async (_args, ctx) => {
      const config = await requireConfig(ctx);
      if (!config) return;
      const summary = await queueOperation("manual push", () => pushSnapshot(pi, config), ctx);
      ctx.ui.notify(summary.message, "info");
    },
  });

  pi.registerCommand("sync-pull", {
    description: "Download and apply the latest Pi Sync snapshot",
    handler: async (_args, ctx) => {
      const config = await requireConfig(ctx);
      if (!config) return;
      const summary = await queueOperation("manual pull", () => pullSnapshot(pi, config), ctx);
      ctx.ui.notify(summary.message, "info");
      await maybePromptEnvironmentRestore("manual pull", ctx);
    },
  });

  pi.registerCommand("sync-settings", {
    description: "Open Pi Sync settings",
    handler: async (_args, ctx) => {
      await openSettings(ctx);
    },
  });

  async function openSettings(ctx: RuntimeContext): Promise<void> {
    if (!ctx.ui.select) {
      ctx.ui.notify(formatStatus(await currentConfig(), paths), "info");
      return;
    }

    for (;;) {
      const config = await currentConfig();
      const section = await ctx.ui.select("Pi Sync settings", await buildSettingsSections(config));
      const sectionKey = parseSectionChoice(section);
      if (!sectionKey || sectionKey === "Cancel") return;

      if (sectionKey === "Status") {
        ctx.ui.notify(formatStatus(config, paths), "info");
        return;
      }

      const requiredConfig = await requireConfig(ctx);
      if (!requiredConfig) return;

      if (sectionKey === "Sync Mode") {
        await runSyncModeSettings(requiredConfig, ctx);
      } else if (sectionKey === "Chat Sync") {
        await runChatSettings(requiredConfig, ctx);
      } else if (sectionKey === "Config Paths") {
        await runPathSettings(requiredConfig, ctx);
      } else if (sectionKey === "Cleanup") {
        await runCleanupSettings(requiredConfig, ctx);
      } else if (sectionKey === "Backups") {
        await runBackupSettings(requiredConfig, ctx);
      } else if (sectionKey === "Environment") {
        await runEnvironmentSettings(ctx);
      } else if (sectionKey === "Diagnostics") {
        await runDiagnosticsSettings(requiredConfig, ctx);
      }
    }
  }

  async function runSyncModeSettings(config: PiSyncSuiteConfig, ctx: RuntimeContext): Promise<void> {
    const selected = await ctx.ui.select?.("Sync mode", buildSyncModeChoices());
    const mode = parseSyncModeChoice(selected);
    if (!mode) return;
    config.autoMode = mode;
    await saveAndRefresh(config, ctx);
    startBackgroundWork(ctx);
    ctx.ui.notify(`pi-sync: sync mode set to ${syncModeLabel(mode)}`, "info");
  }

  async function runChatSettings(config: PiSyncSuiteConfig, ctx: RuntimeContext): Promise<void> {
    const selected = await ctx.ui.select?.("Chat history", buildChatSyncChoices());
    const mode = parseChatSyncChoice(selected);
    if (!mode) return;
    if (mode === "Resume") {
      const confirmed = await ctx.ui.confirm?.(
        "Enable Resumable Sessions?",
        "This uploads raw Pi session files. They may contain prompts, outputs, tool logs, file paths, and secrets. Use only with a private repository.",
      );
      if (!confirmed) {
        ctx.ui.notify("pi-sync: resume chat sync cancelled", "warning");
        return;
      }
    }
    setChatSyncMode(config, mode);
    await saveAndRefresh(config, ctx);
    ctx.ui.notify(`pi-sync: chat history set to ${chatSyncChoiceLabel(mode)}`, mode === "Resume" ? "warning" : "info");
  }

  async function runPathSettings(config: PiSyncSuiteConfig, ctx: RuntimeContext): Promise<void> {
    const choices = buildPathChoices(config);
    const selected = await ctx.ui.select?.("Config paths", choices);
    const clean = cleanChoice(selected);
    if (!clean || clean.startsWith("Cancel")) return;
    if (clean.startsWith("Manual Include")) {
      await updatePathPolicy(undefined, ctx, "include");
      return;
    }
    if (clean.startsWith("Manual Exclude")) {
      await updatePathPolicy(undefined, ctx, "exclude");
      return;
    }

    const action = clean.startsWith("Exclude ") ? "Exclude" : "Include";
    const portablePath = clean.slice(action.length + 1).replace(/\s+\[[^\]]+\].*$/, "");
    await updatePathPolicy(portablePath, ctx, action === "Exclude" ? "exclude" : "include");
  }

  async function runCleanupSettings(config: PiSyncSuiteConfig, ctx: RuntimeContext): Promise<void> {
    const selected = cleanChoice(await ctx.ui.select?.("Cleanup", buildCleanupChoices(config)));
    if (!selected || selected.startsWith("Cancel")) return;

    if (selected.startsWith("Preview")) {
      const candidates = await queueOperation("cleanup preview", () => planCleanup(config, paths), ctx);
      ctx.ui.notify(formatCleanupPreview(candidates), "info");
      return;
    }

    if (selected.startsWith("Run")) {
      const candidates = await queueOperation("cleanup run preview", () => planCleanup(config, paths), ctx);
      ctx.ui.notify(formatCleanupPreview(candidates), candidates.length ? "warning" : "info");
      if (candidates.length === 0) return;
      const confirmed = await ctx.ui.confirm?.("pi-sync cleanup", `Delete ${candidates.length} cleanup candidate(s)?`);
      if (!confirmed) {
        ctx.ui.notify("pi-sync cleanup cancelled", "warning");
        return;
      }
      const deleted = await queueOperation("cleanup run", () => applyCleanup(candidates), ctx);
      ctx.ui.notify(`pi-sync cleanup: deleted ${deleted} item(s)`, "info");
      return;
    }

    await updateRetentionPolicy(config, ctx);
  }

  async function runBackupSettings(config: PiSyncSuiteConfig, ctx: RuntimeContext): Promise<void> {
    const selected = cleanChoice(await ctx.ui.select?.("Backups", await buildBackupChoices()));
    if (!selected || selected.startsWith("Cancel")) return;
    if (selected.startsWith("Create Backup")) {
      const backup = await queueOperation("create backup", () => createBackup(config, paths, "manual backup"), ctx);
      ctx.ui.notify(`pi-sync: backup ${backup.id} created with ${backup.includedPaths.length} item(s)`, "info");
      return;
    }
    if (selected.startsWith("List Backups")) {
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
    const restored = await queueOperation("restore backup", () => restoreBackup(paths, id), ctx);
    ctx.ui.notify(restored ? `pi-sync: restored backup ${restored.id}` : `pi-sync: backup not found: ${id}`, restored ? "info" : "error");
  }

  async function runDiagnosticsSettings(config: PiSyncSuiteConfig, ctx: RuntimeContext): Promise<void> {
    const selected = cleanChoice(await ctx.ui.select?.("Diagnostics", buildDiagnosticChoices()));
    if (!selected || selected.startsWith("Cancel")) return;
    if (selected.startsWith("Doctor")) {
      ctx.ui.notify(formatDoctor(await queueOperation("doctor", () => runDoctor(pi, config, paths), ctx)), "info");
      return;
    }
    if (selected.startsWith("Diff")) {
      const diff = await queueOperation(
        "diff",
        async () => {
          await cloneIfMissing(pi, config.repoUrl, config.repoDir);
          await stageSnapshot(config, paths.piDir);
          return diffStat(pi, config.repoDir);
        },
        ctx,
      );
      ctx.ui.notify(diff || "pi-sync: no local snapshot diff", "info");
      return;
    }
    const log = await queueOperation(
      "log",
      async () => {
        await cloneIfMissing(pi, config.repoUrl, config.repoDir);
        return logOneline(pi, config.repoDir);
      },
      ctx,
    );
    ctx.ui.notify(log || "pi-sync: no commits", "info");
  }

  async function runEnvironmentSettings(ctx: RuntimeContext): Promise<void> {
    const selected = cleanChoice(await ctx.ui.select?.("Environment restore", buildEnvironmentChoices()));
    if (!selected || selected.startsWith("Cancel") || selected.startsWith("Back")) return;

    const plan = await queueOperation("environment check", () => planEnvironmentRestore(pi, paths.piDir), ctx);
    if (selected.startsWith("Check")) {
      ctx.ui.notify(formatEnvironmentRestorePlan(plan), missingEnvironmentCount(plan) ? "warning" : "info");
      return;
    }

    if (selected.startsWith("Ignore")) {
      await promptIgnoreEnvironmentPackage(plan, ctx);
      return;
    }

    if (selected.startsWith("Clear Ignored")) {
      const confirmed = await ctx.ui.confirm?.("Clear ignored packages?", "Show all missing environment packages again on this device?");
      if (!confirmed) return;
      await clearIgnoredEnvironmentPackages(paths.piDir);
      ctx.ui.notify("pi-sync: cleared environment package ignore list", "info");
      return;
    }

    await promptInstallEnvironmentPackages(plan, ctx, "environment menu");
  }

  async function maybePromptEnvironmentRestore(reason: string, ctx: RuntimeContext): Promise<void> {
    if (!ctx.ui.select) return;
    const plan = await queueOperation("environment check", () => planEnvironmentRestore(pi, paths.piDir), ctx);
    const missing = missingEnvironmentCount(plan);
    if (missing === 0) return;
    ctx.ui.notify(`pi-sync: ${missing} environment package(s) missing after ${reason}`, "warning");
    const action = cleanChoice(await ctx.ui.select?.("Environment restore", [
      menuLine("Install Missing", String(missing), "choose all or one package"),
      menuLine("Ignore Missing", undefined, "hide one package on this device"),
      menuLine("Skip", "later", "ask again later"),
    ]));
    if (action.startsWith("Install Missing")) {
      await promptInstallEnvironmentPackages(plan, ctx, reason);
    } else if (action.startsWith("Ignore Missing")) {
      await promptIgnoreEnvironmentPackage(plan, ctx);
    }
  }

  async function promptInstallEnvironmentPackages(
    plan: Awaited<ReturnType<typeof planEnvironmentRestore>>,
    ctx: RuntimeContext,
    reason: string,
  ): Promise<void> {
    const missing = missingEnvironmentCount(plan);
    ctx.ui.notify(formatEnvironmentRestorePlan(plan), missing ? "warning" : "info");
    if (missing === 0) return;
    const missingEntries = plan.entries.filter((item) => item.status === "missing");
    const installChoice = cleanChoice(await ctx.ui.select?.("Install packages", [
      menuLine("All Missing", String(missing), "install every missing package"),
      ...missingEntries.map((item) => menuLine(environmentPackageKey(item), undefined, "install only this package")),
      menuLine("Back", "back", "return to environment menu"),
    ]));
    if (!installChoice || installChoice.startsWith("Back")) return;
    const selectedPackages = installChoice.startsWith("All Missing")
      ? missingEntries
      : missingEntries.filter((item) => installChoice.startsWith(environmentPackageKey(item)));
    if (selectedPackages.length === 0) return;
    const confirmed = await ctx.ui.confirm?.(
      "Install missing packages?",
      `Install ${selectedPackages.length} package(s) from pi-sync-environment.json after ${reason}? npm packages use npm install -g; Pi packages use pi install.`,
    );
    if (!confirmed) {
      ctx.ui.notify("pi-sync: environment restore cancelled", "warning");
      return;
    }
    const installed = await queueOperation(
      "environment install",
      () => selectedPackages.length === missingEntries.length
        ? installMissingEnvironmentPackages(pi, plan)
        : installEnvironmentPackages(pi, selectedPackages),
      ctx,
    );
    ctx.ui.notify(`pi-sync: installed ${installed.length} environment package(s)`, "info");
  }

  async function promptIgnoreEnvironmentPackage(
    plan: Awaited<ReturnType<typeof planEnvironmentRestore>>,
    ctx: RuntimeContext,
  ): Promise<void> {
    const missingEntries = plan.entries.filter((item) => item.status === "missing");
    if (missingEntries.length === 0) {
      ctx.ui.notify("pi-sync: no missing environment packages to ignore", "info");
      return;
    }
    const ignoredChoice = cleanChoice(await ctx.ui.select?.("Ignore package on this device", [
      ...missingEntries.map((item) => menuLine(environmentPackageKey(item), undefined, "do not ask on this device")),
      menuLine("Back", "back", "return to environment menu"),
    ]));
    if (!ignoredChoice || ignoredChoice.startsWith("Back")) return;
    const item = missingEntries.find((entry) => ignoredChoice.startsWith(environmentPackageKey(entry)));
    if (!item) return;
    await ignoreEnvironmentPackage(paths.piDir, item);
    ctx.ui.notify(`pi-sync: ignored ${environmentPackageKey(item)} on this device`, "info");
  }

  async function queueOperation<T>(
    label: string,
    run: () => Promise<T>,
    ctx: RuntimeContext,
  ): Promise<T> {
    const queuedBehind = operationQueue.currentOperation();
    if (queuedBehind) {
      ctx.ui.notify(`pi-sync: queued ${label} after ${queuedBehind}`, "info");
    }
    try {
      return await operationQueue.enqueue({ label, run });
    } catch (error) {
      ctx.ui.notify(`pi-sync ${label} error: ${errorMessage(error)}`, "error");
      throw error;
    }
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

  async function restoreSetupState(
    previousConfig: PiSyncSuiteConfig | null,
    attemptedConfig: PiSyncSuiteConfig,
  ): Promise<void> {
    stopBackgroundWork();
    if (previousConfig) {
      await saveConfig(previousConfig, paths);
      configPromise = Promise.resolve(previousConfig);
      return;
    }
    await deleteConfig(paths);
    configPromise = Promise.resolve(null);
    await fs.rm(attemptedConfig.repoDir, { recursive: true, force: true });
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

type SettingsSection =
  | "Status"
  | "Sync Mode"
  | "Chat Sync"
  | "Config Paths"
  | "Cleanup"
  | "Backups"
  | "Environment"
  | "Diagnostics"
  | "Cancel";

async function buildSettingsSections(config: PiSyncSuiteConfig | null): Promise<string[]> {
  const backupCount = config ? (await listBackups(getDefaultPaths())).length : 0;
  return [
    menuLine("View Status", undefined, config ? "current setup" : "not configured"),
    menuLine("Sync Mode", config ? syncModeLabel(config.autoMode) : "off", syncModeSummary(config?.autoMode)),
    menuLine("Chat History", config ? chatSyncLabel(config) : "off", chatSyncSummary(config)),
    menuLine("Config Paths", config ? String(config.policy.includedPaths.length) : "0", "optional extra paths"),
    menuLine("Cleanup", config?.retention.autoApply ? "auto" : "manual", cleanupSummary(config)),
    menuLine("Backups", backupCount === 1 ? "1 backup" : `${backupCount} backups`, "local restore points"),
    menuLine("Environment", undefined, "restore npm/Pi packages"),
    menuLine("Diagnostics", undefined, "doctor / diff / log"),
    "Cancel",
  ];
}

function buildSyncModeChoices(): string[] {
  return [
    menuLine("Full Sync", "full", "auto pull + push"),
    menuLine("Config Only", "config", "auto config sync; chat separate"),
    menuLine("Manual", "manual", "push/pull only when commanded"),
    menuLine("Off", "off", "no background sync"),
    menuLine("Cancel", "back", "return to main menu"),
  ];
}

function buildChatSyncChoices(): string[] {
  return [
    menuLine("No Chat Sync", "off", "skip chats"),
    menuLine("Readable Archive", "archive", "Markdown history"),
    menuLine("Resumable Sessions", "resume", "raw private sessions"),
    menuLine("Back", "back", "main menu"),
  ];
}

function buildCleanupChoices(config: PiSyncSuiteConfig): string[] {
  return [
    menuLine("Preview", undefined, "show files that cleanup would remove"),
    menuLine("Run", undefined, "delete cleanup candidates after confirmation"),
    menuLine("Retention", config.retention.autoApply ? "auto" : "manual", "edit count and age limits"),
    menuLine("Cancel", "back", "return to main menu"),
  ];
}

async function buildBackupChoices(): Promise<string[]> {
  const backupCount = (await listBackups(getDefaultPaths())).length;
  return [
    menuLine("Create Backup", undefined, "save current managed files locally"),
    menuLine("List Backups", backupCount === 1 ? "1 backup" : `${backupCount} backups`, "show available local backups"),
    menuLine("Restore Latest", undefined, "apply the newest local backup"),
    menuLine("Cancel", "back", "return to main menu"),
  ];
}

function buildEnvironmentChoices(): string[] {
  return [
    menuLine("Check Missing", undefined, "show packages not installed here"),
    menuLine("Install Missing", undefined, "choose all or one package"),
    menuLine("Ignore Missing", undefined, "hide one package on this device"),
    menuLine("Clear Ignored", undefined, "show ignored packages again"),
    menuLine("Back", "back", "return to main menu"),
  ];
}

function buildDiagnosticChoices(): string[] {
  return [
    menuLine("Doctor", undefined, "check git, config, paths, and remote"),
    menuLine("Diff", undefined, "show pending snapshot changes"),
    menuLine("Log", undefined, "show recent sync commits"),
    menuLine("Cancel", "back", "return to main menu"),
  ];
}

function parseSectionChoice(value: string | undefined): SettingsSection | undefined {
  const clean = cleanChoice(value);
  if (clean.startsWith("View Status")) return "Status";
  if (clean.startsWith("Status")) return "Status";
  if (clean.startsWith("Sync Mode")) return "Sync Mode";
  if (clean.startsWith("Chat History")) return "Chat Sync";
  if (clean.startsWith("Chat Sync")) return "Chat Sync";
  if (clean.startsWith("Config Paths")) return "Config Paths";
  if (clean.startsWith("Cleanup")) return "Cleanup";
  if (clean.startsWith("Backups")) return "Backups";
  if (clean.startsWith("Environment")) return "Environment";
  if (clean.startsWith("Diagnostics")) return "Diagnostics";
  if (clean.startsWith("Cancel")) return "Cancel";
  return undefined;
}

function parseSyncModeChoice(value: string | undefined): AutoSyncMode | undefined {
  const clean = cleanChoice(value);
  if (clean.startsWith("Full Sync")) return "full-auto";
  if (clean.startsWith("Config Only")) return "config-only-auto";
  if (clean.startsWith("Manual")) return "manual";
  if (clean.startsWith("Off")) return "off";
  return undefined;
}

function parseChatSyncChoice(value: string | undefined): "Off" | "Archive" | "Resume" | undefined {
  const clean = cleanChoice(value);
  if (clean.startsWith("No Chat Sync")) return "Off";
  if (clean.startsWith("Off")) return "Off";
  if (clean.startsWith("Readable Archive")) return "Archive";
  if (clean.startsWith("Archive")) return "Archive";
  if (clean.startsWith("Resumable Sessions")) return "Resume";
  if (clean.startsWith("Resume")) return "Resume";
  return undefined;
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

function chatSyncChoiceLabel(mode: "Off" | "Archive" | "Resume"): string {
  if (mode === "Off") return "No Chat Sync";
  if (mode === "Archive") return "Readable Archive";
  return "Resumable Sessions";
}

function buildPathChoices(config: PiSyncSuiteConfig): string[] {
  const optionalChoices = getOptionalStoreChoices(config.policy);
  const choices: string[] = [];
  for (const item of optionalChoices) {
    choices.push(
      config.policy.includedPaths.includes(item)
        ? menuLine(`Exclude ${item}`, "included", "remove this optional path")
        : menuLine(`Include ${item}`, "off", "add this optional path"),
    );
  }
  choices.push(
    menuLine("Manual Include", undefined, "add a custom relative path"),
    menuLine("Manual Exclude", undefined, "exclude a custom relative path"),
    menuLine("Cancel", "back", "return to main menu"),
  );
  return choices;
}

function syncModeLabel(mode: AutoSyncMode): string {
  if (mode === "full-auto") return "full";
  if (mode === "config-only-auto") return "config";
  if (mode === "manual") return "manual";
  return "off";
}

function syncModeSummary(mode: AutoSyncMode | undefined): string {
  if (mode === "full-auto") return "auto pull + push";
  if (mode === "config-only-auto") return "auto config sync; chat separate";
  if (mode === "manual") return "push/pull only when commanded";
  if (mode === "off") return "no background sync";
  return "not configured";
}

function chatSyncLabel(config: PiSyncSuiteConfig): string {
  if (config.chat.rawSessionSync) return "resume";
  if (config.chat.autoExport || config.chat.autoUpload || config.chat.autoDownload) return "archive";
  return "off";
}

function chatSyncSummary(config: PiSyncSuiteConfig | null): string {
  if (!config) return "not configured";
  if (config.chat.rawSessionSync) return "raw sessions; resumable";
  if (config.chat.autoExport || config.chat.autoUpload || config.chat.autoDownload) return "readable transcripts";
  return "skip chats";
}

function cleanupSummary(config: PiSyncSuiteConfig | null): string {
  if (!config) return "not configured";
  return `${config.retention.keepChatExports} chats, ${config.retention.keepBackups} backups, ${config.retention.maxAgeDays} days`;
}

function menuLine(label: string, state: string | undefined, description: string): string {
  const suffix = state ? ` [${state}]` : "";
  return `${label}${suffix} ${dim(description)}`;
}

function cleanChoice(value: string | undefined): string {
  return (value ?? "").replace(/\x1b\[[0-9;]*m/g, "").trim();
}

function dim(value: string): string {
  return `\x1b[90m- ${value}\x1b[0m`;
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

async function formatSetupFailure(repoUrl: string, error: unknown): Promise<string> {
  const message = errorMessage(error);
  const hints = [
    `pi-sync setup failed for ${repoUrl}`,
    "",
    message,
  ];
  if (/publickey|permission denied/i.test(message)) {
    const publicKeys = await findSshPublicKeys();
    hints.push(
      "",
      "GitHub SSH is not ready on this machine.",
      "",
      "First check:",
      "  ssh -T git@github.com",
    );
    if (publicKeys.length > 0) {
      const firstKey = publicKeys[0];
      hints.push(
        "",
        `Found SSH public key: ${firstKey.displayPath}`,
        "Add it to GitHub:",
        "  1. Copy it on macOS:",
        `     pbcopy < ${firstKey.displayPath}`,
        "  2. Open https://github.com/settings/keys",
        "  3. New SSH key -> paste -> save",
        "",
        "Then retry /sync-setup.",
      );
    } else {
      hints.push(
        "",
        "No SSH public key was found.",
        "Create one on macOS:",
        "  ssh-keygen -t ed25519 -C \"your_email@example.com\"",
        "  pbcopy < ~/.ssh/id_ed25519.pub",
        "",
        "Then open https://github.com/settings/keys, add the key, and retry /sync-setup.",
      );
    }
    hints.push(
      "",
      "Optional if GitHub CLI is already logged in:",
      "  gh ssh-key add ~/.ssh/id_ed25519.pub --title \"pi-sync\"",
    );
  } else if (/repository.*not.*exist|not found|could not read from remote repository/i.test(message)) {
    hints.push(
      "",
      "Check that the repository exists and that this machine has access to it.",
    );
  }
  return hints.join("\n");
}

async function findSshPublicKeys(): Promise<Array<{ displayPath: string; absolutePath: string }>> {
  const home = os.homedir();
  const sshDir = path.join(home, ".ssh");
  const names = ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"];
  const keys: Array<{ displayPath: string; absolutePath: string }> = [];
  for (const name of names) {
    const absolutePath = path.join(sshDir, name);
    try {
      const stat = await fs.stat(absolutePath);
      if (stat.isFile()) {
        keys.push({ absolutePath, displayPath: `~/.ssh/${name}` });
      }
    } catch {
      // Missing public keys are expected on new machines.
    }
  }
  return keys;
}
