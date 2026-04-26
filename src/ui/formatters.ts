import type { CleanupCandidate, PiSyncSuiteConfig, SyncPaths } from "../types.js";
import { getOptionalStoreChoices } from "../snapshot/policy.js";

export function formatStatus(config: PiSyncSuiteConfig | null, paths: SyncPaths): string {
  if (!config) {
    return [
      "Pi Sync Suite",
      "",
      "Status: not configured",
      "Run: /sync-setup <ssh-repo-url> [pull-interval-minutes]",
    ].join("\n");
  }
  return [
    "Pi Sync Suite",
    "",
    `Remote: ${config.repoUrl}`,
    `Mode: ${config.autoMode}`,
    `Repo: ${config.repoDir}`,
    `Pi dir: ${paths.piDir}`,
    `Config auto upload: ${config.autoMode === "full-auto" || config.autoMode === "config-only-auto" ? "on" : "off"}`,
    `Chat auto export: ${config.chat.autoExport ? "on" : "off"}`,
    `Chat auto upload: ${config.chat.autoUpload ? "on" : "off"}`,
    `Chat auto download: ${config.chat.autoDownload ? "on" : "off"}`,
    `Pull interval: ${config.pullIntervalMinutes} min`,
    `Last config sync: ${config.lastConfigSyncAt ?? "never"}`,
    `Last chat sync: ${config.lastChatSyncAt ?? "never"}`,
    "",
    `Store-this-too choices: ${getOptionalStoreChoices(config.policy).join(", ") || "none"}`,
  ].join("\n");
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
  if (!config) return ["Pi Sync Suite: not configured", "Run /sync-setup <ssh-repo-url>"];
  return [
    `Pi Sync Suite: ${config.autoMode}`,
    `Remote: ${config.repoUrl}`,
    `Config: ${config.lastConfigSyncAt ?? "never"} | Chat: ${config.lastChatSyncAt ?? "never"}`,
  ];
}
