import type { DoctorCheck, PiExecApi, PiSyncSuiteConfig, SyncPaths } from "../types.js";
import { pathExists } from "../utils/paths.js";

export async function runDoctor(
  pi: PiExecApi,
  config: PiSyncSuiteConfig | null,
  paths: SyncPaths,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const git = await pi.exec("git", ["--version"]).catch((error: unknown) => ({
    code: 1,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }));
  checks.push({
    name: "git",
    ok: git.code === 0,
    message: git.code === 0 ? git.stdout.trim() : git.stderr.trim() || "git is not available",
  });
  checks.push({
    name: "config",
    ok: Boolean(config),
    message: config ? `configured for ${config.repoUrl}` : "not configured",
  });
  checks.push({
    name: "pi-dir",
    ok: await pathExists(paths.piDir),
    message: paths.piDir,
  });
  if (config) {
    checks.push({
      name: "repo-dir",
      ok: await pathExists(config.repoDir),
      message: config.repoDir,
    });
    checks.push({
      name: "remote-url",
      ok: !/^https?:\/\//i.test(config.repoUrl),
      message: /^https?:\/\//i.test(config.repoUrl) ? "HTTPS remote is not supported" : "SSH/non-interactive remote",
    });
  }
  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return [
    "Pi Sync Suite doctor",
    "",
    ...checks.map((check) => `${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.message}`),
  ].join("\n");
}
