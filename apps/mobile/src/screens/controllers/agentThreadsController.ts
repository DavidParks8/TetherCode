import type { HostBridgeApiClient } from '../../api/client';
import type { Chat, ChatSummary } from '../../api/types';
import { collectRelatedAgentThreads } from '../agentThreads';
import { AGENT_THREADS_LIST_LIMIT } from '../mainScreenHelpers';

type AgentThreadsApi = Pick<
  HostBridgeApiClient,
  | 'listChats'
  | 'listLoadedChatIds'
  | 'getChatSummaries'
  | 'getChat'
  | 'peekChat'
>;

export interface RelatedAgentThreads {
  rootThreadId: string | null;
  threads: ChatSummary[];
}

export class AgentThreadsController {
  constructor(private readonly api: AgentThreadsApi) {}

  async loadRelated(focusChatId: string, fallback?: Chat | null): Promise<RelatedAgentThreads> {
    const [listed, loadedIds] = await Promise.all([
      this.api.listChats({ includeSubAgents: true, limit: AGENT_THREADS_LIST_LIMIT }),
      this.api.listLoadedChatIds().catch(() => []),
    ]);
    const listedIds = new Set(listed.map((chat) => chat.id));
    const missing = loadedIds.filter((id) => !listedIds.has(id));
    const loadedOnly = await this.api.getChatSummaries(missing);
    const chats = [...listed, ...loadedOnly];
    const focus = chats.find((chat) => chat.id === focusChatId) ?? fallback ?? null;
    return collectRelatedAgentThreads(chats, focus);
  }

  async loadDetail(threadId: string): Promise<{ chat: Chat; parent: Chat | null }> {
    const chat = await this.api.getChat(threadId, { forceRefresh: true });
    if (!chat.parentThreadId) return { chat, parent: null };
    const parent =
      this.api.peekChat(chat.parentThreadId) ??
      (await this.api.getChat(chat.parentThreadId).catch(() => null));
    return { chat, parent };
  }
}
