import type { AutoSyncMode, CleanupCandidate, PiSyncSuiteConfig, SyncPaths } from "../types.js";
import { getOptionalStoreChoices } from "../snapshot/policy.js";

export function formatStatus(config: PiSyncSuiteConfig | null, paths: SyncPaths): string {
  if (!config) {
    return [
      "Pi Sync",
      "",
      "Status: not configured",
      "Run: /sync-setup <ssh-repo-url> [pull-interval-minutes]",
    ].join("\n");
  }
  return [
    "Pi Sync",
    "",
    `Remote: ${config.repoUrl}`,
    `Sync mode: ${formatSyncMode(config.autoMode)}`,
    `Chat history: ${formatChatSync(config)}`,
    `Repo: ${config.repoDir}`,
    `Pi dir: ${paths.piDir}`,
    `Pull interval: ${config.pullIntervalMinutes} min`,
    `Cleanup: ${config.retention.autoApply ? "auto" : "manual"} (${config.retention.keepChatExports} chats, ${config.retention.keepBackups} backups, ${config.retention.maxAgeDays} days)`,
    `Extra paths: ${config.policy.includedPaths.length ? config.policy.includedPaths.join(", ") : "none"}`,
    `Last config sync: ${config.lastConfigSyncAt ?? "never"}`,
    `Last chat sync: ${config.lastChatSyncAt ?? "never"}`,
    "",
    `Optional paths: ${getOptionalStoreChoices(config.policy).join(", ") || "none"}`,
  ].join("\n");
}

function formatSyncMode(mode: AutoSyncMode): string {
  if (mode === "full-auto") return "full - auto pull + push";
  if (mode === "config-only-auto") return "config - auto config sync; chat separate";
  if (mode === "manual") return "manual - push/pull only when commanded";
  return "off - no background sync";
}

function formatChatSync(config: PiSyncSuiteConfig): string {
  if (config.chat.rawSessionSync) return "resume - raw sessions; resumable on another Pi";
  if (config.chat.autoExport || config.chat.autoUpload || config.chat.autoDownload) {
    return "archive - readable transcripts";
  }
  return "off - skip chats";
}

export function formatCleanupPreview(candidates: CleanupCandidate[]): string {
  if (candidates.length === 0) {
    return "pi-sync cleanup: nothing to delete";
  }
  const lines = [`pi-sync cleanup preview: ${candidates.length} candidate(s)`, ""];
  for (const candidate of candidates.slice(0, 25)) {
    lines.push(`- ${candidate.path}`);
    lines.push(`  ${candidate.reason}${candidate.sizeBytes ? `, ${candidate.sizeBytes} bytes` : ""}`);
  }
  if (candidates.length > 25) {
    lines.push(`...and ${candidates.length - 25} more`);
  }
  return lines.join("\n");
}

export function formatStatusWidget(config: PiSyncSuiteConfig | null): string[] {
  if (!config) return ["Pi Sync: not configured", "Run /sync-setup <ssh-repo-url>"];
  return [
    `Pi Sync: ${config.autoMode}`,
    `Remote: ${config.repoUrl}`,
    `Config: ${config.lastConfigSyncAt ?? "never"} | Chat: ${config.lastChatSyncAt ?? "never"}`,
  ];
}
