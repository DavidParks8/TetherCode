import {
  normalizeInline,
  normalizeMultiline,
  normalizeType,
} from "./chatMappingToolArgumentParsers";
import { readString, toRecord } from "./chatMappingRawTypesAndReaders";

export function withNestedDetail(title: string, detail: string | null): string {
  if (!detail) {
    return title;
  }
  const lines = detail
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return title;
  }
  const first = `  └ ${lines[0]}`;
  if (lines.length === 1) {
    return `${title}\n${first}`;
  }
  const rest = lines.slice(1).map((line) => `    ${line}`);
  return [title, first, ...rest].join("\n");
}

export function toStructuredPreview(
  value: unknown,
  maxChars: number,
): string | null {
  if (value == null) {
    return null;
  }
  const structuredPreview = toStructuredContentPreview(value, maxChars);
  if (structuredPreview) {
    return structuredPreview;
  }
  if (typeof value === "string") {
    return normalizeMultiline(value, maxChars);
  }
  try {
    const serialized = JSON.stringify(value);
    return normalizeInline(serialized, maxChars);
  } catch {
    return null;
  }
}

export function stringifyStructuredContentEntries(entries: unknown[]): string {
  return entries
    .flatMap((entry) => stringifyStructuredContentEntry(entry))
    .join("\n");
}

export function stringifyStructuredContentEntry(entry: unknown): string[] {
  const entryRecord = toRecord(entry);
  if (!entryRecord) {
    const text = readString(entry)?.trim();
    return text ? [text] : [];
  }
  const entryType = normalizeType(readString(entryRecord.type) ?? "");
  if (
    entryType === "text" ||
    entryType === "inputtext" ||
    entryType === "outputtext" ||
    entryType === "summarytext"
  ) {
    const text = readStructuredText(entryRecord);
    return text ? [text] : [];
  }
  if (entryType === "image" || entryType === "inputimage") {
    const localImagePath = readStructuredLocalImagePath(entryRecord);
    if (localImagePath) {
      return [`[local image: ${localImagePath}]`];
    }
    const imageUrl = readStructuredImageUrl(entryRecord);
    return imageUrl ? [`[image: ${imageUrl}]`] : [];
  }
  if (entryType === "localimage") {
    const localImagePath = readStructuredLocalImagePath(entryRecord);
    if (localImagePath) {
      return [`[local image: ${localImagePath}]`];
    }
    const imageUrl = readStructuredImageUrl(entryRecord);
    return imageUrl ? [`[image: ${imageUrl}]`] : [];
  }
  if (entryType === "mention") {
    const mentionPath = readStructuredMentionPath(entryRecord);
    return mentionPath ? [`[file: ${mentionPath}]`] : [];
  }
  return [];
}

export function readStructuredText(
  entryRecord: Record<string, unknown>,
): string | null {
  return (
    readString(entryRecord.text)?.trim() ??
    readString(toRecord(entryRecord.data)?.text)?.trim() ??
    null
  );
}

export function readStructuredImageUrl(
  entryRecord: Record<string, unknown>,
): string | null {
  const data = toRecord(entryRecord.data);
  const inlineImageData =
    readString(entryRecord.data)?.trim() ??
    readString(data?.data)?.trim() ??
    null;
  const inlineImageMimeType =
    readString(entryRecord.mimeType)?.trim() ??
    readString(entryRecord.mime_type)?.trim() ??
    readString(data?.mimeType)?.trim() ??
    readString(data?.mime_type)?.trim() ??
    null;
  if (inlineImageData && inlineImageMimeType) {
    return `data:${inlineImageMimeType};base64,${inlineImageData}`;
  }
  return (
    readString(entryRecord.url)?.trim() ??
    readString(entryRecord.image_url)?.trim() ??
    readString(entryRecord.imageUrl)?.trim() ??
    readString(data?.url)?.trim() ??
    readString(data?.image_url)?.trim() ??
    readString(data?.imageUrl)?.trim() ??
    null
  );
}

export function readStructuredLocalImagePath(
  entryRecord: Record<string, unknown>,
): string | null {
  const data = toRecord(entryRecord.data);
  return (
    readString(entryRecord.path)?.trim() ??
    readString(data?.path)?.trim() ??
    null
  );
}

export function readStructuredMentionPath(
  entryRecord: Record<string, unknown>,
): string | null {
  const data = toRecord(entryRecord.data);
  return (
    readString(entryRecord.path)?.trim() ??
    readString(data?.path)?.trim() ??
    null
  );
}

export function toStructuredContentPreview(
  value: unknown,
  maxChars: number,
): string | null {
  const lines = extractStructuredContentPreviewLines(value);
  if (lines.length === 0) {
    return null;
  }
  const previewLines: string[] = [];
  let remainingChars = maxChars;
  let textLineCount = 0;
  let mediaLineCount = 0;
  for (const line of lines) {
    if (isImageMarker(line)) {
      if (mediaLineCount >= 3) {
        break;
      }
      previewLines.push(line);
      mediaLineCount += 1;
      continue;
    }
    if (textLineCount >= 8 || remainingChars <= 0) {
      break;
    }
    const normalizedLine = normalizeMultiline(line, remainingChars);
    if (!normalizedLine) {
      continue;
    }
    previewLines.push(normalizedLine);
    textLineCount += 1;
    remainingChars -= normalizedLine.length;
  }
  return previewLines.length > 0 ? previewLines.join("\n") : null;
}

export function extractStructuredContentPreviewLines(
  value: unknown,
  depth = 0,
): string[] {
  if (depth > 3 || value == null) {
    return [];
  }
  if (Array.isArray(value)) {
    const directLines = value.flatMap((entry) =>
      stringifyStructuredContentEntry(entry),
    );
    if (directLines.length > 0) {
      return directLines;
    }
    for (const entry of value) {
      const nestedLines = extractStructuredContentPreviewLines(
        entry,
        depth + 1,
      );
      if (nestedLines.length > 0) {
        return nestedLines;
      }
    }
    return [];
  }
  const directLines = stringifyStructuredContentEntry(value);
  if (directLines.length > 0) {
    return directLines;
  }
  const record = toRecord(value);
  if (!record) {
    return [];
  }
  const candidateKeys = [
    "content",
    "contents",
    "items",
    "item",
    "result",
    "results",
    "output",
    "data",
    "structuredContent",
    "structured_content",
    "_meta",
    "meta",
  ];
  for (const key of candidateKeys) {
    if (!(key in record)) {
      continue;
    }
    const nestedLines = extractStructuredContentPreviewLines(
      record[key],
      depth + 1,
    );
    if (nestedLines.length > 0) {
      return nestedLines;
    }
  }
  return [];
}

export function isImageMarker(value: string): boolean {
  return /^\[(?:image|local image):\s*.+?\]$/i.test(value.trim());
}
