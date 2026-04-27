import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearIgnoredEnvironmentPackages,
  ignoreEnvironmentPackage,
  installMissingEnvironmentPackages,
  loadEnvironmentPackages,
  planEnvironmentRestore,
} from "../dist/environment/index.js";

test("environment manifest normalizes npm and Pi package specs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-env-manifest-"));
  try {
    await writeFile(
      path.join(root, "pi-sync-environment.json"),
      JSON.stringify({
        npm: {
          typescript: "5.8.0",
          "@scope/tool": "1.2.3",
          prettier: "latest",
        },
        pi: ["npm:@team/pi-extension@2.0.0", "local-pi-package"],
      }),
      "utf8",
    );

    const packages = await loadEnvironmentPackages(root);

    assert.deepEqual(packages.map((item) => `${item.manager}:${item.spec}`), [
      "npm:@scope/tool@1.2.3",
      "npm:prettier",
      "npm:typescript@5.8.0",
      "pi:npm:@team/pi-extension@2.0.0",
      "pi:npm:local-pi-package",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("environment manifest rejects unsafe package specs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-env-unsafe-"));
  try {
    await writeFile(
      path.join(root, "pi-sync-environment.json"),
      JSON.stringify({ npm: ["left-pad; rm -rf ."] }),
      "utf8",
    );

    await assert.rejects(() => loadEnvironmentPackages(root), /Unsafe npm package spec/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("environment restore detects missing packages and installs only missing entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-env-plan-"));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "pi-sync-environment.json"),
      JSON.stringify({
        npm: ["typescript@5.8.0", "prettier"],
        pi: ["npm:@team/pi-extension"],
      }),
      "utf8",
    );
    const calls = [];
    const pi = {
      exec: async (command, args) => {
        calls.push([command, args]);
        if (command === "npm" && args[0] === "ls") {
          return {
            code: 0,
            stdout: JSON.stringify({ dependencies: { prettier: { version: "3.0.0" } } }),
            stderr: "",
          };
        }
        if (command === "pi" && args[0] === "list" && args[1] === "--json") {
          return { code: 0, stdout: JSON.stringify([{ name: "npm:already-installed" }]), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const plan = await planEnvironmentRestore(pi, root);

    assert.deepEqual(
      plan.entries.map((item) => `${item.manager}:${item.spec}:${item.status}`),
      [
        "npm:prettier:installed",
        "npm:typescript@5.8.0:missing",
        "pi:npm:@team/pi-extension:missing",
      ],
    );

    const installed = await installMissingEnvironmentPackages(pi, plan);

    assert.deepEqual(installed, ["npm:typescript@5.8.0", "pi:npm:@team/pi-extension"]);
    assert.deepEqual(calls.slice(-2), [
      ["npm", ["install", "-g", "typescript@5.8.0"]],
      ["pi", ["install", "npm:@team/pi-extension"]],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("environment restore keeps ignored packages local to the device", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-env-ignore-"));
  try {
    await writeFile(
      path.join(root, "pi-sync-environment.json"),
      JSON.stringify({ npm: ["typescript@5.8.0", "prettier"] }),
      "utf8",
    );
    const pi = {
      exec: async (command, args) => {
        if (command === "npm" && args[0] === "ls") {
          return { code: 0, stdout: JSON.stringify({ dependencies: {} }), stderr: "" };
        }
        if (command === "pi" && args[0] === "list" && args[1] === "--json") {
          return { code: 0, stdout: JSON.stringify([]), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    let plan = await planEnvironmentRestore(pi, root);
    const typescript = plan.entries.find((item) => item.spec === "typescript@5.8.0");
    assert.ok(typescript);

    await ignoreEnvironmentPackage(root, typescript);
    plan = await planEnvironmentRestore(pi, root);

    assert.deepEqual(
      plan.entries.map((item) => `${item.spec}:${item.status}`),
      ["prettier:missing", "typescript@5.8.0:ignored"],
    );

    await clearIgnoredEnvironmentPackages(root);
    plan = await planEnvironmentRestore(pi, root);

    assert.deepEqual(
      plan.entries.map((item) => `${item.spec}:${item.status}`),
      ["prettier:missing", "typescript@5.8.0:missing"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
