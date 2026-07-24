import type { ChatSummary } from '../api/types';
import { DEFAULT_WORKSPACE_CHAT_LIMIT, type WorkspaceChatLimit } from '../appSettings';

export function sortChats(chats: ChatSummary[]): ChatSummary[] {
  return [...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function dedupeChatsById(chats: ChatSummary[]): ChatSummary[] {
  const byId = new Map<string, ChatSummary>();
  for (const chat of chats) {
    const existing = byId.get(chat.id);
    if (!existing || shouldReplaceChatSummary(existing, chat)) {
      byId.set(chat.id, chat);
    }
  }
  return Array.from(byId.values());
}

export function mergeDrawerChatBatch(
  previous: ChatSummary[],
  incoming: ChatSummary[]
): ChatSummary[] {
  if (previous.length === 0) return sortChats(incoming);
  const byId = new Map(previous.map((chat) => [chat.id, chat]));
  for (const chat of incoming) {
    const existing = byId.get(chat.id);
    if (!existing || shouldReplaceChatSummary(existing, chat)) {
      byId.set(chat.id, chat);
    }
  }
  return sortChats(Array.from(byId.values()));
}

function shouldReplaceChatSummary(
  existing: ChatSummary,
  incoming: ChatSummary
): boolean {
  const updatedAtDiff = incoming.updatedAt.localeCompare(existing.updatedAt);
  if (updatedAtDiff !== 0) {
    return updatedAtDiff > 0;
  }
  return incoming.statusUpdatedAt.localeCompare(existing.statusUpdatedAt) >= 0;
}

export function areDrawerChatListsEquivalent(
  previous: ChatSummary[],
  next: ChatSummary[]
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  return previous.every((left, index) => {
    const right = next[index];
    return left.id === right.id && left.title === right.title &&
      left.status === right.status && left.updatedAt === right.updatedAt &&
      left.lastMessagePreview === right.lastMessagePreview && left.cwd === right.cwd &&
      left.agentId === right.agentId && left.sourceKind === right.sourceKind &&
      left.parentThreadId === right.parentThreadId && left.subAgentDepth === right.subAgentDepth &&
      left.lastError === right.lastError;
  });
}

export function relativeTime(iso: string): string {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  const weeks = Math.floor(days / 7);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  if (weeks < 5) return `${weeks}w`;
  return `${Math.floor(days / 30)}mo`;
}

export function formatCompactCount(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`;
  }
  return String(value);
}

export function normalizeWorkspaceChatLimit(value: WorkspaceChatLimit): WorkspaceChatLimit {
  return value === 10 || value === 25 || value === null
    ? value
    : DEFAULT_WORKSPACE_CHAT_LIMIT;
}