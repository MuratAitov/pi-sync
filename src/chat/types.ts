export type JsonObject = Record<string, unknown>;

export interface ChatExportOptions {
  piDir: string;
  exportsDir: string;
  now?: Date;
}

export interface ChatSessionFile {
  absolutePath: string;
  relativePath: string;
  sessionId: string;
  modifiedAt: Date;
  sizeBytes: number;
}

export interface ChatMessage {
  index: number;
  raw: JsonObject;
  timestamp?: string;
  role?: string;
  author?: string;
  toolName?: string;
  content: string;
  annotations: string[];
  redacted: boolean;
  omitted: boolean;
  truncated: boolean;
}

export interface ChatExportMetadata {
  sourcePath: string;
  sourceRelativePath: string;
  sessionId: string;
  exportedAt: string;
  messageCount: number;
  skippedLineCount: number;
  redactedMessageCount: number;
  omittedMessageCount: number;
  truncatedMessageCount: number;
  sourceModifiedAt: string;
  sourceSizeBytes: number;
  markdownPath: string;
  metadataPath: string;
}

export interface ChatExportResult {
  session: ChatSessionFile;
  markdownPath: string;
  metadataPath: string;
  metadata: ChatExportMetadata;
}

export interface RetentionPolicy {
  maxAgeDays?: number;
  maxExportCount?: number;
  now?: Date;
}

export interface RetentionPlanItem {
  path: string;
  reason: string;
  modifiedAt: Date;
  sizeBytes: number;
}

export interface RetentionPlan {
  deleteCandidates: RetentionPlanItem[];
  keep: RetentionPlanItem[];
}
