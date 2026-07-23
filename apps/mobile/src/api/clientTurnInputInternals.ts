import {
  buildExpectedUserMessageContent,
  extractUserMessageLocalImages,
} from "./clientChatCloneAndRetryInternals";
import { getMessageText } from "./messages";
import { normalizeEffort, normalizeModel } from "./clientBridgeResponseNormalization";
import {
  type AgentId,
  type Chat,
  type CollaborationMode,
  type LocalImageInput,
  type MentionInput,
  type ReasoningEffort,
} from "./types";
import {
  type AppServerCollaborationMode,
  type AppServerThreadRuntimeSettings,
  type TurnInputLocalImage,
  type TurnInputMention,
  type TurnInputText,
} from "./clientContractsAndSnapshotInternals";
import { type RawThread, readString, toRecord } from "./chatMapping";

export function buildTurnInput(
  content: string,
  mentions: TurnInputMention[],
  localImages: TurnInputLocalImage[],
): Array<TurnInputText | TurnInputMention | TurnInputLocalImage> {
  const textInput: TurnInputText = {
    type: "text",
    text: content,
    text_elements: [],
  };
  if (mentions.length === 0 && localImages.length === 0) {
    return [textInput];
  }
  return [textInput, ...mentions, ...localImages];
}

export function normalizeMentions(
  raw: MentionInput[] | undefined,
): TurnInputMention[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const normalized: TurnInputMention[] = [];
  const seenPaths = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry.path !== "string") {
      continue;
    }
    const path = entry.path.trim();
    if (!path) {
      continue;
    }
    const dedupeKey = path.toLowerCase();
    if (seenPaths.has(dedupeKey)) {
      continue;
    }
    seenPaths.add(dedupeKey);
    const name = normalizeMentionName(entry.name, path);
    normalized.push({ type: "mention", name, path });
  }
  return normalized;
}

export function normalizeMentionName(
  name: string | undefined,
  path: string,
): string {
  if (typeof name === "string") {
    const trimmed = name.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  const pathSegments = path.split(/[\\/]/).filter(Boolean);
  const inferred = pathSegments[pathSegments.length - 1];
  if (typeof inferred === "string" && inferred.trim().length > 0) {
    return inferred.trim();
  }
  return path;
}

export function normalizeLocalImages(
  raw: LocalImageInput[] | undefined,
): TurnInputLocalImage[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const normalized: TurnInputLocalImage[] = [];
  const seenPaths = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry.path !== "string") {
      continue;
    }
    const path = entry.path.trim();
    if (!path) {
      continue;
    }
    const dedupeKey = path.toLowerCase();
    if (seenPaths.has(dedupeKey)) {
      continue;
    }
    seenPaths.add(dedupeKey);
    normalized.push({
      type: "localImage",
      path,
    });
  }
  return normalized;
}

export function toTurnCollaborationMode(
  value: CollaborationMode | string | null | undefined,
  model: string | null,
  effort: ReasoningEffort | null,
): AppServerCollaborationMode | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized !== "plan" &&
    normalized !== "default" &&
    normalized !== "ask"
  ) {
    return null;
  }
  if (normalized === "ask") {
    return null;
  }
  if (!model) {
    return null;
  }
  return {
    mode: normalized,
    settings: { model, reasoning_effort: effort, developer_instructions: null },
  };
}

export function normalizeCollaborationMode(
  value: CollaborationMode | string | null | undefined,
): CollaborationMode | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "plan" || normalized === "default") {
    return normalized;
  }
  return null;
}

export function normalizeAgentName(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeAgentId(
  value: string | null | undefined,
): AgentId | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function readThreadRuntimeSettings(
  value: unknown,
): AppServerThreadRuntimeSettings {
  const record = toRecord(value);
  return {
    model: normalizeModel(readString(record?.model)),
    effort: normalizeEffort(
      readString(record?.reasoningEffort) ??
        readString(record?.reasoning_effort),
    ),
  };
}

export function chatHasRecentUserMessage(
  chat: Chat,
  content: string,
  mentions: TurnInputMention[] = [],
  localImages: TurnInputLocalImage[] = [],
  tailSize = 8,
): boolean {
  const normalized = buildExpectedUserMessageContent(
    content.trim(),
    mentions,
    localImages,
  );
  if (!normalized) {
    return true;
  }
  const tail = chat.messages.slice(-tailSize);
  return tail.some(
    (message) =>
      message.role === "user" && getMessageText(message).trim() === normalized,
  );
}

export function rawThreadHasTurns(rawThread: RawThread): boolean {
  return Array.isArray(rawThread.turns) && rawThread.turns.length > 0;
}

export function rawThreadHasTurnUserMessage(
  rawThread: RawThread,
  turnId: string,
  content: string,
  mentions: TurnInputMention[] = [],
  localImages: TurnInputLocalImage[] = [],
): boolean {
  const normalizedContent = content.trim();
  const normalizedTurnId = turnId.trim();
  if (!normalizedContent || !normalizedTurnId) {
    return false;
  }
  const turns = Array.isArray(rawThread.turns) ? rawThread.turns : [];
  const matchedTurn = turns.find((turn) => turn.id === normalizedTurnId);
  if (!matchedTurn || !Array.isArray(matchedTurn.items)) {
    return false;
  }
  return matchedTurn.items.some((item) => {
    const record = toRecord(item);
    if (!record || readString(record.type) !== "userMessage") {
      return false;
    }
    return (
      buildExpectedUserMessageContent(
        extractUserMessageText(record.content).trim(),
        extractUserMessageMentions(record.content),
        extractUserMessageLocalImages(record.content),
      ) ===
      buildExpectedUserMessageContent(normalizedContent, mentions, localImages)
    );
  });
}

export function extractUserMessageText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((entry) => {
      const record = toRecord(entry);
      if (!record) {
        return "";
      }
      if (readString(record.type) !== "text") {
        return "";
      }
      return readString(record.text) ?? "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

export function extractUserMessageMentions(value: unknown): TurnInputMention[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const mentions: TurnInputMention[] = [];
  for (const entry of value) {
    const record = toRecord(entry);
    if (!record || readString(record.type) !== "mention") {
      continue;
    }
    const path = readString(record.path)?.trim();
    if (!path) {
      continue;
    }
    mentions.push({
      type: "mention",
      path,
      name: normalizeMentionName(readString(record.name) ?? undefined, path),
    });
  }
  return mentions;
}
