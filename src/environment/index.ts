import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PiExecApi } from "../types.js";
import { pathExists } from "../utils/paths.js";

export const ENVIRONMENT_MANIFEST = "pi-sync-environment.json";
export const ENVIRONMENT_IGNORE_FILE = "pi-sync-environment-ignore.json";

export type EnvironmentPackageManager = "npm" | "pi";
export type EnvironmentPackageStatus = "installed" | "missing" | "ignored" | "unknown";

export interface EnvironmentPackageSpec {
  manager: EnvironmentPackageManager;
  name: string;
  spec: string;
}

export interface EnvironmentRestorePlan {
  manifestPath: string;
  ignorePath: string;
  packages: EnvironmentPackageSpec[];
  entries: Array<EnvironmentPackageSpec & { status: EnvironmentPackageStatus; reason?: string }>;
}

type ManifestPackageValue = string[] | Record<string, string | number | boolean | null | undefined> | undefined;

interface EnvironmentManifest {
  npm?: ManifestPackageValue;
  pi?: ManifestPackageValue;
}

interface EnvironmentIgnoreManifest {
  packages?: string[];
}

export async function loadEnvironmentPackages(piDir: string): Promise<EnvironmentPackageSpec[]> {
  const manifestPath = path.join(piDir, ENVIRONMENT_MANIFEST);
  if (!(await pathExists(manifestPath))) return [];
  const raw = JSON.parse(await fs.readFile(manifestPath, "utf8")) as EnvironmentManifest;
  return [
    ...normalizeNpmPackages(raw.npm),
    ...normalizePiPackages(raw.pi),
  ].sort((left, right) => `${left.manager}:${left.spec}`.localeCompare(`${right.manager}:${right.spec}`));
}

export async function planEnvironmentRestore(
  pi: PiExecApi,
  piDir: string,
): Promise<EnvironmentRestorePlan> {
  const manifestPath = path.join(piDir, ENVIRONMENT_MANIFEST);
  const ignorePath = path.join(piDir, ENVIRONMENT_IGNORE_FILE);
  const packages = await loadEnvironmentPackages(piDir);
  const ignored = await loadIgnoredEnvironmentPackages(piDir);
  const [npmInstalled, piInstalled] = await Promise.all([
    installedNpmPackages(pi),
    installedPiPackages(pi),
  ]);
  const entries = packages.map((item) => {
    if (ignored.has(environmentPackageKey(item))) {
      return { ...item, status: "ignored" as const, reason: "ignored on this device" };
    }
    const installed = item.manager === "npm" ? npmInstalled : piInstalled;
    if (!installed.available) {
      return {
        ...item,
        status: "unknown" as const,
        reason: `${item.manager} is not available or did not return an installed package list`,
      };
    }
    return {
      ...item,
      status: installed.names.has(item.name) || installed.names.has(item.spec) ? "installed" as const : "missing" as const,
    };
  });
  return { manifestPath, ignorePath, packages, entries };
}

export async function installMissingEnvironmentPackages(
  pi: PiExecApi,
  plan: EnvironmentRestorePlan,
): Promise<string[]> {
  return installEnvironmentPackages(pi, plan.entries.filter((item) => item.status === "missing"));
}

export async function installEnvironmentPackages(
  pi: PiExecApi,
  packages: EnvironmentPackageSpec[],
): Promise<string[]> {
  const installed: string[] = [];
  for (const item of packages) {
    if (item.manager === "npm") {
      assertOk(await pi.exec("npm", ["install", "-g", item.spec]), `npm install failed for ${item.spec}`);
    } else {
      assertOk(await pi.exec("pi", ["install", item.spec]), `pi install failed for ${item.spec}`);
    }
    installed.push(`${item.manager}:${item.spec}`);
  }
  return installed;
}

export async function ignoreEnvironmentPackage(piDir: string, item: EnvironmentPackageSpec): Promise<void> {
  const ignored = await loadIgnoredEnvironmentPackages(piDir);
  ignored.add(environmentPackageKey(item));
  await saveIgnoredEnvironmentPackages(piDir, ignored);
}

export async function clearIgnoredEnvironmentPackages(piDir: string): Promise<void> {
  await fs.rm(path.join(piDir, ENVIRONMENT_IGNORE_FILE), { force: true });
}

export async function loadIgnoredEnvironmentPackages(piDir: string): Promise<Set<string>> {
  const ignorePath = path.join(piDir, ENVIRONMENT_IGNORE_FILE);
  if (!(await pathExists(ignorePath))) return new Set();
  const raw = JSON.parse(await fs.readFile(ignorePath, "utf8")) as EnvironmentIgnoreManifest;
  return new Set((raw.packages ?? []).filter((item) => typeof item === "string" && item.trim().length > 0));
}

export function formatEnvironmentRestorePlan(plan: EnvironmentRestorePlan): string {
  if (plan.packages.length === 0) {
    return [
      "Environment restore",
    "",
    `Manifest: ${plan.manifestPath}`,
    `Ignored: ${plan.ignorePath}`,
    "No packages are listed yet.",
  ].join("\n");
  }

  const lines = [
    "Environment restore",
    "",
    `Manifest: ${plan.manifestPath}`,
    `Ignored: ${plan.ignorePath}`,
    "",
  ];
  for (const item of plan.entries) {
    const status = item.status === "installed" ? "installed" : item.status === "missing" ? "missing" : item.status === "ignored" ? "ignored" : "unknown";
    lines.push(`- ${item.manager}:${item.spec} [${status}]${item.reason ? ` - ${item.reason}` : ""}`);
  }
  return lines.join("\n");
}

export function missingEnvironmentCount(plan: EnvironmentRestorePlan): number {
  return plan.entries.filter((item) => item.status === "missing").length;
}

