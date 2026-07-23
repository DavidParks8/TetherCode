import {
  extractLastError,
  mapRawStatus,
} from "./chatMappingStatusAndErrorProjection";
import {
  readAgentId,
  readThreadItemText,
  readThreadSourceMetadata,
} from "./chatMappingChatProjection";
import { type ChatSummary } from "./types";
import {
  type RawAcpSnapshot,
  type RawSnapshotCollectionMetadata,
  type RawThread,
  type RawThreadItem,
  type RawTurn,
  readNumber,
  readString,
  readStringArray,
  toPreview,
  toRecord,
  unixSecondsToIso,
} from "./chatMappingRawTypesAndReaders";

export function toRawAcpSnapshot(value: unknown): RawAcpSnapshot | undefined {
  const snapshot = toRecord(value);
  const session = toRecord(snapshot?.session);
  const active = toRecord(snapshot?.active);
  const version = readNumber(snapshot?.version);
  if (!snapshot || (version !== 1 && version !== 2) || !session || !active) {
    return undefined;
  }
  const messages = (Array.isArray(snapshot.messages) ? snapshot.messages : [])
    .map(toRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      id: readString(entry.id) ?? "",
      role: readString(entry.role) ?? "",
      parts: Array.isArray(entry.parts) ? entry.parts : [],
      truncated: entry.truncated === true,
    }))
    .filter((entry) => entry.id && entry.role);
  const tools = (Array.isArray(snapshot.tools) ? snapshot.tools : [])
    .map(toRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      id: readString(entry.id) ?? "",
      generation: readNumber(entry.generation),
      kind: readString(entry.kind) ?? "",
      status: readString(entry.status) ?? "",
      title: readString(entry.title) ?? "",
      content: readString(entry.content) ?? "",
      structuredContent: Array.isArray(entry.structuredContent)
        ? entry.structuredContent
        : [],
      locations: Array.isArray(entry.locations) ? entry.locations : [],
      truncated: entry.truncated === true,
    }))
    .filter((entry) => entry.id);
  const timeline = (Array.isArray(snapshot.timeline) ? snapshot.timeline : [])
    .map(toRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      sequence: readNumber(entry.sequence) ?? -1,
      kind: readString(entry.kind),
      canonicalId: readString(entry.canonicalId) ?? "",
    }))
    .filter(
      (entry): entry is NonNullable<RawAcpSnapshot["timeline"]>[number] =>
        entry.sequence >= 0 &&
        (entry.kind === "message" ||
          entry.kind === "reasoning" ||
          entry.kind === "tool") &&
        Boolean(entry.canonicalId),
    );
  const plan = (Array.isArray(snapshot.plan) ? snapshot.plan : [])
    .map(toRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      content: readString(entry.content) ?? "",
      priority: readString(entry.priority) ?? "",
      status: readString(entry.status) ?? "",
    }))
    .filter((entry) => entry.content);
  const config = (Array.isArray(snapshot.config) ? snapshot.config : [])
    .map(toRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      id: readString(entry.id) ?? "",
      value: readString(entry.value) ?? "",
      name: readString(entry.name) ?? undefined,
      description: readString(entry.description) ?? undefined,
      category: readString(entry.category) ?? undefined,
      options: (Array.isArray(entry.options) ? entry.options : [])
        .map(toRecord)
        .filter((option): option is Record<string, unknown> => option !== null)
        .map((option) => ({
          value: readString(option.value) ?? "",
          name: readString(option.name) ?? "",
          description: readString(option.description) ?? undefined,
        }))
        .filter((option) => option.value && option.name),
    }))
    .filter((entry) => entry.id);
  const commands = (Array.isArray(snapshot.commands) ? snapshot.commands : [])
    .map(toRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      name: readString(entry.name) ?? "",
      description: readString(entry.description) ?? "",
    }))
    .filter((entry) => entry.name);
  const usage = toRecord(snapshot.usage) ?? {};
  const readCollection = (
    value: unknown,
  ): RawSnapshotCollectionMetadata | undefined => {
    const collection = toRecord(value);
    const revision = readNumber(collection?.revision);
    if (!collection || revision === null) return undefined;
    return {
      truncated: collection.truncated === true,
      omittedCount: readNumber(collection.omittedCount) ?? 0,
      oldestAvailableSequence: readNumber(collection.oldestAvailableSequence),
      newestSequence: readNumber(collection.newestSequence),
      beforeCursor: readString(collection.beforeCursor),
      revision,
    };
  };
  const continuationRecord = toRecord(snapshot.continuation);
  const continuationRevision = readNumber(continuationRecord?.revision);
  return {
    version,
    timeline: timeline.length > 0 ? timeline : undefined,
    messages,
    tools,
    messageCollection: readCollection(snapshot.messageCollection),
    reasoningCollection: readCollection(snapshot.reasoningCollection),
    toolCollection: readCollection(snapshot.toolCollection),
    continuation:
      continuationRecord && continuationRevision !== null
        ? {
            revision: continuationRevision,
            unavailableCount:
              readNumber(continuationRecord.unavailableCount) ?? 0,
            earliestAvailableSequence: readNumber(
              continuationRecord.earliestAvailableSequence,
            ),
            latestAvailableSequence: readNumber(
              continuationRecord.latestAvailableSequence,
            ),
            maxPageSize: readNumber(continuationRecord.maxPageSize) ?? 0,
            maxHistoryEntries:
              readNumber(continuationRecord.maxHistoryEntries) ?? 0,
            maxHistoryBytes:
              readNumber(continuationRecord.maxHistoryBytes) ?? 0,
          }
        : undefined,
    plan,
    usage: {
      used: readNumber(usage.used),
      size: readNumber(usage.size),
      cost: readString(usage.cost),
    },
    mode: readString(snapshot.mode),
    config,
    commands,
    session: {
      agentId: readString(session.agentId) ?? "",
      threadId: readString(session.threadId) ?? "",
      title: readString(session.title),
      updatedAt: readString(session.updatedAt),
      historyReconstruction: session.historyReconstruction === true,
    },
    active: {
      runId: readString(active.runId),
      sourceTurnId: readString(active.sourceTurnId),
      generation: readNumber(active.generation),
      toolIds: readStringArray(active.toolIds),
    },
  };
}

