import * as FileSystem from 'expo-file-system/legacy';

import type { Chat, ChatMessage, ChatMessagePart } from './api/types';

export const CHAT_SNAPSHOT_CACHE_VERSION = 1;
export const CHAT_SNAPSHOT_CACHE_MAX_ENTRIES = 20;
export const CHAT_SNAPSHOT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
export const CHAT_SNAPSHOT_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface ChatSnapshotCacheEntry {
  chat: Chat;
  cachedAt: string;
  lastAccessedAt: string;
}

export interface ChatSnapshotCache {
  version: 1;
  profileId: string;
  selectedChatId: string | null;
  updatedAt: string;
  entries: ChatSnapshotCacheEntry[];
}

const writeChains = new Map<string, Promise<void>>();

export function createEmptyChatSnapshotCache(
  profileId: string,
  now = new Date().toISOString()
): ChatSnapshotCache {
  return {
    version: CHAT_SNAPSHOT_CACHE_VERSION,
    profileId,
    selectedChatId: null,
    updatedAt: now,
    entries: [],
  };
}

export function parseChatSnapshotCache(
  raw: string,
  profileId: string,
  now = Date.now()
): ChatSnapshotCache {
  try {
    const parsed = JSON.parse(raw) as Partial<ChatSnapshotCache>;
    if (
      parsed.version !== CHAT_SNAPSHOT_CACHE_VERSION ||
      parsed.profileId !== profileId ||
      !Array.isArray(parsed.entries)
    ) {
      return createEmptyChatSnapshotCache(profileId);
    }

    const entries = parsed.entries
      .map(normalizeCacheEntry)
      .filter((entry): entry is ChatSnapshotCacheEntry => entry !== null)
      .filter((entry) => now - Date.parse(entry.cachedAt) <= CHAT_SNAPSHOT_CACHE_MAX_AGE_MS)
      .sort((left, right) => right.lastAccessedAt.localeCompare(left.lastAccessedAt));
    const selectedChatId =
      typeof parsed.selectedChatId === 'string' &&
      entries.some((entry) => entry.chat.id === parsed.selectedChatId)
        ? parsed.selectedChatId
        : null;

    return boundChatSnapshotCache({
      version: CHAT_SNAPSHOT_CACHE_VERSION,
      profileId,
      selectedChatId,
      updatedAt:
        typeof parsed.updatedAt === 'string' && Number.isFinite(Date.parse(parsed.updatedAt))
          ? parsed.updatedAt
          : new Date(now).toISOString(),
      entries,
    });
  } catch {
    return createEmptyChatSnapshotCache(profileId);
  }
}

export function updateChatSnapshotCache(
  cache: ChatSnapshotCache,
  selectedChatId: string | null,
  chat: Chat | null,
  now = new Date().toISOString()
): ChatSnapshotCache {
  const normalizedSelectedChatId = selectedChatId?.trim() || null;
  const entries = cache.entries
    .filter((entry) => entry.chat.id !== chat?.id)
    .map((entry) => ({ ...entry, chat: cloneChat(entry.chat) }));
  if (chat && isChat(chat)) {
    entries.unshift({
      chat: cloneChat(chat),
      cachedAt: now,
      lastAccessedAt: now,
    });
  } else if (normalizedSelectedChatId) {
    const selectedEntry = entries.find((entry) => entry.chat.id === normalizedSelectedChatId);
    if (selectedEntry) {
      selectedEntry.lastAccessedAt = now;
    }
  }

  return boundChatSnapshotCache({
    version: CHAT_SNAPSHOT_CACHE_VERSION,
    profileId: cache.profileId,
    selectedChatId: normalizedSelectedChatId,
    updatedAt: now,
    entries,
  });
}

export async function loadChatSnapshotCache(profileId: string): Promise<ChatSnapshotCache> {
  const path = getChatSnapshotCachePath(profileId);
  if (!path) {
    return createEmptyChatSnapshotCache(profileId);
  }
  try {
    return parseChatSnapshotCache(await FileSystem.readAsStringAsync(path), profileId);
  } catch {
    return createEmptyChatSnapshotCache(profileId);
  }
}

