import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const testsDir = path.resolve("tests");
const files = (await readdir(testsDir))
  .filter((file) => file.endsWith(".test.mjs"))
  .sort()
  .map((file) => path.join("tests", file));

const child = spawn(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  shell: false,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
