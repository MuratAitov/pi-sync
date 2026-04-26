const RESERVED_WINDOWS_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*]+/g;
const WHITESPACE_RUN = /\s+/g;
const TRAILING_DOTS_SPACES = /[. ]+$/g;

export function sanitizeFileSegment(input: string, fallback = "untitled"): string {
  const cleaned = input
    .normalize("NFKC")
    .replace(CONTROL_CHARS, "")
    .replace(UNSAFE_FILENAME_CHARS, "-")
    .replace(WHITESPACE_RUN, " ")
    .trim()
    .replace(TRAILING_DOTS_SPACES, "");

  const compact = cleaned.length > 0 ? cleaned : fallback;
  const withoutReservedName = RESERVED_WINDOWS_NAMES.has(compact.toLowerCase())
    ? `${compact}-file`
    : compact;

  return withoutReservedName.slice(0, 120);
}

export function markdownEscape(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function coerceText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const joined = value
      .map((part) => coerceText(part))
      .filter((part): part is string => Boolean(part))
      .join("\n");

    return joined.length > 0 ? joined : undefined;
  }

  if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    return (
      coerceText(objectValue.text) ??
      coerceText(objectValue.content) ??
      coerceText(objectValue.message) ??
      coerceText(objectValue.value)
    );
  }

  return undefined;
}
