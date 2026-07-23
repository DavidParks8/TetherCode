import { readString, toRecord } from "./chatMappingRawTypesAndReaders";
import { stringifyStructuredContentEntries } from "./chatMappingStructuredContentPreview";
import {
  type ChatMessagePart,
  type ChatPlanSnapshot,
  type TurnPlanStep,
} from "./types";

export function parseSnapshotTaskSubagent(
  content: string,
  agentId: string | undefined,
): { threadId: string; state: string; result: string | null } | null {
  const header = content.trimStart().match(/^<task\s+([^>]+)>/);
  const sessionId = header?.[1]?.match(/\bid="([^"]{1,1024})"/)?.[1]?.trim();
  const state = header?.[1]?.match(/\bstate="([^"]{1,64})"/)?.[1]?.trim();
  const normalizedAgentId = agentId?.trim();
  if (!sessionId || !state || !normalizedAgentId) {
    return null;
  }
  const result =
    content.match(/<task_result>([\s\S]*?)<\/task_result>/)?.[1]?.trim() ||
    null;
  return {
    threadId: `v1.${base64UrlUtf8(normalizedAgentId)}.${base64UrlUtf8(sessionId)}`,
    state,
    result: result?.slice(0, 2048) ?? null,
  };
}

export function base64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function isChatMessagePart(value: unknown): value is ChatMessagePart {
  const part = toRecord(value);
  if (!part || typeof part.type !== "string") return false;
  if (part.type === "text") return typeof part.text === "string";
  if (part.type === "image" || part.type === "audio") return true;
  if (part.type === "resourceLink") return typeof part.uri === "string";
  return part.type === "resource" && toRecord(part.resource) !== null;
}

export function stringifyStructuredMessageContent(
  itemRecord: Record<string, unknown>,
): string {
  const contentItems = Array.isArray(itemRecord.content)
    ? itemRecord.content
    : [];
  if (contentItems.length === 0) {
    return "";
  }
  return stringifyStructuredContentEntries(contentItems);
}

export function generateLocalId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function toPlanSnapshot(
  item: Record<string, unknown>,
  threadId: string,
  fallbackTurnId?: string | null,
): ChatPlanSnapshot | null {
  const turnId =
    readString(item.turnId) ??
    readString(item.turn_id) ??
    fallbackTurnId ??
    readString(item.id);
  if (!turnId) {
    return null;
  }
  const rawSteps = Array.isArray(item.plan)
    ? item.plan
    : Array.isArray(item.steps)
      ? item.steps
      : [];
  const steps: TurnPlanStep[] = rawSteps
    .map((entry) => {
      const entryRecord = toRecord(entry);
      if (!entryRecord) {
        return null;
      }
      const step = readString(entryRecord.step);
      const status = normalizePlanStepStatus(readString(entryRecord.status));
      if (!step || !status) {
        return null;
      }
      return { step, status } satisfies TurnPlanStep;
    })
    .filter((entry): entry is TurnPlanStep => entry !== null);
  const explanation = readString(item.explanation);
  if (steps.length === 0 && !explanation?.trim()) {
    return parsePlanTextSnapshot(readString(item.text), threadId, turnId);
  }
  return { threadId, turnId, explanation, steps };
}

export function parsePlanTextSnapshot(
  text: string | null | undefined,
  threadId: string,
  turnId: string,
): ChatPlanSnapshot | null {
  const trimmed = text?.trim();
  if (!trimmed) {
    return null;
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }
  const hasSummaryHeader = lines.some((line) => /^summary$/i.test(line));
  const steps: TurnPlanStep[] = [];
  for (const line of lines) {
    const match = line.match(/^\d+[.)]\s+(.+)$/);
    if (!match?.[1]) {
      continue;
    }
    steps.push({ step: match[1].trim(), status: "pending" });
  }
  if (!hasSummaryHeader && steps.length === 0) {
    return null;
  }
  let startIndex = 0;
  if (lines.length > 1 && /plan$/i.test(lines[0])) {
    startIndex = 1;
  }
  if (lines[startIndex] && /^summary$/i.test(lines[startIndex])) {
    startIndex += 1;
  }
  const explanationLines: string[] = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\d+[.)]\s+/.test(line)) {
      break;
    }
    if (/^(summary|implementation plan|proposed plan)$/i.test(line)) {
      continue;
    }
    explanationLines.push(line);
  }
  const explanation =
    explanationLines.length > 0 ? explanationLines.join(" ").trim() : null;
  if (steps.length === 0 && !explanation) {
    return null;
  }
  return { threadId, turnId, explanation, steps };
}

export function normalizePlanStepStatus(
  value: string | null | undefined,
): TurnPlanStep["status"] | null {
  if (!value) {
    return null;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (normalized === "pending") {
    return "pending";
  }
  if (normalized === "inprogress") {
    return "inProgress";
  }
  if (normalized === "completed" || normalized === "complete") {
    return "completed";
  }
  return null;
}
