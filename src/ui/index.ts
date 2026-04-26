import type {
  AutoSyncMode,
  CleanupCandidate,
  CommandContext,
  NotifyLevel,
  PiSyncSuiteConfig,
  SyncPaths,
} from "../types.js";

export interface NativeSelectOption {
  label: string;
  value: string;
  description?: string;
}

export interface NativeCommandUi {
  notify(message: string, level?: NotifyLevel | string): void;
  setStatus?(key: string, value: string): void;
  input?(prompt: string, defaultValue?: string): Promise<string | undefined>;
  select?(
    prompt: string,
    options: readonly NativeSelectOption[],
    defaultValue?: string,
  ): Promise<string | undefined>;
  confirm?(prompt: string, defaultValue?: boolean): Promise<boolean>;
}

export interface NativeCommandContext extends Omit<CommandContext, "ui"> {
  ui: NativeCommandUi;
}

export interface StatusDashboardState {
  configured: boolean;
  repoDir?: string;
  autoMode?: AutoSyncMode;
  configChanged?: boolean;
  chatExportEnabled?: boolean;
  pendingCleanupCount?: number;
  lastConfigSyncAt?: string;
  lastChatSyncAt?: string;
  message?: string;
}

export interface CommandHelpItem {
  command: string;
  summary: string;
  detail?: string;
}

export interface CleanupPreviewOptions {
  maxItems?: number;
  totalBytes?: number;
  title?: string;
}

export interface StoreThisTooOptions {
  prompt?: string;
  alreadyIncluded?: readonly string[];
  allowManualPath?: boolean;
}

export const DEFAULT_COMMAND_HELP: readonly CommandHelpItem[] = [
  {
    command: "pi-sync setup",
    summary: "Create or update the sync configuration.",
    detail: "Requires an SSH git remote; HTTPS remotes are rejected by config loading.",
  },
  {
    command: "pi-sync status",
    summary: "Show repository, automation, chat, and cleanup status.",
  },
  {
    command: "pi-sync sync",
    summary: "Run pull/export/push according to the current mode.",
  },
  {
    command: "pi-sync store-this-too",
    summary: "Add an optional safe path such as AGENTS.md, CLAUDE.md, or chat exports.",
  },
  {
    command: "pi-sync cleanup",
    summary: "Preview old backups and chat exports before deleting anything.",
  },
];

export function renderStatusDashboard(state: StatusDashboardState): string {
  const rows: Array<readonly [string, string]> = [
    ["Configured", yesNo(state.configured)],
    ["Repository", state.repoDir ?? "not set"],
    ["Mode", state.autoMode ?? "not set"],
    ["Config changes", state.configChanged === undefined ? "unknown" : changedText(state.configChanged)],
    ["Chat export", state.chatExportEnabled === undefined ? "unknown" : enabledText(state.chatExportEnabled)],
    ["Cleanup candidates", formatCount(state.pendingCleanupCount)],
    ["Last config sync", formatTimestamp(state.lastConfigSyncAt)],
    ["Last chat sync", formatTimestamp(state.lastChatSyncAt)],
  ];
  const body = renderKeyValueBlock(rows);
  return compactLines(["Pi sync status", underline("Pi sync status"), body, state.message]);
}

export function publishStatusDashboard(ctx: NativeCommandContext, state: StatusDashboardState): string {
  const text = renderStatusDashboard(state);
  ctx.ui.setStatus?.("pi-sync", state.message ?? statusLine(state));
  ctx.ui.notify(text, state.configured ? "info" : "warning");
  return text;
}

export function renderCommandHelp(commands: readonly CommandHelpItem[] = DEFAULT_COMMAND_HELP): string {
  const width = Math.max(...commands.map((item) => item.command.length), "Command".length);
  const rows = commands.flatMap((item) => {
    const line = `${item.command.padEnd(width)}  ${item.summary}`;
    return item.detail ? [line, `${"".padEnd(width)}  ${item.detail}`] : [line];
  });
  return compactLines(["Pi sync commands", underline("Pi sync commands"), rows.join("\n")]);
}

export function showCommandHelp(
  ctx: NativeCommandContext,
  commands: readonly CommandHelpItem[] = DEFAULT_COMMAND_HELP,
): string {
  const text = renderCommandHelp(commands);
  ctx.ui.notify(text, "info");
  return text;
}

export function renderConfigSummary(config: PiSyncSuiteConfig, paths?: Partial<SyncPaths>): string {
  const included = uniqueSorted([
    ...config.policy.safeRootFiles,
    ...config.policy.safeDirs,
    ...config.policy.includedPaths,
  ]);
  const optional = uniqueSorted([...config.policy.optionalFiles, ...config.policy.optionalDirs]);
  const excluded = uniqueSorted(config.policy.excludedPaths);
  const rows: Array<readonly [string, string]> = [
    ["Version", String(config.version)],
    ["Remote", config.repoUrl],
    ["Repository", paths?.repoDir ?? config.repoDir],
    ["Config file", paths?.configFile ?? "default"],
    ["Mode", config.autoMode],
    ["Pull interval", `${config.pullIntervalMinutes} min`],
    ["Push debounce", `${config.pushDebounceMs} ms`],
    ["Chat export", enabledText(config.chat.autoExport)],
    ["Chat upload", enabledText(config.chat.autoUpload)],
    ["Chat download", enabledText(config.chat.autoDownload)],
    ["Chat format", config.chat.exportFormat],
    ["Chat metadata", enabledText(config.chat.includeMetadata)],
    ["Retention", `${config.retention.keepChatExports} chat exports, ${config.retention.keepBackups} backups, ${config.retention.maxAgeDays} days`],
    ["Cleanup auto-apply", enabledText(config.retention.autoApply)],
    ["Included paths", summarizeList(included)],
    ["Optional choices", summarizeList(optional)],
    ["Excluded paths", summarizeList(excluded)],
  ];
  return compactLines(["Pi sync config", underline("Pi sync config"), renderKeyValueBlock(rows)]);
}