export function toRawTurn(value: unknown): RawTurn | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }
  const items = Array.isArray(record.items)
    ? (record.items
        .map((item) => toRecord(item))
        .filter(
          (item): item is RawThreadItem => item !== null,
        ) as RawThreadItem[])
    : undefined;
  return {
    id: readString(record.id) ?? undefined,
    status: readString(record.status) ?? undefined,
    error: record.error,
    message: record.message,
    errorMessage: record.errorMessage,
    error_message: record.error_message,
    detail: record.detail,
    details: record.details,
    reason: record.reason,
    description: record.description,
    stderr: record.stderr,
    items,
  };
}

export function mapChatSummary(raw: RawThread): ChatSummary | null {
  if (!raw.id) {
    return null;
  }
  const fallbackTimestampSeconds = stableThreadTimestampSeconds(raw.id);
  const createdAtSeconds =
    raw.createdAt ?? raw.updatedAt ?? fallbackTimestampSeconds;
  const updatedAtSeconds = raw.updatedAt ?? raw.createdAt ?? createdAtSeconds;
  const createdAt = unixSecondsToIso(createdAtSeconds);
  const updatedAt = unixSecondsToIso(updatedAtSeconds);
  const turns = Array.isArray(raw.turns) ? raw.turns : [];
  const sourceMetadata = readThreadSourceMetadata(raw.source);
  const lastError = extractLastError(turns);
  const previewTitle = toPreview(raw.preview || "");
  const firstUserTitle = firstUserMessagePreview(turns);
  const rawTitle = raw.name?.trim() || null;
  const displayTitle = rawTitle || previewTitle || firstUserTitle;
  const fallbackTitle = raw.acpSnapshot?.session.threadId
    ? `Session ${shortSessionId(raw.acpSnapshot.session.threadId)}`
    : `Chat ${raw.id.slice(0, 8)}`;
  return {
    id: raw.id,
    title: toPreview(displayTitle || fallbackTitle),
    status: mapRawStatus(raw.status, turns),
    createdAt,
    updatedAt,
    statusUpdatedAt: updatedAt,
    lastMessagePreview: toPreview(raw.preview || ""),
    cwd: readString(raw.cwd) ?? undefined,
    agentId: readAgentId(raw.agentId),
    modelProvider: readString(raw.modelProvider) ?? undefined,
    agentNickname: readString(raw.agentNickname) ?? undefined,
    agentRole: readString(raw.agentRole) ?? undefined,
    sourceKind: sourceMetadata.kind,
    parentThreadId: sourceMetadata.parentThreadId,
    subAgentDepth: sourceMetadata.subAgentDepth,
    lastError: lastError ?? undefined,
  };
}

export function shortSessionId(value: string): string {
  const compact = value.trim().replace(/[^a-zA-Z0-9]/g, "");
  return compact.slice(-8) || "new";
}

export function stableThreadTimestampSeconds(threadId: string): number {
  let hash = 0;
  for (const character of threadId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return 1_704_067_200 + (hash % 31_536_000);
}

export function firstUserMessagePreview(turns: RawTurn[]): string | null {
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      if (item.type !== "userMessage") {
        continue;
      }
      const text = readThreadItemText(item);
      const preview = toPreview(text);
      if (preview) {
        return preview;
      }
    }
  }
  return null;
}
