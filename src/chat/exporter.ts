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
): Promise<{ messages: ChatMessage[]; skippedLineCount: number }> {
  const contents = await fs.readFile(filePath, "utf8");
  const messages: ChatMessage[] = [];
  let skippedLineCount = 0;

  contents.split(/\r?\n/).forEach((line: string) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    try {
      const raw = JSON.parse(trimmed) as JsonObject;
      const content = extractMessageContent(raw);

      if (!content) {
        skippedLineCount += 1;
        return;
      }

      messages.push({
        index: messages.length,
        raw,
        timestamp: extractString(raw, ["timestamp", "created_at", "createdAt", "time"]),
        role: extractString(raw, ["role", "speaker", "type"]),
        author: extractString(raw, ["author", "name", "user"]),
        content,
      });
    } catch {
      skippedLineCount += 1;
      return;
    }
  });

  return { messages, skippedLineCount };
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
    const title = message.role ?? message.author ?? `message ${message.index + 1}`;
    lines.push(`## ${markdownEscape(title)}`);

    if (message.timestamp) {
      lines.push("");
      lines.push(`_Timestamp: ${markdownEscape(message.timestamp)}_`);
    }

    lines.push("");
    lines.push(markdownEscape(message.content));
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function extractMessageContent(raw: JsonObject): string | undefined {
  return (
    coerceText(raw.content) ??
    coerceText(raw.message) ??
    coerceText(raw.text) ??
    coerceText(raw.body) ??
    coerceText(raw.delta)
  );
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