export function showConfigSummary(
  ctx: NativeCommandContext,
  config: PiSyncSuiteConfig,
  paths?: Partial<SyncPaths>,
): string {
  const text = renderConfigSummary(config, paths);
  ctx.ui.notify(text, "info");
  return text;
}

export function renderCleanupPreview(
  candidates: readonly CleanupCandidate[],
  options: CleanupPreviewOptions = {},
): string {
  const title = options.title ?? "Cleanup preview";
  if (candidates.length === 0) {
    return compactLines([title, underline(title), "Nothing to remove."]);
  }

  const maxItems = Math.max(1, options.maxItems ?? 20);
  const shown = candidates.slice(0, maxItems);
  const totalBytes = options.totalBytes ?? sumBytes(candidates);
  const rows = shown.map((candidate) => {
    const detail = [
      candidate.reason,
      candidate.sizeBytes === undefined ? undefined : formatBytes(candidate.sizeBytes),
      candidate.modifiedAt === undefined ? undefined : `modified ${formatTimestamp(candidate.modifiedAt)}`,
    ].filter(isPresent);
    return `- ${candidate.path}${detail.length > 0 ? ` (${detail.join(", ")})` : ""}`;
  });
  const remaining = candidates.length - shown.length;
  if (remaining > 0) rows.push(`- ...and ${remaining} more`);

  return compactLines([
    title,
    underline(title),
    `${candidates.length} candidate${candidates.length === 1 ? "" : "s"} (${formatBytes(totalBytes)})`,
    rows.join("\n"),
  ]);
}

export async function confirmCleanupPreview(
  ctx: NativeCommandContext,
  candidates: readonly CleanupCandidate[],
  options: CleanupPreviewOptions = {},
): Promise<boolean> {
  const text = renderCleanupPreview(candidates, options);
  ctx.ui.notify(text, candidates.length === 0 ? "info" : "warning");
  if (candidates.length === 0) return false;
  return ctx.ui.confirm?.("Delete these cleanup candidates?", false) ?? false;
}

export function renderStoreThisTooChoices(
  choices: readonly string[],
  options: StoreThisTooOptions = {},
): string {
  const alreadyIncluded = new Set((options.alreadyIncluded ?? []).map(normalizeChoice));
  const rows = uniqueSorted(choices).map((choice) => {
    const suffix = alreadyIncluded.has(normalizeChoice(choice)) ? " (already included)" : "";
    return `- ${choice}${suffix}`;
  });
  return compactLines([
    "Store this too",
    underline("Store this too"),
    rows.length > 0 ? rows.join("\n") : "No optional choices are configured.",
  ]);
}

export async function chooseStoreThisToo(
  ctx: NativeCommandContext,
  choices: readonly string[],
  options: StoreThisTooOptions = {},
): Promise<string | undefined> {
  const normalizedChoices = uniqueSorted(choices).map(normalizeChoice).filter(Boolean);
  const alreadyIncluded = new Set((options.alreadyIncluded ?? []).map(normalizeChoice));
  const selectable = normalizedChoices.filter((choice) => !alreadyIncluded.has(choice));
  const prompt = options.prompt ?? "Store this too";

  if (selectable.length > 0 && ctx.ui.select) {
    const selected = await ctx.ui.select(
      prompt,
      selectable.map((choice) => ({ label: choice, value: choice })),
      selectable[0],
    );
    return selected ? normalizeChoice(selected) : undefined;
  }

  ctx.ui.notify(renderStoreThisTooChoices(normalizedChoices, options), "info");
  if (!options.allowManualPath || !ctx.ui.input) return undefined;
  const manual = await ctx.ui.input("Path to store", "");
  return manual ? normalizeChoice(manual) : undefined;
}

function renderKeyValueBlock(rows: readonly (readonly [string, string])[]): string {
  const width = Math.max(...rows.map(([key]) => key.length));
  return rows.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join("\n");
}

function compactLines(lines: readonly (string | undefined)[]): string {
  return lines.filter((line): line is string => Boolean(line && line.trim())).join("\n");
}

function underline(value: string): string {
  return "-".repeat(value.length);
}

function statusLine(state: StatusDashboardState): string {
  if (!state.configured) return "not configured";
  if (state.configChanged) return "config changes pending";
  if ((state.pendingCleanupCount ?? 0) > 0) return `${state.pendingCleanupCount} cleanup candidates`;
  return "ready";
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function enabledText(value: boolean): string {
  return value ? "enabled" : "disabled";
}

function changedText(value: boolean): string {
  return value ? "changed" : "clean";
}

function formatCount(value: number | undefined): string {
  return value === undefined ? "unknown" : String(value);
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toISOString();
}

function summarizeList(values: readonly string[], maxItems = 8): string {
  if (values.length === 0) return "none";
  const shown = values.slice(0, maxItems);
  const remaining = values.length - shown.length;
  return remaining > 0 ? `${shown.join(", ")} (+${remaining} more)` : shown.join(", ");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeChoice).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function normalizeChoice(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\/+/, "");
}

function sumBytes(candidates: readonly CleanupCandidate[]): number {
  return candidates.reduce((total, candidate) => total + (candidate.sizeBytes ?? 0), 0);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const precision = unit === 0 || size >= 10 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unit]}`;
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}
