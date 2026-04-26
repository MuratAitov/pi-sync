import * as path from "node:path";

export function resolveInside(baseDir: string, ...segments: string[]): string {
  const base = path.resolve(baseDir);
  const candidate = path.resolve(base, ...segments);
  const relative = path.relative(base, candidate);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return candidate;
  }

  throw new Error(`Resolved path escapes base directory: ${candidate}`);
}

export function toPortableRelativePath(baseDir: string, targetPath: string): string {
  const relative = path.relative(path.resolve(baseDir), path.resolve(targetPath));

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is not inside base directory: ${targetPath}`);
  }

  return relative.split(path.sep).join("/");
}

export function sessionTreeDir(piDir: string): string {
  return resolveInside(piDir, "sessions");
}

export function withExtension(fileName: string, extension: string): string {
  const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
  return `${fileName}${normalizedExtension}`;
}
