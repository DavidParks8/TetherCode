import {
  type AgentId,
  type BridgeThreadQueueState,
  type Chat,
  type ReasoningEffort,
} from "./types";
import { StaleSnapshotRevisionError } from "./clientSnapshotErrors";
import { type HostBridgeWsClient } from "./ws";
import { type RawAcpSnapshot, type RawThread } from "./chatMapping";

export interface HealthResponse {
  status: "ok" | "degraded" | "unhealthy";
  at: string;
  uptimeSec: number;
}

export interface ApiClientOptions {
  ws: HostBridgeWsClient;
  bridgeUrl?: string;
  authToken?: string | null;
}

export interface AppServerListResponse {
  data?: unknown[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
  next_cursor?: string | null;
  backwards_cursor?: string | null;
  partial?: boolean;
  diagnostics?: unknown[];
}

export interface SnapshotPageEntry {
  sequence: number;
  kind: "message" | "reasoning" | "tool";
  canonicalId: string;
  message?: RawAcpSnapshot["messages"][number];
  tool?: RawAcpSnapshot["tools"][number];
}

export interface SnapshotPageResponse {
  entries: SnapshotPageEntry[];
  beforeCursor: string | null;
  afterCursor: string | null;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  unavailableCount: number;
  earliestAvailableSequence: number | null;
  latestAvailableSequence: number | null;
  revision: number;
}

export function mergeSnapshotPage(
  snapshot: RawAcpSnapshot,
  page: SnapshotPageResponse,
): RawAcpSnapshot {
  const expectedRevision = snapshot.continuation?.revision;
  if (expectedRevision !== undefined && page.revision !== expectedRevision) {
    throw new StaleSnapshotRevisionError(expectedRevision, page.revision);
  }
  const messages = new Map(
    snapshot.messages.map((message) => [message.id, message]),
  );
  const tools = new Map(snapshot.tools.map((tool) => [tool.id, tool]));
  const timeline = new Map(
    (snapshot.timeline ?? []).map((entry) => [entry.sequence, entry]),
  );
  const addedByKind = new Map<SnapshotPageEntry["kind"], number>();
  for (const entry of page.entries) {
    const existed = timeline.has(entry.sequence);
    timeline.set(entry.sequence, {
      sequence: entry.sequence,
      kind: entry.kind,
      canonicalId: entry.canonicalId,
    });
    if (!existed) {
      addedByKind.set(entry.kind, (addedByKind.get(entry.kind) ?? 0) + 1);
    }
    if (entry.message) messages.set(entry.message.id, entry.message);
    if (entry.tool) tools.set(entry.tool.id, entry.tool);
  }
  const updateCollection = (
    metadata: RawAcpSnapshot["messageCollection"],
    kind: SnapshotPageEntry["kind"],
  ) =>
    metadata
      ? {
          ...metadata,
          truncated: page.hasMoreBefore || page.unavailableCount > 0,
          omittedCount: Math.max(
            0,
            metadata.omittedCount - (addedByKind.get(kind) ?? 0),
          ),
          oldestAvailableSequence: page.earliestAvailableSequence,
          newestSequence: page.latestAvailableSequence,
          beforeCursor: page.hasMoreBefore ? page.beforeCursor : null,
          revision: page.revision,
        }
      : undefined;
  return {
    ...snapshot,
    timeline: [...timeline.values()].sort(
      (left, right) => left.sequence - right.sequence,
    ),
    messages: [...messages.values()],
    tools: [...tools.values()],
    messageCollection: updateCollection(snapshot.messageCollection, "message"),
    reasoningCollection: updateCollection(
      snapshot.reasoningCollection,
      "reasoning",
    ),
    toolCollection: updateCollection(snapshot.toolCollection, "tool"),
    continuation: snapshot.continuation
      ? {
          ...snapshot.continuation,
          revision: page.revision,
          unavailableCount: page.unavailableCount,
          earliestAvailableSequence: page.earliestAvailableSequence,
          latestAvailableSequence: page.latestAvailableSequence,
        }
      : undefined,
  };
}

export interface ThreadListStreamStartResponse {
  streamId?: string;
  started?: boolean;
}

export interface AppServerLoadedThreadListResponse {
  data?: unknown[];
}

export interface AppServerReadResponse {
  thread?: unknown;
}

export interface AppServerTurnResponse {
  turn?: { id?: string };
}

export interface AppServerStartResponse {
  thread?: { id?: string };
}

export interface AppServerCollaborationMode {
  mode: "plan" | "default" | "ask";
  settings: {
    model: string;
    reasoning_effort: ReasoningEffort | null;
    developer_instructions: string | null;
  };
}

export interface AppServerThreadRuntimeSettings {
  model: string | null;
  effort: ReasoningEffort | null;
}

export const CHAT_LIST_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "unknown",
] as const;

export const CHAT_LIST_SOURCE_KINDS_WITH_SUBAGENTS = [
  ...CHAT_LIST_SOURCE_KINDS,
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
] as const;

export const MOBILE_DEVELOPER_INSTRUCTIONS =
  "When you need clarification, call request_user_input instead of asking only in plain text. Provide 2-3 concise options whenever possible and use isOther when free-form input is appropriate.";

export const MOBILE_DEFAULT_SANDBOX = "danger-full-access";

export const THREAD_LIST_STREAM_BATCH_METHOD =
  "bridge/thread/list/stream/batch";

export const THREAD_LIST_STREAM_ERROR_METHOD =
  "bridge/thread/list/stream/error";

export const DEFAULT_CHAT_SUMMARY_HYDRATION_CONCURRENCY = 4;

export const MAX_CHAT_SUMMARY_HYDRATION_CONCURRENCY = 8;

export const TRANSIENT_THREAD_READ_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

export interface ChatSnapshot {
  rawThread: RawThread;
  chat: Chat;
}

export interface TurnInputText {
  type: "text";
  text: string;
  text_elements: [];
}

export interface TurnInputMention {
  type: "mention";
  name: string;
  path: string;
}

export interface TurnInputLocalImage {
  type: "localImage";
  path: string;
}

export interface SendChatMessageOptions {
  onTurnStarted?: (turnId: string) => void;
  submissionId?: string;
}

export interface PreparedTurnRequest {
  content: string;
  mentions: TurnInputMention[];
  localImages: TurnInputLocalImage[];
  turnStartParams: Record<string, unknown>;
}

export interface PrepareTurnRequestOptions {
  skipResume?: boolean;
  submissionId?: string;
}

export let submissionCounter = 0;

export function createSubmissionId(): string {
  submissionCounter += 1;
  return `submission-${Date.now().toString(36)}-${submissionCounter.toString(36)}`;
}

export type SendOrQueueChatMessageResult =
  | {
      disposition: "queued";
      queue: BridgeThreadQueueState;
      turnId: null;
      chat: null;
    }
  | {
      disposition: "sent";
      queue: BridgeThreadQueueState;
      turnId: string;
      chat: Chat;
    };

export interface ListChatsOptions {
  agentId?: AgentId;
  includeSubAgents?: boolean;
  limit?: number;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
}

export interface ChatListPageOptions extends ListChatsOptions {
  cursor?: string | null;
}
