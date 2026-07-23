import {
  readString,
  readStringArray,
  toRecord,
} from "./chatMappingRawTypesAndReaders";
import { stringifyStructuredContentEntries } from "./chatMappingStructuredContentPreview";
import { type ChatMessageSubAgentMeta } from "./types";

export function readFunctionToolArguments(
  item: Record<string, unknown>,
): Record<string, unknown> | null {
  return (
    toRecord(item.arguments) ??
    toRecord(item.args) ??
    parseJsonObject(readString(item.arguments)) ??
    parseJsonObject(readString(item.args))
  );
}

export function readFunctionToolInput(
  item: Record<string, unknown>,
): string | null {
  return (
    normalizeMultiline(readString(item.input), 1800) ??
    normalizeMultiline(readString(item.arguments), 1800) ??
    normalizeMultiline(readString(item.args), 1800)
  );
}

export function readFunctionCommand(
  args: Record<string, unknown> | null,
): string | null {
  if (!args) {
    return null;
  }
  const direct =
    normalizeInline(readString(args.cmd), 240) ??
    normalizeInline(readString(args.command), 240);
  if (direct) {
    return direct;
  }
  const commandParts = readStringArray(args.cmd).concat(
    readStringArray(args.command),
  );
  return commandParts.length > 0
    ? normalizeInline(commandParts.join(" "), 240)
    : null;
}

export function parseMcpFunctionToolName(
  name: string,
): { server: string; tool: string } | null {
  const segments = name.split("__").filter(Boolean);
  if (segments.length < 3 || segments[0] !== "mcp") {
    return null;
  }
  const [, server, ...toolParts] = segments;
  const tool = toolParts.join("__");
  if (!server || !tool) {
    return null;
  }
  return { server, tool };
}

export function readFunctionSearchQuery(
  args: Record<string, unknown> | null,
): string | null {
  if (!args) {
    return null;
  }
  const direct = readString(args.q) ?? readString(args.query);
  if (direct) {
    return direct;
  }
  const searchQueries = Array.isArray(args.search_query)
    ? args.search_query
    : Array.isArray(args.image_query)
      ? args.image_query
      : [];
  for (const entry of searchQueries) {
    const query =
      readString(toRecord(entry)?.q) ?? readString(toRecord(entry)?.query);
    if (query) {
      return query;
    }
  }
  return null;
}

export function readPatchTargetPaths(input: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /^\*\*\* Update File:\s+(.+)$/gm,
    /^\*\*\* Move to:\s+(.+)$/gm,
    /^\*\*\* Add File:\s+(.+)$/gm,
    /^\*\*\* Delete File:\s+(.+)$/gm,
  ];
  for (const pattern of patterns) {
    for (const match of input.matchAll(pattern)) {
      const path = match[1]?.trim();
      if (!path || seen.has(path)) {
        continue;
      }
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

export function toSubAgentMeta(
  item: Record<string, unknown>,
): ChatMessageSubAgentMeta | undefined {
  const tool = readString(item.tool) ?? undefined;
  const prompt = normalizeInline(readString(item.prompt), 4000) ?? undefined;
  const senderThreadId =
    normalizeInline(
      readString(item.senderThreadId) ?? readString(item.sender_thread_id),
      200,
    ) ?? undefined;
  const agentStatus =
    normalizeInline(
      readString(item.agentStatus) ?? readString(item.agent_status),
      200,
    ) ?? undefined;
  const receiverThreadIds = readReceiverThreadIds(item);
  if (
    !tool &&
    !prompt &&
    !senderThreadId &&
    receiverThreadIds.length === 0 &&
    !agentStatus
  ) {
    return undefined;
  }
  return { tool, prompt, senderThreadId, receiverThreadIds, agentStatus };
}

export function readReceiverThreadIds(item: Record<string, unknown>): string[] {
  const pluralIds = [
    ...readStringArray(item.receiverThreadIds),
    ...readStringArray(item.receiver_thread_ids),
  ];
  if (pluralIds.length > 0) {
    return Array.from(new Set(pluralIds));
  }
  const singularIds = [
    readString(item.newThreadId),
    readString(item.new_thread_id),
    readString(item.receiverThreadId),
    readString(item.receiver_thread_id),
  ]
    .map((value) => value?.trim() ?? "")
    .filter((value): value is string => value.length > 0);
  return singularIds;
}

export function reasoningTextFromItem(
  item: Record<string, unknown>,
): string | null {
  const directText = readString(item.text);
  if (directText?.trim()) {
    return directText;
  }
  const content = readStringArray(item.content);
  if (content.length > 0) {
    return content.join("\n");
  }
  if (Array.isArray(item.content)) {
    const structuredContent = stringifyStructuredContentEntries(item.content);
    if (structuredContent.trim()) {
      return structuredContent;
    }
  }
  const summary = readStringArray(item.summary);
  if (summary.length > 0) {
    return summary.join("\n");
  }
  if (Array.isArray(item.summary)) {
    const structuredSummary = stringifyStructuredContentEntries(item.summary);
    if (structuredSummary.trim()) {
      return structuredSummary;
    }
  }
  return null;
}

export function normalizeType(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

export function parseJsonObject(
  value: string | null,
): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    return toRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

export function normalizeInline(
  value: string | null,
  maxChars: number,
): string | null {
  if (!value) {
    return null;
  }
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return null;
  }
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  return `${cleaned.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function toFileChangeTargetLabel(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/");
  if (!normalized) {
    return "file";
  }
  const basename = normalized.split("/").filter(Boolean).pop();
  return basename && basename.length > 0 ? basename : normalized;
}

export function normalizeMultiline(
  value: string | null,
  maxChars: number,
): string | null {
  if (!value) {
    return null;
  }
  const cleaned = value
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!cleaned) {
    return null;
  }
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  return `${cleaned.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function toNestedOutput(
  value: string,
  maxLines: number,
  maxChars: number,
): string | null {
  const normalized = normalizeMultiline(value, maxChars);
  if (!normalized) {
    return null;
  }
  const lines = normalized
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }
  const limited = lines.slice(0, maxLines);
  return limited.join("\n");
}
