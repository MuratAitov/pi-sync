import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { SyncPaths } from "./types.js";

export function getPiDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

export function getDefaultPaths(piDir = getPiDir()): SyncPaths {
  return {
    piDir,
    configFile: path.join(piDir, "pi-sync-suite.json"),
    repoDir: path.join(piDir, "sync-suite-repo"),
    backupDir: path.join(piDir, "sync-suite-backups"),
    chatExportDir: path.join(piDir, "sync-suite-chat-exports"),
  };
}

export function normalizePortablePath(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new Error(`Unsafe relative path: ${input}`);
  }
  return parts.join("/");
}

export function resolveInside(root: string, portablePath: string): string {
  const clean = normalizePortablePath(portablePath);
  const resolved = path.resolve(root, clean);
  const rootResolved = path.resolve(root);
  const relative = path.relative(rootResolved, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes root: ${portablePath}`);
  }
  return resolved;
}

export function toRepoPath(input: string): string {
  return normalizePortablePath(input);
}

export function safeFileName(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned.slice(0, 120) || "item";
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function timestampForFile(date = new Date()): string {
  return date.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}