export function saveChatSnapshotCache(cache: ChatSnapshotCache): Promise<void> {
  const path = getChatSnapshotCachePath(cache.profileId);
  if (!path) {
    return Promise.resolve();
  }
  const previous = writeChains.get(path) ?? Promise.resolve();
  const write = previous
    .catch(() => {})
    .then(async () => {
      const directory = path.slice(0, path.lastIndexOf('/') + 1);
      await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
      await FileSystem.writeAsStringAsync(path, JSON.stringify(boundChatSnapshotCache(cache)));
    });
  writeChains.set(path, write);
  return write.finally(() => {
    if (writeChains.get(path) === write) {
      writeChains.delete(path);
    }
  });
}

export async function deleteChatSnapshotCache(profileId: string): Promise<void> {
  const path = getChatSnapshotCachePath(profileId);
  if (!path) {
    return;
  }
  writeChains.delete(path);
  try {
    await FileSystem.deleteAsync(path, { idempotent: true });
  } catch {
    // Cache cleanup is best effort.
  }
}

export function getChatSnapshotCachePath(
  profileId: string,
  base = FileSystem.documentDirectory
): string | null {
  if (typeof base !== 'string' || !base || !profileId.trim()) {
    return null;
  }
  return `${base}clawdex-chat-cache/${encodeURIComponent(profileId)}/snapshots.json`;
}

function boundChatSnapshotCache(cache: ChatSnapshotCache): ChatSnapshotCache {
  const ordered = [...cache.entries].sort((left, right) => {
    if (left.chat.id === cache.selectedChatId) return -1;
    if (right.chat.id === cache.selectedChatId) return 1;
    return right.lastAccessedAt.localeCompare(left.lastAccessedAt);
  });
  const entries: ChatSnapshotCacheEntry[] = [];
  for (const entry of ordered) {
    if (entries.length >= CHAT_SNAPSHOT_CACHE_MAX_ENTRIES) {
      break;
    }
    const candidate = { ...cache, entries: [...entries, entry] };
    if (JSON.stringify(candidate).length > CHAT_SNAPSHOT_CACHE_MAX_BYTES) {
      continue;
    }
    entries.push(entry);
  }
  return {
    ...cache,
    selectedChatId: entries.some((entry) => entry.chat.id === cache.selectedChatId)
      ? cache.selectedChatId
      : null,
    entries,
  };
}

function normalizeCacheEntry(value: unknown): ChatSnapshotCacheEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const entry = value as Partial<ChatSnapshotCacheEntry>;
  if (
    !isChat(entry.chat) ||
    typeof entry.cachedAt !== 'string' ||
    !Number.isFinite(Date.parse(entry.cachedAt)) ||
    typeof entry.lastAccessedAt !== 'string' ||
    !Number.isFinite(Date.parse(entry.lastAccessedAt))
  ) {
    return null;
  }
  return {
    chat: cloneChat(entry.chat),
    cachedAt: entry.cachedAt,
    lastAccessedAt: entry.lastAccessedAt,
  };
}

function isChat(value: unknown): value is Chat {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const chat = value as Partial<Chat>;
  return (
    typeof chat.id === 'string' &&
    chat.id.length > 0 &&
    typeof chat.title === 'string' &&
    typeof chat.status === 'string' &&
    typeof chat.createdAt === 'string' &&
    typeof chat.updatedAt === 'string' &&
    typeof chat.statusUpdatedAt === 'string' &&
    typeof chat.lastMessagePreview === 'string' &&
    Array.isArray(chat.messages) &&
    chat.messages.every(isChatMessage)
  );
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const message = value as Partial<ChatMessage>;
  return (
    typeof message.id === 'string' &&
    (message.role === 'user' || message.role === 'assistant' || message.role === 'system') &&
    typeof message.content === 'string' &&
    typeof message.createdAt === 'string' &&
    (message.parts === undefined ||
      (Array.isArray(message.parts) && message.parts.every(isChatMessagePart)))
  );
}

function isChatMessagePart(value: unknown): value is ChatMessagePart {
  if (!value || typeof value !== 'object') return false;
  const part = value as Record<string, unknown>;
  if (part.type === 'text') return typeof part.text === 'string';
  if (part.type === 'image' || part.type === 'audio') return true;
  if (part.type === 'resourceLink') return typeof part.uri === 'string';
  return part.type === 'resource'
    && typeof part.resource === 'object'
    && part.resource !== null
    && !Array.isArray(part.resource);
}

function cloneChat(chat: Chat): Chat {
  return JSON.parse(JSON.stringify(chat)) as Chat;
}
