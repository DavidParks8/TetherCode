import { parseAgUiEventNotification } from "./agUi";
import { type RpcNotification } from "./types";
import { type TurnCompletionSnapshot } from "./wsTypes";

export function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return null;
}

export function readEventId(record: Record<string, unknown>): number | null {
  const eventId = readNumber(record.eventId) ?? readNumber(record.event_id);
  if (eventId === null || eventId < 1) {
    return null;
  }
  return eventId;
}

export function turnCompletionKey(threadId: string, turnId: string): string {
  return `${threadId}::${turnId}`;
}

export function toAgUiTurnCompletionSnapshot(
  event: RpcNotification,
): TurnCompletionSnapshot | null {
  const envelope = parseAgUiEventNotification(event);
  if (!envelope?.sourceTurnId) {
    return null;
  }
  if (envelope.event.type === "RUN_FINISHED") {
    return {
      threadId: envelope.threadId,
      turnId: envelope.sourceTurnId,
      status: "completed",
      errorMessage: null,
      completedAt: Date.now(),
    };
  }
  if (envelope.event.type === "RUN_ERROR") {
    return {
      threadId: envelope.threadId,
      turnId: envelope.sourceTurnId,
      status: "failed",
      errorMessage: envelope.event.message,
      completedAt: Date.now(),
    };
  }
  return null;
}

export function isFailedTurnStatus(status: string | null): boolean {
  return (
    status === "failed" ||
    status === "interrupted" ||
    status === "error" ||
    status === "aborted" ||
    status === "cancelled" ||
    status === "canceled"
  );
}
