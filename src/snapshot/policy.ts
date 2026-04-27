import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { PathPolicy } from "../types.js";
import { normalizePortablePath, resolveInside } from "../utils/paths.js";

export const DEFAULT_POLICY: PathPolicy = {
  safeRootFiles: ["settings.json", "keybindings.json", "pi-sync-environment.json"],
  safeDirs: ["themes", "skills", "prompts"],
  optionalFiles: ["AGENTS.md", "CLAUDE.md"],
  optionalDirs: ["extensions", "sync-suite-chat-exports"],
  includedPaths: [],
  excludedPaths: [],
  dangerouslyAllowedNames: [],
  neverSyncNames: [
    "auth.json",
    "sessions",
    "git",
    "npm",
    "bin",
    "node_modules",
    ".env",
    ".ssh",
    "sync-suite-repo",
    "pi-sync-suite.json",
    "pi-sync-environment-ignore.json",
  ],
  strippedSettingsKeys: ["lastChangelogVersion"],
};

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9_]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:api[_-]?key|token|password|secret)\b\s*[:=]\s*["']?[^"'\s]{12,}/i,
];

export function shouldNeverSync(portablePath: string, policy: PathPolicy): boolean {
  const clean = normalizePortablePath(portablePath);
  const parts = clean.split("/");
  return parts.some(
    (part) => policy.neverSyncNames.includes(part) && !policy.dangerouslyAllowedNames.includes(part),
  );
}

export function getPortableSyncPaths(policy: PathPolicy): string[] {
  const paths = [
    ...policy.safeRootFiles,
    ...policy.safeDirs,
    ...policy.includedPaths,
  ].map(normalizePortablePath);
  const unique = new Set<string>();
  for (const item of paths) {
    if (!item || shouldNeverSync(item, policy)) continue;
    if (policy.excludedPaths.map(normalizePortablePath).includes(item)) continue;
    unique.add(item);
  }
  return [...unique].sort();
}

export function getOptionalStoreChoices(policy: PathPolicy): string[] {
  return [...policy.optionalFiles, ...policy.optionalDirs]
    .map(normalizePortablePath)
    .filter((item) => !shouldNeverSync(item, policy))
    .sort();
}

export async function assertSafeSource(root: string, portablePath: string): Promise<void> {
  const resolved = resolveInside(root, portablePath);
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to sync symlink: ${portablePath}`);
  }
}

export async function scanForSecrets(filePath: string): Promise<string[]> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > 1024 * 1024) return [];
  const ext = path.extname(filePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".zip", ".gz"].includes(ext)) {
    return [];
  }
  const text = await fs.readFile(filePath, "utf8").catch(() => "");
  return SECRET_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) =>
    pattern.source,
  );
}