export function environmentPackageKey(item: EnvironmentPackageSpec): string {
  return `${item.manager}:${item.spec}`;
}

async function saveIgnoredEnvironmentPackages(piDir: string, ignored: Set<string>): Promise<void> {
  const ignorePath = path.join(piDir, ENVIRONMENT_IGNORE_FILE);
  const packages = [...ignored].sort();
  if (packages.length === 0) {
    await fs.rm(ignorePath, { force: true });
    return;
  }
  await fs.writeFile(ignorePath, `${JSON.stringify({ packages }, null, 2)}\n`, "utf8");
}

function normalizeNpmPackages(value: ManifestPackageValue): EnvironmentPackageSpec[] {
  return normalizeManifestPackages(value, "npm").map((item) => {
    const name = npmPackageNameFromSpec(item);
    if (!isSafeNpmPackageName(name) || !isSafeNpmPackageSpec(item)) {
      throw new Error(`Unsafe npm package spec in ${ENVIRONMENT_MANIFEST}: ${item}`);
    }
    return { manager: "npm", name, spec: item };
  });
}

function normalizePiPackages(value: ManifestPackageValue): EnvironmentPackageSpec[] {
  return normalizeManifestPackages(value, "pi").map((item) => {
    if (!isSafePiPackageSpec(item)) {
      throw new Error(`Unsafe Pi package spec in ${ENVIRONMENT_MANIFEST}: ${item}`);
    }
    return { manager: "pi", name: item, spec: item };
  });
}

function normalizeManifestPackages(value: ManifestPackageValue, manager: EnvironmentPackageManager): string[] {
  if (!value) return [];
  const specs = Array.isArray(value)
    ? value
    : Object.entries(value).map(([name, version]) => packageSpec(name, version));
  return [...new Set(specs.map((item) => item.trim()).filter(Boolean))]
    .map((item) => manager === "pi" && !item.includes(":") ? `npm:${item}` : item)
    .sort();
}

function packageSpec(name: string, version: string | number | boolean | null | undefined): string {
  const cleanName = name.trim();
  if (version === undefined || version === null || version === true || version === "*" || version === "latest") {
    return cleanName;
  }
  if (version === false) return "";
  return `${cleanName}@${String(version).trim()}`;
}

function npmPackageNameFromSpec(spec: string): string {
  if (spec.startsWith("@")) {
    const secondAt = spec.indexOf("@", 1);
    return secondAt === -1 ? spec : spec.slice(0, secondAt);
  }
  const firstAt = spec.indexOf("@");
  return firstAt === -1 ? spec : spec.slice(0, firstAt);
}

function isSafeNpmPackageName(name: string): boolean {
  return /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name);
}

function isSafeNpmPackageSpec(spec: string): boolean {
  if (/\s/.test(spec) || /[;&|`$<>\\]/.test(spec)) return false;
  if (/^(?:https?:|git[+:]|file:|\.{0,2}\/)/i.test(spec)) return false;
  const name = npmPackageNameFromSpec(spec);
  const suffix = spec.slice(name.length);
  return suffix === "" || /^@[A-Za-z0-9._~^*+=:<>\|-]+$/.test(suffix);
}

function isSafePiPackageSpec(spec: string): boolean {
  if (/\s/.test(spec) || /[;&|`$<>\\]/.test(spec)) return false;
  if (/^(?:https?:|git[+:]|file:|\.{0,2}\/)/i.test(spec)) return false;
  return /^(?:npm|pi):[A-Za-z0-9@._~^*+=:\/-]+$/.test(spec);
}

async function installedNpmPackages(pi: PiExecApi): Promise<{ available: boolean; names: Set<string> }> {
  const result = await pi.exec("npm", ["ls", "-g", "--depth=0", "--json"]);
  if (result.code !== 0 && !result.stdout.trim()) return { available: false, names: new Set() };
  try {
    const parsed = JSON.parse(result.stdout || "{}") as { dependencies?: Record<string, unknown> };
    return { available: true, names: new Set(Object.keys(parsed.dependencies ?? {})) };
  } catch {
    return { available: false, names: new Set() };
  }
}

async function installedPiPackages(pi: PiExecApi): Promise<{ available: boolean; names: Set<string> }> {
  const jsonResult = await pi.exec("pi", ["list", "--json"]);
  if (jsonResult.code === 0 && jsonResult.stdout.trim()) {
    const names = packageNamesFromUnknownJson(jsonResult.stdout);
    if (names.size > 0) return { available: true, names };
  }

  const textResult = await pi.exec("pi", ["list"]);
  if (textResult.code !== 0) return { available: false, names: new Set() };
  return { available: true, names: packageNamesFromText(textResult.stdout) };
}

function packageNamesFromUnknownJson(stdout: string): Set<string> {
  try {
    return collectPackageNames(JSON.parse(stdout));
  } catch {
    return new Set();
  }
}

function collectPackageNames(value: unknown): Set<string> {
  const names = new Set<string>();
  if (typeof value === "string") {
    names.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      for (const name of collectPackageNames(item)) names.add(name);
    }
  } else if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    for (const key of ["name", "spec", "id", "package"]) {
      if (typeof objectValue[key] === "string") names.add(objectValue[key]);
    }
    for (const item of Object.values(objectValue)) {
      if (typeof item === "object") {
        for (const name of collectPackageNames(item)) names.add(name);
      }
    }
  }
  return names;
}

function packageNamesFromText(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || clean.startsWith("#")) continue;
    const first = clean.split(/\s+/)[0];
    if (first) names.add(first);
  }
  return names;
}

function assertOk(result: { code: number; stderr?: string }, fallback: string): void {
  if (result.code !== 0) {
    throw new Error(result.stderr?.trim() || fallback);
  }
}
