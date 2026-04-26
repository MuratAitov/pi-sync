import { promises as fs } from "node:fs";
import * as path from "node:path";
import { sessionTreeDir, toPortableRelativePath } from "./paths.js";
import { sanitizeFileSegment } from "./sanitize.js";
import type { ChatSessionFile } from "./types.js";

export async function findPiSessionJsonlFiles(piDir: string): Promise<ChatSessionFile[]> {
  const sessionsDir = sessionTreeDir(piDir);
  const files: ChatSessionFile[] = [];

  if (!(await directoryExists(sessionsDir))) {
    return files;
  }

  await walk(sessionsDir, async (absolutePath) => {
    if (!absolutePath.toLowerCase().endsWith(".jsonl")) {
      return;
    }

    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      return;
    }

    const relativePath = toPortableRelativePath(sessionsDir, absolutePath);
    const fileName = relativePath.split("/").pop() ?? "session.jsonl";
    const sessionId = sanitizeFileSegment(fileName.replace(/\.jsonl$/i, ""), "session");

    files.push({
      absolutePath,
      relativePath,
      sessionId,
      modifiedAt: stats.mtime,
      sizeBytes: stats.size,
    });
  });

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function walk(dir: string, onFile: (filePath: string) => Promise<void>): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await walk(entryPath, onFile);
    } else if (entry.isFile()) {
      await onFile(entryPath);
    }
  }
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dir);
    return stats.isDirectory();
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }

    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
