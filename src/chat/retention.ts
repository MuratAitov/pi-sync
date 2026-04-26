import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { RetentionPlan, RetentionPlanItem, RetentionPolicy } from "./types.js";

const EXPORT_EXTENSIONS = new Set([".md", ".json"]);

export async function planExportRetention(
  exportsDir: string,
  policy: RetentionPolicy,
): Promise<RetentionPlan> {
  const now = policy.now ?? new Date();
  const files = await listExportFiles(exportsDir);
  const deleteCandidates = new Map<string, RetentionPlanItem>();
  const keep = new Map<string, RetentionPlanItem>();

  for (const file of files) {
    const ageMs = now.getTime() - file.modifiedAt.getTime();
    const maxAgeMs =
      typeof policy.maxAgeDays === "number" ? policy.maxAgeDays * 24 * 60 * 60 * 1000 : undefined;

    if (maxAgeMs !== undefined && ageMs > maxAgeMs) {
      deleteCandidates.set(file.path, { ...file, reason: `older than ${policy.maxAgeDays} days` });
    } else {
      keep.set(file.path, { ...file, reason: "within retention policy" });
    }
  }

  if (typeof policy.maxExportCount === "number" && policy.maxExportCount >= 0) {
    const newestFirst = [...files].sort((left, right) => right.modifiedAt.getTime() - left.modifiedAt.getTime());
    const overflow = newestFirst.slice(policy.maxExportCount);

    for (const file of overflow) {
      deleteCandidates.set(file.path, {
        ...file,
        reason: `exceeds newest ${policy.maxExportCount} export files`,
      });
      keep.delete(file.path);
    }
  }

  return {
    deleteCandidates: [...deleteCandidates.values()].sort(sortOldestFirst),
    keep: [...keep.values()].sort(sortNewestFirst),
  };
}

async function listExportFiles(exportsDir: string): Promise<RetentionPlanItem[]> {
  try {
    const entries = await fs.readdir(exportsDir, { withFileTypes: true });
    const files: RetentionPlanItem[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !EXPORT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }

      const filePath = path.join(exportsDir, entry.name);
      const stats = await fs.stat(filePath);
      files.push({
        path: filePath,
        reason: "candidate",
        modifiedAt: stats.mtime,
        sizeBytes: stats.size,
      });
    }

    return files;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

function sortOldestFirst(left: RetentionPlanItem, right: RetentionPlanItem): number {
  return left.modifiedAt.getTime() - right.modifiedAt.getTime();
}

function sortNewestFirst(left: RetentionPlanItem, right: RetentionPlanItem): number {
  return right.modifiedAt.getTime() - left.modifiedAt.getTime();
}
