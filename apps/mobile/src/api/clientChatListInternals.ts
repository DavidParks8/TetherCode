import { cloneChatSummaries } from "./clientChatCloneAndRetryInternals";
import { readString, toRecord } from "./chatMapping";
import { type ChatSummary } from "./types";
import {
  type SnapshotPageEntry,
  type SnapshotPageResponse,
} from "./clientContractsAndSnapshotInternals";

export interface ChatListPage {
  chats: ChatSummary[];
  nextCursor: string | null;
  backwardsCursor: string | null;
  diagnostics: string[];
  partial: boolean;
}

export interface ListAllChatsOptions {
  includeSubAgents?: boolean;
  pageLimit?: number;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
  onPage?: (chats: ChatSummary[], page: ChatListPage) => void;
}

export interface ChatListResult {
  chats: ChatSummary[];
  diagnostics: string[];
  partial: boolean;
}

export interface ChatListStreamOptions {
  includeSubAgents?: boolean;
  limits?: number[];
  delayMs?: number;
}

export interface ChatListStreamBatch {
  streamId: string;
  limit: number;
  done: boolean;
  chats: ChatSummary[];
}

export interface ChatListStreamController {
  streamId: string;
  cancel: () => void;
}

export interface ChatReadOptions {
  cacheTtlMs?: number;
  forceRefresh?: boolean;
}

export interface ChatSummariesReadOptions {
  concurrency?: number;
}

export interface CacheEntry<T> {
  value: T;
  loadedAt: number;
}

export const DEFAULT_PREFETCH_CACHE_TTL_MS = 30_000;

export const DEFAULT_CHAT_LIST_LIMIT = 20;

export const DEFAULT_SUB_AGENT_CHAT_LIST_LIMIT = 50;

export const CHAT_LIST_STREAM_INITIAL_LIMIT = 5;

export const MAX_CHAT_LIST_PAGES = 32;

export const ACTIVE_TURN_STATUSES = new Set([
  "inprogress",
  "in_progress",
  "running",
  "active",
  "queued",
  "pending",
]);

export function isSubAgentSource(sourceKind: string | undefined): boolean {
  return typeof sourceKind === "string" && sourceKind.startsWith("subAgent");
}

export function normalizeCwd(cwd: string | null | undefined): string | null {
  if (typeof cwd !== "string") {
    return null;
  }
  const trimmed = cwd.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeListLimit(limit: unknown): number {
  return typeof limit === "number" && Number.isFinite(limit)
    ? Math.max(1, Math.min(200, Math.round(limit)))
    : DEFAULT_CHAT_LIST_LIMIT;
}

export function normalizeCursor(cursor: unknown): string | null {
  if (typeof cursor !== "string") {
    return null;
  }
  const trimmed = cursor.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeUniqueThreadIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") {
      continue;
    }
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function normalizeConcurrency(
  value: unknown,
  fallback: number,
  max: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(max, Math.round(value)))
    : fallback;
}

export function normalizeChatListStreamLimits(
  limits: unknown,
  fallbackLimit: number,
): number[] {
  const rawLimits = Array.isArray(limits)
    ? limits
    : [CHAT_LIST_STREAM_INITIAL_LIMIT, fallbackLimit];
  const normalized: number[] = [];
  for (const limit of rawLimits) {
    const nextLimit = normalizeListLimit(limit);
    if (!normalized.includes(nextLimit)) {
      normalized.push(nextLimit);
    }
  }
  return normalized.length > 0
    ? normalized
    : [normalizeListLimit(fallbackLimit)];
}

export function mergeChatSummariesById(
  previous: ChatSummary[],
  incoming: ChatSummary[],
): ChatSummary[] {
  const byId = new Map<string, ChatSummary>();
  for (const chat of previous) {
    byId.set(chat.id, chat);
  }
  for (const chat of incoming) {
    byId.set(chat.id, chat);
  }
  return [...byId.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export function readTimestampIso(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      return new Date(
        numeric > 1_000_000_000_000 ? numeric : numeric * 1000,
      ).toISOString();
    }
    const parsedMs = Date.parse(trimmed);
    return Number.isFinite(parsedMs) ? new Date(parsedMs).toISOString() : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(
      value > 1_000_000_000_000 ? value : value * 1000,
    ).toISOString();
  }
  return null;
}

export function readSnapshotPageResponse(value: unknown): SnapshotPageResponse {
  const record = toRecord(value) ?? {};
  const entries = (
    Array.isArray(record.entries) ? record.entries : []
  ).flatMap<SnapshotPageEntry>((value) => {
    const entry = toRecord(value);
    const sequence = readFiniteNumber(entry?.sequence);
    const kind = readString(entry?.kind);
    const canonicalId = readString(entry?.canonicalId)?.trim();
    if (
      sequence === null ||
      !canonicalId ||
      (kind !== "message" && kind !== "reasoning" && kind !== "tool")
    ) {
      return [];
    }
    const message = toRecord(entry?.message);
    const tool = toRecord(entry?.tool);
    return [
      {
        sequence,
        kind,
        canonicalId,
        message: message
          ? {
              id: readString(message.id) ?? canonicalId,
              role: readString(message.role) ?? "",
              parts: Array.isArray(message.parts) ? message.parts : [],
              truncated: message.truncated === true,
            }
          : undefined,
        tool: tool
          ? {
              id: readString(tool.id) ?? canonicalId,
              generation: readFiniteNumber(tool.generation),
              kind: readString(tool.kind) ?? "",
              status: readString(tool.status) ?? "",
              title: readString(tool.title) ?? "",
              content: readString(tool.content) ?? "",
              structuredContent: Array.isArray(tool.structuredContent)
                ? tool.structuredContent
                : [],
              locations: Array.isArray(tool.locations) ? tool.locations : [],
              truncated: tool.truncated === true,
            }
          : undefined,
      },
    ];
  });
  return {
    entries,
    beforeCursor: readString(record.beforeCursor),
    afterCursor: readString(record.afterCursor),
    hasMoreBefore: record.hasMoreBefore === true,
    hasMoreAfter: record.hasMoreAfter === true,
    unavailableCount: readFiniteNumber(record.unavailableCount) ?? 0,
    earliestAvailableSequence: readFiniteNumber(
      record.earliestAvailableSequence,
    ),
    latestAvailableSequence: readFiniteNumber(record.latestAvailableSequence),
    revision: readFiniteNumber(record.revision) ?? 0,
  };
}

export function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function cloneChatListResult(result: ChatListResult): ChatListResult {
  return {
    chats: cloneChatSummaries(result.chats),
    diagnostics: [...result.diagnostics],
    partial: result.partial,
  };
}
