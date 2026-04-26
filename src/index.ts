import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { createDefaultConfig, isAutoPullEnabled, isAutoPushEnabled, loadConfig, saveConfig } from "./config.js";
import { getDefaultPaths } from "./paths.js";
import { pushSnapshot, pullSnapshot } from "./syncEngine.js";
import { exportPiChats } from "./chat/index.js";
import { planCleanup } from "./cleanup.js";
import { formatCleanupPreview, formatStatus } from "./ui/formatters.js";

export default function piSyncSuite(pi: ExtensionAPI): void {
  let configPromise = loadConfig().catch(() => null);
  let pullTimer: ReturnType<typeof setInterval> | undefined;
  let pushDebounce: ReturnType<typeof setTimeout> | undefined;
  let settingsWatcher: { close(): void } | undefined;

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
    if (pushDebounce) clearTimeout(pushDebounce);
    settingsWatcher?.close();
    pullTimer = undefined;
    pushDebounce = undefined;
    settingsWatcher = undefined;
  }

  function startBackgroundWork(ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }) {
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
        const settingsPath = path.join(paths.piDir, "settings.json");
        try {
          settingsWatcher = fs.watch(settingsPath, () => {
            if (pushDebounce) clearTimeout(pushDebounce);
            pushDebounce = setTimeout(() => {
              void pushSnapshot(pi, config).catch((error: unknown) => {
                ctx.ui.notify(`pi-sync push error: ${errorMessage(error)}`, "error");
              });
            }, config.pushDebounceMs);
          });
        } catch {
          // settings.json may not exist on a fresh install.
        }
      }
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    const config = await reloadConfig();
    if (!config) {
      ctx.ui.setStatus("pi-sync", "not configured");
      return;
    }
    ctx.ui.setStatus("pi-sync", `${config.autoMode} -> ${config.repoUrl}`);
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
      await saveConfig(config, paths);
      configPromise = Promise.resolve(config);
      ctx.ui.setStatus("pi-sync", `${config.autoMode} -> ${repoUrl}`);
      ctx.ui.notify(`pi-sync configured: ${repoUrl}`, "info");
      await pushSnapshot(pi, config);
      startBackgroundWork(ctx);
    },
  });

  pi.registerCommand("sync-status", {
    description: "Show Pi Sync Suite status",
    handler: async (_args, ctx) => {
      const config = await currentConfig();
      ctx.ui.notify(formatStatus(config, paths), "info");
    },
  });

  pi.registerCommand("sync-push", {
    description: "Upload portable Pi config and chat exports",
    handler: async (_args, ctx) => {
      const config = await requireConfig(ctx);
      if (!config) return;
      const summary = await pushSnapshot(pi, config);
      ctx.ui.notify(summary.message, "info");
    },
  });

  pi.registerCommand("sync-pull", {
    description: "Download remote updates and apply portable Pi config",
    handler: async (_args, ctx) => {
      const config = await requireConfig(ctx);
      if (!config) return;
      const summary = await pullSnapshot(pi, config);
      ctx.ui.notify(summary.message, "info");
    },
  });

  pi.registerCommand("sync-export-chat", {
    description: "Export local Pi sessions to Markdown and JSON metadata",
    handler: async (_args, ctx) => {
      const results = await exportPiChats({ piDir: paths.piDir, exportsDir: paths.chatExportDir });
      ctx.ui.notify(`pi-sync: exported ${results.length} chat session(s)`, "info");
    },
  });

  pi.registerCommand("sync-clean-preview", {
    description: "Preview cleanup candidates without deleting anything",
    handler: async (_args, ctx) => {
      const config = await requireConfig(ctx);
      if (!config) return;
      const candidates = await planCleanup(config, paths);
      ctx.ui.notify(formatCleanupPreview(candidates), "info");
    },
  });

  async function requireConfig(ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }) {
    const config = await currentConfig();
    if (!config) {
      ctx.ui.notify("pi-sync: not configured. Run /sync-setup <ssh-repo-url>", "warning");
    }
    return config;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
