import {
  normalizeLifecycleStatus,
  type RawThread,
  type RawTurn,
  readString,
  toRecord,
} from "./chatMappingRawTypesAndReaders";
import { normalizeType } from "./chatMappingToolArgumentParsers";
import { toPlanSnapshot } from "./chatMappingPlanParsing";
import { type ChatPlanSnapshot } from "./types";

export function extractChatPlans(raw: RawThread): {
  latestPlan: ChatPlanSnapshot | null;
  latestTurnPlan: ChatPlanSnapshot | null;
  latestTurnStatus: string | null;
  activeTurnId: string | null;
} {
  const threadId = raw.id?.trim();
  const turns = Array.isArray(raw.turns) ? raw.turns : [];
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const latestTurnStatus = readString(latestTurn?.status);
  const activeTurnId = extractActiveTurnId(turns);
  if (threadId && raw.acpSnapshot) {
    const steps = raw.acpSnapshot.plan.map((entry) => ({
      step: entry.content,
      status:
        entry.status === "completed"
          ? ("completed" as const)
          : entry.status === "inProgress" || entry.status === "in_progress"
            ? ("inProgress" as const)
            : ("pending" as const),
    }));
    const plan =
      steps.length > 0
        ? {
            threadId,
            turnId:
              raw.acpSnapshot.active.sourceTurnId ?? `${threadId}::snapshot`,
            explanation: null,
            steps,
          }
        : null;
    return {
      latestPlan: plan,
      latestTurnPlan: plan,
      latestTurnStatus: raw.acpSnapshot.active.runId ? "running" : "completed",
      activeTurnId: raw.acpSnapshot.active.sourceTurnId ?? null,
    };
  }
  if (!threadId || turns.length === 0) {
    return {
      latestPlan: null,
      latestTurnPlan: null,
      latestTurnStatus,
      activeTurnId,
    };
  }
  let latestPlan: ChatPlanSnapshot | null = null;
  let latestTurnPlan: ChatPlanSnapshot | null = null;
  for (const turn of turns) {
    const turnId = readString(turn.id);
    const items = Array.isArray(turn.items) ? turn.items : [];
    let latestPlanInTurn: ChatPlanSnapshot | null = null;
    for (const item of items) {
      const itemRecord = toRecord(item);
      if (!itemRecord) {
        continue;
      }
      const itemType = normalizeType(readString(itemRecord.type) ?? "");
      if (itemType !== "plan") {
        continue;
      }
      const plan = toPlanSnapshot(itemRecord, threadId, turnId);
      if (!plan) {
        continue;
      }
      latestPlan = plan;
      latestPlanInTurn = plan;
    }
    if (turn === latestTurn) {
      latestTurnPlan = latestPlanInTurn;
    }
  }
  return { latestPlan, latestTurnPlan, latestTurnStatus, activeTurnId };
}

export function extractActiveTurnId(turns: RawTurn[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const turnId = readString(turn.id)?.trim();
    const turnStatus = normalizeLifecycleStatus(readString(turn.status));
    if (
      turnId &&
      (turnStatus === "inprogress" ||
        turnStatus === "running" ||
        turnStatus === "active" ||
        turnStatus === "queued" ||
        turnStatus === "pending")
    ) {
      return turnId;
    }
  }
  return null;
}
