import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportPiChats, parseJsonlSession } from "../dist/chat/index.js";

test("exports Pi JSONL sessions to markdown and metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-suite-"));
  try {
    const piDir = path.join(root, "agent");
    const sessionDir = path.join(piDir, "sessions", "2026", "04");
    const exportsDir = path.join(root, "exports");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, "chat-one.jsonl"),
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
    assert.match(markdown, /## Assistant/);
    const metadata = JSON.parse(await readFile(results[0].metadataPath, "utf8"));
    assert.equal(metadata.sourceRelativePath, "2026/04/chat-one.jsonl");
    assert.equal(metadata.redactedMessageCount, 0);
    assert.equal(metadata.omittedMessageCount, 0);
    assert.equal(metadata.truncatedMessageCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readable archive redacts secrets without dropping surrounding user content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-chat-secrets-"));
  try {
    const sessionPath = path.join(root, "session.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-04-26T10:00:00.000Z",
          role: "user",
          content: "keep this context\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890\nkeep this too",
        }),
        JSON.stringify({
          role: "assistant",
          content: "The token was found in the env file.",
        }),
      ].join("\n"),
      "utf8",
    );

    const parsed = await parseJsonlSession(sessionPath);

    assert.equal(parsed.messages.length, 2);
    assert.equal(parsed.redactedMessageCount, 1);
    assert.match(parsed.messages[0].content, /keep this context/);
    assert.match(parsed.messages[0].content, /\[redacted secret-like content\]/);
    assert.match(parsed.messages[0].content, /keep this too/);
    assert.doesNotMatch(parsed.messages[0].content, /ghp_abcdefghijklmnopqrstuvwxyz/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readable archive omits internal reasoning but keeps a visible placeholder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-chat-internal-"));
  try {
    const sessionPath = path.join(root, "session.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ type: "reasoning", role: "assistant", content: "private chain of thought" }),
        JSON.stringify({ role: "assistant", content: "Public answer" }),
      ].join("\n"),
      "utf8",
    );

    const parsed = await parseJsonlSession(sessionPath);

    assert.equal(parsed.messages.length, 2);
    assert.equal(parsed.omittedMessageCount, 1);
    assert.equal(parsed.messages[0].role, "internal");
    assert.match(parsed.messages[0].content, /\[internal reasoning omitted\]/);
    assert.doesNotMatch(parsed.messages[0].content, /private chain of thought/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readable archive omits base64 image and binary blobs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-chat-binary-"));
  try {
    const sessionPath = path.join(root, "session.jsonl");
    const longBase64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".repeat(12);
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ role: "user", content: `image data:image/png;base64,${longBase64} done` }),
        JSON.stringify({ role: "assistant", content: `blob ${longBase64}` }),
      ].join("\n"),
      "utf8",
    );

    const parsed = await parseJsonlSession(sessionPath);

    assert.equal(parsed.messages.length, 2);
    assert.equal(parsed.omittedMessageCount, 2);
    assert.match(parsed.messages[0].content, /\[binary\/image content omitted\]/);
    assert.match(parsed.messages[1].content, /\[binary\/image content omitted\]/);
    assert.doesNotMatch(parsed.messages[0].content, new RegExp(`A{${longBase64.length}}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readable archive truncates huge output while preserving beginning and end", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-chat-large-"));
  try {
    const sessionPath = path.join(root, "session.jsonl");
    const hugeOutput = `START\n${"x".repeat(24_000)}\nEND`;
    await writeFile(
      sessionPath,
      JSON.stringify({ role: "tool", name: "npm test", stdout: hugeOutput }),
      "utf8",
    );

    const parsed = await parseJsonlSession(sessionPath);

    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.truncatedMessageCount, 1);
    assert.equal(parsed.messages[0].role, "tool");
    assert.match(parsed.messages[0].content, /START/);
    assert.match(parsed.messages[0].content, /END/);
    assert.match(parsed.messages[0].content, /\[truncated \d+ characters from large output\]/);
    assert.ok(parsed.messages[0].content.length < hugeOutput.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readable archive combines tool stdout and stderr", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-chat-tool-"));
  try {
    const sessionPath = path.join(root, "session.jsonl");
    await writeFile(
      sessionPath,
      JSON.stringify({ type: "tool_result", name: "pytest", stdout: "10 passed", stderr: "warning: slow test" }),
      "utf8",
    );

    const parsed = await parseJsonlSession(sessionPath);

    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.messages[0].role, "tool");
    assert.equal(parsed.messages[0].toolName, "pytest");
    assert.match(parsed.messages[0].content, /10 passed/);
    assert.match(parsed.messages[0].content, /warning: slow test/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readable archive normalizes common JSONL shapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-chat-shapes-"));
  try {
    const sessionPath = path.join(root, "session.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "array text" }] } }),
        JSON.stringify({ delta: { role: "assistant", content: "delta text" } }),
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "choice text" } }] }),
        JSON.stringify({ speaker: "user", body: { value: "body value" } }),
        JSON.stringify({ type: "heartbeat" }),
        "{bad json",
      ].join("\n"),
      "utf8",
    );

    const parsed = await parseJsonlSession(sessionPath);

    assert.equal(parsed.messages.length, 4);
    assert.equal(parsed.skippedLineCount, 2);
    assert.deepEqual(parsed.messages.map((message) => message.content), [
      "array text",
      "delta text",
      "choice text",
      "body value",
    ]);
    assert.deepEqual(parsed.messages.map((message) => message.role), [
      "user",
      "assistant",
      "assistant",
      "user",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("export metadata counts redacted omitted and truncated archive messages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sync-chat-metadata-"));
  try {
    const piDir = path.join(root, "agent");
    const sessionDir = path.join(piDir, "sessions");
    const exportsDir = path.join(root, "exports");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, "counts.jsonl"),
      [
        JSON.stringify({ role: "user", content: "api_key = abcdefghijklmnopqrstuvwxyz" }),
        JSON.stringify({ type: "thinking", content: "private notes" }),
        JSON.stringify({ role: "tool", stdout: `BEGIN ${"z".repeat(24_000)} END` }),
      ].join("\n"),
      "utf8",
    );

    const [result] = await exportPiChats({ piDir, exportsDir });
    const metadata = JSON.parse(await readFile(result.metadataPath, "utf8"));
    const markdown = await readFile(result.markdownPath, "utf8");

    assert.equal(metadata.messageCount, 3);
    assert.equal(metadata.redactedMessageCount, 1);
    assert.equal(metadata.omittedMessageCount, 1);
    assert.equal(metadata.truncatedMessageCount, 1);
    assert.match(markdown, /Secret-like content was redacted/);
    assert.match(markdown, /Internal reasoning was omitted/);
    assert.match(markdown, /Large content was truncated/);
    assert.doesNotMatch(markdown, /abcdefghijklmnopqrstuvwxyz/);
    assert.doesNotMatch(markdown, /private notes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
