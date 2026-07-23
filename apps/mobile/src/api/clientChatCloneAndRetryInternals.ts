import { isRpcRequestError, type RpcRequestError } from "./ws";
import { readString, toRecord } from "./chatMapping";
import { type Chat, type ChatSummary } from "./types";
import {
  type TurnInputLocalImage,
  type TurnInputMention,
} from "./clientContractsAndSnapshotInternals";

export function extractUserMessageLocalImages(
  value: unknown,
): TurnInputLocalImage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const images: TurnInputLocalImage[] = [];
  for (const entry of value) {
    const record = toRecord(entry);
    if (!record || readString(record.type) !== "localImage") {
      continue;
    }
    const path = readString(record.path)?.trim();
    if (!path) {
      continue;
    }
    images.push({ type: "localImage", path });
  }
  return images;
}

export function buildExpectedUserMessageContent(
  content: string,
  mentions: TurnInputMention[] = [],
  localImages: TurnInputLocalImage[] = [],
): string {
  const normalized = content.trim();
  const mentionLines = mentions.map((mention) => `[file: ${mention.path}]`);
  const localImageLines = localImages.map(
    (image) => `[local image: ${image.path}]`,
  );
  return [normalized, ...mentionLines, ...localImageLines]
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

export function chatShellFromSummary(summary: ChatSummary): Chat {
  return {
    ...cloneChatSummary(summary),
    messages: [],
    latestPlan: null,
    latestTurnPlan: null,
    latestTurnStatus: null,
    activeTurnId: null,
  };
}

export function cloneChatSummary(chat: ChatSummary): ChatSummary {
  return { ...chat };
}

export function cloneChatSummaries(chats: ChatSummary[]): ChatSummary[] {
  return chats.map(cloneChatSummary);
}

export function cloneChat(chat: Chat): Chat {
  const cloned = JSON.parse(JSON.stringify(chat)) as Chat;
  return {
    ...cloned,
    latestPlan: cloneChatPlan(cloned.latestPlan),
    latestTurnPlan: cloneChatPlan(cloned.latestTurnPlan),
  };
}

export function cloneChatPlan<
  T extends Chat["latestPlan"] | Chat["latestTurnPlan"],
>(plan: T): T {
  if (!plan) {
    return plan;
  }
  return { ...plan, steps: plan.steps.map((step) => ({ ...step })) } as T;
}

export function appendSyntheticUserMessage(
  chat: Chat,
  content: string,
  mentions: TurnInputMention[] = [],
  localImages: TurnInputLocalImage[] = [],
): Chat {
  const normalized = buildExpectedUserMessageContent(
    content.trim(),
    mentions,
    localImages,
  );
  if (!normalized) {
    return chat;
  }
  const createdAt = new Date().toISOString();
  return {
    ...chat,
    updatedAt: createdAt,
    lastMessagePreview: normalized.slice(0, 120),
    messages: [
      ...chat.messages,
      {
        id: `local-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: "user",
        content: normalized,
        createdAt,
      },
    ],
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isMaterializationGapError(error: unknown): boolean {
  if (!isRpcInvalidParamsError(error)) {
    return false;
  }
  const message = error.message;
  return (
    message.includes("includeTurns") &&
    (message.includes("material") || message.includes("materialis"))
  );
}

export function isTransientThreadReadError(error: unknown): boolean {
  if (!isRpcRequestError(error) || error.code !== -32603) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("failed to read thread") &&
    message.includes("thread-store internal error") &&
    message.includes("rollout") &&
    message.includes("is empty")
  );
}

export function isRpcInvalidParamsError(
  error: unknown,
): error is RpcRequestError {
  return isRpcRequestError(error) && error.code === -32602;
}
