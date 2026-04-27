import { promises as fs } from "node:fs";
import { findPiSessionJsonlFiles } from "./sessionScanner.js";
import { resolveInside, withExtension } from "./paths.js";
import { coerceText, markdownEscape, sanitizeFileSegment } from "./sanitize.js";
import type {
  ChatExportMetadata,
  ChatExportOptions,
  ChatExportResult,
  ChatMessage,
  ChatSessionFile,
  JsonObject,
} from "./types.js";

const MAX_CONTENT_CHARS = 20_000;
const TRUNCATE_HEAD_CHARS = 8_000;
const TRUNCATE_TAIL_CHARS = 4_000;
const SECRET_REPLACEMENT = "[redacted secret-like content]";
const INTERNAL_REPLACEMENT = "[internal reasoning omitted]";
const BINARY_REPLACEMENT = "[binary/image content omitted]";

const SECRET_TEXT_PATTERNS = [
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g,
  /\bghp_[A-Za-z0-9_]{30,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)\b\s*[:=]\s*["']?[^"'\s]+/gi,
  /\b(?:api[_-]?key|token|password|secret)\b\s*[:=]\s*["']?[^"'\s]{12,}/gi,
];

const DATA_URI_PATTERN = /data:[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=\s]{80,}/gi;
const LONG_BASE64_PATTERN = /\b[A-Za-z0-9+/]{512,}={0,2}\b/g;
const INTERNAL_MARKERS = ["reasoning", "thinking", "chain_of_thought", "thought", "internal"];
const TOOL_MARKERS = ["tool", "function", "command", "bash", "shell"];

export async function exportPiChats(options: ChatExportOptions): Promise<ChatExportResult[]> {
  const sessions = await findPiSessionJsonlFiles(options.piDir);
  const results: ChatExportResult[] = [];

  await fs.mkdir(options.exportsDir, { recursive: true });

  for (const session of sessions) {
    results.push(await exportPiSession(session, options));
  }

  return results;
}

export async function exportPiSession(
  session: ChatSessionFile,
  options: ChatExportOptions,
): Promise<ChatExportResult> {
  const exportedAt = options.now ?? new Date();
  const exportBaseName = exportBaseNameForSession(session);
  const markdownPath = resolveInside(options.exportsDir, withExtension(exportBaseName, ".md"));
  const metadataPath = resolveInside(options.exportsDir, withExtension(exportBaseName, ".metadata.json"));
  const parsed = await parseJsonlSession(session.absolutePath);
  const markdown = renderMarkdown(session, parsed.messages, exportedAt);
  const metadata: ChatExportMetadata = {
    sourcePath: session.absolutePath,
    sourceRelativePath: session.relativePath,
    sessionId: session.sessionId,
    exportedAt: exportedAt.toISOString(),
    messageCount: parsed.messages.length,
    skippedLineCount: parsed.skippedLineCount,
    redactedMessageCount: parsed.redactedMessageCount,
    omittedMessageCount: parsed.omittedMessageCount,
    truncatedMessageCount: parsed.truncatedMessageCount,
    sourceModifiedAt: session.modifiedAt.toISOString(),
    sourceSizeBytes: session.sizeBytes,
    markdownPath,
    metadataPath,
  };

  await fs.writeFile(markdownPath, markdown, "utf8");
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  return {
    session,
    markdownPath,
    metadataPath,
    metadata,
  };
}

export async function parseJsonlSession(
  filePath: string,
): Promise<{
  messages: ChatMessage[];
  skippedLineCount: number;
  redactedMessageCount: number;
  omittedMessageCount: number;
  truncatedMessageCount: number;
}> {
  const contents = await fs.readFile(filePath, "utf8");
  const messages: ChatMessage[] = [];
  let skippedLineCount = 0;
  let redactedMessageCount = 0;
  let omittedMessageCount = 0;
  let truncatedMessageCount = 0;

  contents.split(/\r?\n/).forEach((line: string) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    try {
      const raw = JSON.parse(trimmed) as JsonObject;
      const message = normalizeMessage(raw, messages.length);

      if (!message) {
        skippedLineCount += 1;
        return;
      }

      if (message.redacted) redactedMessageCount += 1;
      if (message.omitted) omittedMessageCount += 1;
      if (message.truncated) truncatedMessageCount += 1;
      messages.push(message);
    } catch {
      skippedLineCount += 1;
      return;
    }
  });

  return { messages, skippedLineCount, redactedMessageCount, omittedMessageCount, truncatedMessageCount };
}

function renderMarkdown(session: ChatSessionFile, messages: ChatMessage[], exportedAt: Date): string {
  const lines = [
    `# ${markdownEscape(session.sessionId)}`,
    "",
    `- Source: \`${markdownEscape(session.relativePath)}\``,
    `- Exported: ${exportedAt.toISOString()}`,
    `- Messages: ${messages.length}`,
    "",
  ];

  for (const message of messages) {
    const title = messageTitle(message);
    lines.push(`## ${markdownEscape(title)}`);

    if (message.timestamp) {
      lines.push("");
      lines.push(`_Timestamp: ${markdownEscape(message.timestamp)}_`);
    }

    if (message.annotations.length > 0) {
      lines.push("");
      for (const annotation of message.annotations) {
        lines.push(`_${markdownEscape(annotation)}_`);
      }
    }

    lines.push("");
    lines.push(markdownEscape(message.content));
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function normalizeMessage(raw: JsonObject, index: number): ChatMessage | undefined {
  const role = normalizeRole(raw);
  const content = extractMessageContent(raw, role);
  const isInternal = hasInternalMarker(raw) || role === "internal";

  if (isInternal) {
    return {
      index,
      raw,
      timestamp: extractTimestamp(raw),
      role: "internal",
      author: extractString(raw, ["author", "name", "user"]),
      toolName: extractToolName(raw),
      content: INTERNAL_REPLACEMENT,
      annotations: ["Internal reasoning was omitted from the readable archive."],
      redacted: false,
      omitted: true,
      truncated: false,
    };
  }

  if (!content) return undefined;

  const annotations: string[] = [];
  let redacted = false;
  let omitted = false;
  let truncated = false;
  let safeContent = content;

  const binaryResult = omitBinaryContent(safeContent);
  safeContent = binaryResult.content;
  if (binaryResult.changed) {
    omitted = true;
    annotations.push("Binary or image content was omitted.");
  }

  const secretResult = redactSecrets(safeContent);
  safeContent = secretResult.content;
  if (secretResult.changed) {
    redacted = true;
    annotations.push("Secret-like content was redacted.");
  }

  const truncateResult = truncateLargeContent(safeContent);
  safeContent = truncateResult.content;
  if (truncateResult.changed) {
    truncated = true;
    annotations.push(`Large content was truncated from ${truncateResult.originalLength} to ${safeContent.length} characters.`);
  }

  return {
    index,
    raw,
    timestamp: extractTimestamp(raw),
    role,
    author: extractString(raw, ["author", "name", "user"]),
    toolName: extractToolName(raw),
    content: safeContent,
    annotations,
    redacted,
    omitted,
    truncated,
  };
}

function extractMessageContent(raw: JsonObject, role?: string): string | undefined {
  const nestedMessage = asObject(raw.message);
  const nestedDelta = asObject(raw.delta);
  const nestedChoice = firstChoiceObject(raw);

  if (role === "tool") {
    const toolText = [
      raw.content,
      raw.output,
      raw.stdout,
      raw.stderr,
      raw.result,
      raw.text,
      raw.body,
      raw.command,
    ]
      .map((candidate) => coerceText(candidate))
      .filter((candidate): candidate is string => Boolean(candidate));
    if (toolText.length > 0) return uniqueStrings(toolText).join("\n");
  }

  const candidates = [
    raw.content,
    raw.text,
    raw.body,
    raw.message,
    raw.delta,
    raw.output,
    raw.stdout,
    raw.stderr,
    raw.result,
    nestedMessage?.content,
    nestedMessage?.text,
    nestedDelta?.content,
    nestedDelta?.text,
    nestedChoice?.message,
    nestedChoice?.delta,
  ];

  const text = candidates.map((candidate) => coerceText(candidate)).find((candidate) => Boolean(candidate));
  if (text) return text;

  return undefined;
}

function extractString(raw: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function extractTimestamp(raw: JsonObject): string | undefined {
  return extractString(raw, ["timestamp", "created_at", "createdAt", "time"]);
}

function normalizeRole(raw: JsonObject): string | undefined {
  const nestedMessage = asObject(raw.message);
  const nestedDelta = asObject(raw.delta);
  const nestedChoice = firstChoiceObject(raw);
  const choiceMessage = asObject(nestedChoice?.message);
  const choiceDelta = asObject(nestedChoice?.delta);
  const candidates = [
    extractString(raw, ["role", "speaker"]),
    stringValue(nestedMessage?.role),
    stringValue(nestedDelta?.role),
    stringValue(choiceMessage?.role),
    stringValue(choiceDelta?.role),
    extractString(raw, ["type", "event"]),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const lowered = candidate.toLowerCase();
    if (lowered.includes("assistant")) return "assistant";
    if (lowered.includes("user")) return "user";
    if (lowered.includes("system")) return "system";
    if (hasMarker(lowered, TOOL_MARKERS)) return "tool";
    if (hasMarker(lowered, INTERNAL_MARKERS)) return "internal";
  }

  return candidates[0];
}

function extractToolName(raw: JsonObject): string | undefined {
  const functionCall = asObject(raw.function_call) ?? asObject(raw.function);
  const toolCall = asObject(raw.tool_call) ?? asObject(raw.tool);
  return (
    extractString(raw, ["toolName", "tool_name", "name", "command"]) ??
    stringValue(functionCall?.name) ??
    stringValue(toolCall?.name)
  );
}

function messageTitle(message: ChatMessage): string {
  if (message.role === "user") return "User";
  if (message.role === "assistant") return "Assistant";
  if (message.role === "system") return "System";
  if (message.role === "tool") {
    return message.toolName ? `Tool: ${message.toolName}` : "Tool";
  }
  if (message.role === "internal") return "Internal";
  return message.role ?? message.author ?? `Message ${message.index + 1}`;
}

function hasInternalMarker(raw: JsonObject): boolean {
  const values = [
    extractString(raw, ["type", "event", "role", "speaker", "name"]),
    stringValue(asObject(raw.message)?.type),
    stringValue(asObject(raw.delta)?.type),
  ].filter((value): value is string => Boolean(value));
  return values.some((value) => hasMarker(value.toLowerCase(), INTERNAL_MARKERS));
}

function redactSecrets(content: string): { content: string; changed: boolean } {
  let redacted = content;
  for (const pattern of SECRET_TEXT_PATTERNS) {
    redacted = redacted.replace(pattern, SECRET_REPLACEMENT);
  }
  return { content: redacted, changed: redacted !== content };
}

function omitBinaryContent(content: string): { content: string; changed: boolean } {
  const withoutDataUris = content.replace(DATA_URI_PATTERN, BINARY_REPLACEMENT);
  const withoutLongBase64 = withoutDataUris.replace(LONG_BASE64_PATTERN, (match) =>
    looksLikeStandaloneBase64Blob(match) ? BINARY_REPLACEMENT : match,
  );
  return { content: withoutLongBase64, changed: withoutLongBase64 !== content };
}

function truncateLargeContent(content: string): { content: string; changed: boolean; originalLength: number } {
  if (content.length <= MAX_CONTENT_CHARS) {
    return { content, changed: false, originalLength: content.length };
  }
  const omitted = content.length - TRUNCATE_HEAD_CHARS - TRUNCATE_TAIL_CHARS;
  return {
    content: [
      content.slice(0, TRUNCATE_HEAD_CHARS).trimEnd(),
      "",
      `[truncated ${omitted} characters from large output]`,
      "",
      content.slice(-TRUNCATE_TAIL_CHARS).trimStart(),
    ].join("\n"),
    changed: true,
    originalLength: content.length,
  };
}

function firstChoiceObject(raw: JsonObject): JsonObject | undefined {
  if (!Array.isArray(raw.choices)) return undefined;
  return raw.choices.find((choice): choice is JsonObject => Boolean(choice && typeof choice === "object"));
}

function looksLikeStandaloneBase64Blob(value: string): boolean {
  if (value.length < 512 || value.length % 4 !== 0) return false;
  const uniqueChars = new Set(value).size;
  const classes = [
    /[A-Z]/.test(value),
    /[a-z]/.test(value),
    /[0-9]/.test(value),
    /[+/=]/.test(value),
  ].filter(Boolean).length;
  return uniqueChars >= 16 && classes >= 3;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function hasMarker(value: string, markers: string[]): boolean {
  return markers.some((marker) => value.includes(marker));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function exportBaseNameForSession(session: ChatSessionFile): string {
  const parts = session.relativePath.split("/");
  const lastIndex = parts.length - 1;

  return parts
    .map((part, index) => {
      const withoutJsonl = index === lastIndex ? part.replace(/\.jsonl$/i, "") : part;
      return sanitizeFileSegment(withoutJsonl, "session");
    })
    .join("__");
}
