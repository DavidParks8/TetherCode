import { extractChatPlans } from "./chatMappingPlanExtraction";
import { getMessageText } from "./messages";
import { mapChatSummary } from "./chatMappingSnapshotAndSummaryProjection";
import { mapMessages } from "./chatMappingMessageProjection";
import { type AgentId, type Chat } from "./types";
import {
  type RawAcpSnapshot,
  type RawThread,
  type RawThreadItem,
  readNumber,
  readString,
  type ThreadSourceMetadata,
  toPreview,
  toRecord,
} from "./chatMappingRawTypesAndReaders";

export function readThreadItemText(item: RawThreadItem): string {
  const record = toRecord(item);
  const text = readString(record?.text);
  if (text) {
    return text;
  }
  const content = Array.isArray(record?.content) ? record.content : [];
  if (content.length === 0) {
    return "";
  }
  return content
    .map((entry) => {
      const contentEntry = toRecord(entry);
      return readString(contentEntry?.type) === "text"
        ? (readString(contentEntry?.text) ?? "")
        : "";
    })
    .filter((entry) => entry.length > 0)
    .join("");
}

export function readAgentId(value: unknown): AgentId | null {
  const agentId = readString(value)?.trim();
  return agentId ? agentId : null;
}

export function readThreadSourceMetadata(
  source: unknown,
): ThreadSourceMetadata {
  if (typeof source === "string") {
    return { kind: source };
  }
  const sourceRecord = toRecord(source);
  if (!sourceRecord) {
    return {};
  } // Legacy shape used by older adapters.
  const legacyKind = readString(sourceRecord.kind);
  if (legacyKind) {
    return {
      kind: legacyKind,
      parentThreadId:
        readString(sourceRecord.parentThreadId) ??
        readString(sourceRecord.parent_thread_id) ??
        undefined,
      subAgentDepth:
        readNumber(sourceRecord.depth) ??
        readNumber(sourceRecord.agentDepth) ??
        readNumber(sourceRecord.agent_depth) ??
        undefined,
    };
  }
  // Current app-server shape: { subAgent: ... } tagged union.
  const subAgentValue = sourceRecord.subAgent ?? sourceRecord.subagent;
  if (subAgentValue !== undefined) {
    const subAgent = subAgentValue;
    if (typeof subAgent === "string") {
      const kind =
        subAgent === "review"
          ? "subAgentReview"
          : subAgent === "compact"
            ? "subAgentCompact"
            : subAgent === "memory_consolidation"
              ? "subAgentOther"
              : "subAgent";
      return { kind };
    }
    const subAgentRecord = toRecord(subAgent);
    if (!subAgentRecord) {
      return { kind: "subAgent" };
    }
    const threadSpawn = toRecord(subAgentRecord.thread_spawn);
    if (threadSpawn) {
      return {
        kind: "subAgentThreadSpawn",
        parentThreadId:
          readString(threadSpawn.parentThreadId) ??
          readString(threadSpawn.parent_thread_id) ??
          undefined,
        subAgentDepth:
          readNumber(threadSpawn.depth) ??
          readNumber(threadSpawn.agentDepth) ??
          readNumber(threadSpawn.agent_depth) ??
          undefined,
      };
    }
    if (readString(subAgentRecord.other)) {
      return {
        kind: "subAgentOther",
      };
    }
    return {
      kind: "subAgent",
      parentThreadId:
        readString(subAgentRecord.parentThreadId) ??
        readString(subAgentRecord.parent_thread_id) ??
        undefined,
      subAgentDepth:
        readNumber(subAgentRecord.depth) ??
        readNumber(subAgentRecord.agentDepth) ??
        readNumber(subAgentRecord.agent_depth) ??
        undefined,
    };
  }
  const typeKind = readString(sourceRecord.type);
  if (typeKind && typeKind.startsWith("subAgent")) {
    return {
      kind: typeKind,
      parentThreadId:
        readString(sourceRecord.parentThreadId) ??
        readString(sourceRecord.parent_thread_id) ??
        undefined,
      subAgentDepth:
        readNumber(sourceRecord.depth) ??
        readNumber(sourceRecord.agentDepth) ??
        readNumber(sourceRecord.agent_depth) ??
        undefined,
    };
  }
  return {};
}

export function mapChat(raw: RawThread): Chat {
  const summary = mapChatSummary(raw);
  if (!summary) {
    throw new Error("chat id missing in app-server response");
  }
  const messages = mapMessages(raw, summary.createdAt);
  const plans = extractChatPlans(raw);
  const lastPreview =
    messages.length > 0
      ? toPreview(getMessageText(messages[messages.length - 1]))
      : summary.lastMessagePreview;
  return {
    ...summary,
    lastMessagePreview: lastPreview,
    messages,
    acpSnapshot: raw.acpSnapshot,
    latestPlan: plans.latestPlan,
    latestTurnPlan: plans.latestTurnPlan,
    latestTurnStatus: plans.latestTurnStatus,
    activeTurnId: plans.activeTurnId,
    acpUsage: raw.acpSnapshot
      ? {
          used: raw.acpSnapshot.usage.used ?? null,
          size: raw.acpSnapshot.usage.size ?? null,
          cost: raw.acpSnapshot.usage.cost ?? null,
        }
      : null,
    acpMode: raw.acpSnapshot?.mode ?? null,
    acpConfig: raw.acpSnapshot?.config ?? [],
    acpCommands: raw.acpSnapshot?.commands ?? [],
    acpActive: raw.acpSnapshot
      ? {
          runId: raw.acpSnapshot.active.runId ?? null,
          sourceTurnId: raw.acpSnapshot.active.sourceTurnId ?? null,
          generation: raw.acpSnapshot.active.generation ?? null,
          toolIds: raw.acpSnapshot.active.toolIds,
        }
      : null,
  };
}

export function applySnapshotToChat(
  chat: Chat,
  acpSnapshot: RawAcpSnapshot,
): Chat {
  const mapped = mapChat({
    id: chat.id,
    agentId: chat.agentId,
    name: chat.title,
    preview: chat.lastMessagePreview,
    modelProvider: chat.modelProvider,
    createdAt: Date.parse(chat.createdAt) / 1000,
    updatedAt: Date.parse(chat.updatedAt) / 1000,
    status: { type: chat.status },
    cwd: chat.cwd,
    source: chat.sourceKind ? { kind: chat.sourceKind } : undefined,
    acpSnapshot,
  });
  return {
    ...chat,
    ...mapped,
    title: chat.title,
    status: chat.status,
    statusUpdatedAt: chat.statusUpdatedAt,
    acpSnapshot,
  };
}
