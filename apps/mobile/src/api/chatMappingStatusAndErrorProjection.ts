import {
  normalizeLifecycleStatus,
  type RawThread,
  type RawThreadStatus,
  type RawTurn,
  readString,
  readTimestampSeconds,
  toRecord,
} from "./chatMappingRawTypesAndReaders";
import { toRawAcpSnapshot, toRawTurn } from "./chatMappingSnapshotAndSummaryProjection";
import { type ChatStatus } from "./types";

export function readErrorMessage(value: unknown, depth = 0): string | null {
  if (depth > 3) {
    return null;
  }
  const direct = readString(value)?.trim();
  if (direct) {
    return direct;
  }
  const record = toRecord(value);
  if (!record) {
    return null;
  }
  const fields = [
    record.message,
    record.errorMessage,
    record.error_message,
    record.detail,
    record.details,
    record.reason,
    record.description,
    record.stderr,
    record.error,
  ];
  for (const field of fields) {
    const message = readErrorMessage(field, depth + 1);
    if (message) {
      return message;
    }
  }
  return null;
}

export function mapRawStatus(
  status: unknown,
  turns: RawTurn[] | undefined,
): ChatStatus {
  const statusRecord = toRecord(status);
  const statusType = normalizeLifecycleStatus(
    readString(statusRecord?.type) ?? readString(status),
  );
  const hasTurns = Array.isArray(turns) && turns.length > 0;
  const lastTurn = hasTurns ? turns[turns.length - 1] : null;
  const lastTurnStatus = normalizeLifecycleStatus(readString(lastTurn?.status));
  const isIdleLikeStatus = statusType === "idle" || statusType === "notloaded";
  if (
    lastTurnStatus === "inprogress" ||
    lastTurnStatus === "running" ||
    lastTurnStatus === "active" ||
    lastTurnStatus === "queued" ||
    lastTurnStatus === "pending"
  ) {
    // Some thread/read payloads can return stale turn state while the thread // itself is already idle/notLoaded. Prefer the thread lifecycle in that case.
    if (isIdleLikeStatus) {
      return hasTurns ? "complete" : "idle";
    }
    return "running";
  }
  if (
    lastTurnStatus === "failed" ||
    lastTurnStatus === "interrupted" ||
    lastTurnStatus === "error" ||
    lastTurnStatus === "aborted" ||
    lastTurnStatus === "cancelled" ||
    lastTurnStatus === "canceled"
  ) {
    return "error";
  }
  if (
    lastTurnStatus === "completed" ||
    lastTurnStatus === "complete" ||
    lastTurnStatus === "success" ||
    lastTurnStatus === "succeeded"
  ) {
    return "complete";
  }
  if (
    statusType === "systemerror" ||
    statusType === "error" ||
    statusType === "failed"
  ) {
    return "error";
  }
  if (
    statusType === "running" ||
    statusType === "inprogress" ||
    statusType === "queued" ||
    statusType === "pending"
  ) {
    return "running";
  }
  if (statusType === "active") {
    // Some backends keep a thread "active" while loaded in memory even when no // turn is running. If there is no in-progress turn, avoid false "working" UI.
    return hasTurns ? "complete" : "idle";
  }
  if (isIdleLikeStatus) {
    return hasTurns ? "complete" : "idle";
  }
  return "idle";
}

export function extractLastError(turns: RawTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    const turnStatus = normalizeLifecycleStatus(readString(turn.status));
    if (
      turnStatus !== "failed" &&
      turnStatus !== "interrupted" &&
      turnStatus !== "error" &&
      turnStatus !== "aborted" &&
      turnStatus !== "cancelled" &&
      turnStatus !== "canceled"
    ) {
      continue;
    }
    const message =
      readErrorMessage(turn.error) ??
      readErrorMessage(turn.message) ??
      readErrorMessage(turn.errorMessage) ??
      readErrorMessage(turn.error_message) ??
      readErrorMessage(turn.detail) ??
      readErrorMessage(turn.details) ??
      readErrorMessage(turn.reason) ??
      readErrorMessage(turn.description) ??
      readErrorMessage(turn.stderr);
    if (message) {
      return message;
    }
    return `turn ${turnStatus}`;
  }
  return null;
}

export function toRawThread(value: unknown): RawThread {
  const record = toRecord(value) ?? {};
  const threadName =
    readString(record.name) ??
    readString(record.title) ??
    readString(record.threadName) ??
    readString(record.thread_name) ??
    undefined;
  return {
    id: readString(record.id) ?? undefined,
    agentId: record.agentId,
    name: threadName,
    title: threadName,
    preview: readString(record.preview) ?? undefined,
    modelProvider: readString(record.modelProvider) ?? undefined,
    agentNickname:
      readString(record.agentNickname) ??
      readString(record.agent_nickname) ??
      undefined,
    agentRole:
      readString(record.agentRole) ??
      readString(record.agent_role) ??
      undefined,
    createdAt: readTimestampSeconds(record.createdAt) ?? undefined,
    updatedAt: readTimestampSeconds(record.updatedAt) ?? undefined,
    status: (record.status as RawThreadStatus) ?? undefined,
    cwd: readString(record.cwd) ?? undefined,
    source: record.source,
    acpSnapshot: toRawAcpSnapshot(record.acpSnapshot),
    turns: Array.isArray(record.turns)
      ? (record.turns
          .map((turn) => toRawTurn(turn))
          .filter(Boolean) as RawTurn[])
      : undefined,
  };
}
