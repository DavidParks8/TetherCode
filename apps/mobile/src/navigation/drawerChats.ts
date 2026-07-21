import type { AgentId, ChatSummary } from '../api/types';

export function filterDrawerChats(chats: ChatSummary[]): ChatSummary[] {
  return chats.filter((chat) => !isSubAgentChat(chat));
}

export function filterDrawerChatsByAgents(
  chats: ChatSummary[],
  agentIds: ReadonlyArray<AgentId>
): ChatSummary[] {
  const normalizedAgentIds = Array.from(new Set(agentIds.map((id) => id.trim()).filter(Boolean)));
  if (normalizedAgentIds.length === 0) {
    return chats;
  }
  const allowedAgentIds = new Set(normalizedAgentIds);
  return chats.filter((chat) => chat.agentId != null && allowedAgentIds.has(chat.agentId));
}

export function searchDrawerChats(chats: ChatSummary[], query: string): ChatSummary[] {
  const terms = normalizeSearchQuery(query);
  if (terms.length === 0) {
    return chats;
  }

  return chats.filter((chat) => {
    const haystack = [
      chat.title,
      chat.lastMessagePreview,
      chat.cwd,
      chat.lastError,
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n')
      .toLocaleLowerCase();

    return terms.every((term) => haystack.includes(term));
  });
}

export function isSubAgentChat(chat: ChatSummary): boolean {
  return Boolean(chat.parentThreadId) || chat.sourceKind?.startsWith('subAgent') === true;
}

function normalizeSearchQuery(query: string): string[] {
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}
