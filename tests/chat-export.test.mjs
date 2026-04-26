import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportPiChats } from "../dist/chat/index.js";

test("exports Pi JSONL sessions to markdown and metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-suite-"));
  try {
    const piDir = path.join(root, "agent");
    const sessionDir = path.join(piDir, "sessions", "2026", "04");
    const exportsDir = path.join(root, "exports");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, "chat:one.jsonl"),
      [
        JSON.stringify({ timestamp: "2026-04-26T10:00:00.000Z", role: "user", content: "hello <world>" }),
        JSON.stringify({ timestamp: "2026-04-26T10:00:01.000Z", role: "assistant", content: [{ text: "hi" }] }),
        "{broken json",
      ].join("\n"),
      "utf8",
    );

    const results = await exportPiChats({ piDir, exportsDir });

    assert.equal(results.length, 1);
    assert.equal(results[0].metadata.messageCount, 2);
    assert.equal(results[0].metadata.skippedLineCount, 1);
    const markdown = await readFile(results[0].markdownPath, "utf8");
    assert.match(markdown, /hello &lt;world&gt;/);
    assert.match(markdown, /## assistant/);
    const metadata = JSON.parse(await readFile(results[0].metadataPath, "utf8"));
    assert.equal(metadata.sourceRelativePath, "2026/04/chat:one.jsonl");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
