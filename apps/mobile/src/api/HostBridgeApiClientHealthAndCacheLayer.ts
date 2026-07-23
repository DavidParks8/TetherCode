import { HostBridgeApiClientCore } from "./HostBridgeApiClientCore";
import {
  DEFAULT_PREFETCH_CACHE_TTL_MS,
  type ListAllChatsOptions,
} from "./clientChatListInternals";
import {
  chatShellFromSummary,
  cloneChat,
  cloneChatSummaries,
  cloneChatSummary,
} from "./clientChatCloneAndRetryInternals";
import { normalizeEffort, readPositiveInteger } from "./clientBridgeResponseNormalization";
import { readString, toRecord } from "./chatMapping";
import {
  type AgentId,
  type BridgeCapabilities,
  type BridgeStatus,
  type Chat,
  type ChatSummary,
  type ModelOption,
  type ReasoningEffort,
} from "./types";
import {
  type AppServerStartResponse,
  type HealthResponse,
  type ListChatsOptions,
} from "./clientContractsAndSnapshotInternals";

export abstract class HostBridgeApiClientHealthAndCacheLayer extends HostBridgeApiClientCore {
  health(): Promise<HealthResponse> {
    return this.ws.request<HealthResponse>("bridge/health/read");
  }
  readBridgeStatus(): Promise<BridgeStatus> {
    return this.ws.request<BridgeStatus>("bridge/status/read");
  }
  readBridgeCapabilities(): Promise<BridgeCapabilities> {
    return this.ws.request<BridgeCapabilities>("bridge/capabilities/read");
  }
  async listModelOptions(agentId?: AgentId | null): Promise<ModelOption[]> {
    const response = await this.ws.request<Record<string, unknown>>(
      "model/list",
      { agentId: agentId ?? null },
    );
    const entries = Array.isArray(response.data) ? response.data : [];
    return entries
      .map((entry) => toRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .map((entry) => {
        const id = readString(entry.id)?.trim() ?? "";
        const displayName = readString(entry.displayName)?.trim() ?? id;
        const providerId = readString(entry.providerId)?.trim() || undefined;
        const providerName =
          readString(entry.providerName)?.trim() || undefined;
        const contextWindow = readPositiveInteger(entry.contextWindow);
        const reasoningEffort = (
          Array.isArray(entry.reasoningEffort) ? entry.reasoningEffort : []
        )
          .map((value) => normalizeEffort(readString(value)))
          .filter((value): value is ReasoningEffort => value !== null)
          .map((effort) => ({ effort }));
        return {
          id,
          displayName,
          providerId,
          providerName,
          contextWindow:
            contextWindow && contextWindow > 0 ? contextWindow : undefined,
          reasoningEffort:
            reasoningEffort.length > 0 ? reasoningEffort : undefined,
        } satisfies ModelOption;
      })
      .filter((entry) => entry.id.length > 0);
  }
  async setThreadConfigOption(
    threadId: string,
    configId: string,
    value: string | boolean,
  ): Promise<Chat> {
    const normalizedThreadId = threadId.trim();
    const normalizedConfigId = configId.trim();
    if (!normalizedThreadId || !normalizedConfigId) {
      throw new Error("thread and config option are required");
    }
    const response = await this.ws.request<AppServerStartResponse>(
      "thread/config/set",
      { threadId: normalizedThreadId, configId: normalizedConfigId, value },
    );
    if (!response.thread) {
      throw new Error("thread/config/set did not return a chat");
    }
    const chat = this.mapChatWithCachedTitle(response.thread);
    this.rememberChat(chat);
    return chat;
  }
  async renameChat(threadId: string, title: string): Promise<Chat> {
    const normalizedThreadId = threadId.trim();
    const normalizedTitle = title.trim();
    if (!normalizedThreadId || !normalizedTitle) {
      throw new Error("thread and title are required");
    }
    const response = await this.ws.request<AppServerStartResponse>(
      "thread/name/update",
      { threadId: normalizedThreadId, title: normalizedTitle },
    );
    if (!response.thread) {
      throw new Error("thread/name/update did not return a chat");
    }
    const chat = this.mapChatWithCachedTitle(response.thread);
    this.renamedTitles.set(chat.id, normalizedTitle);
    this.rememberChat(chat);
    return chat;
  }
  registerPushDevice(input: {
    profileId: string;
    registrationId: string;
    token: string;
    platform: string;
    deviceName: string;
    events: { turnCompleted: boolean; approvalRequested: boolean };
  }): Promise<{ ok: boolean; deviceCount: number }> {
    return this.ws.request<{ ok: boolean; deviceCount: number }>(
      "bridge/push/register",
      input,
    );
  }
  unregisterPushDevice(input: {
    profileId: string;
    registrationId: string;
  }): Promise<{ ok: boolean; removed: boolean }> {
    return this.ws.request<{ ok: boolean; removed: boolean }>(
      "bridge/push/unregister",
      { ...input },
    );
  }
  peekChats(options: ListChatsOptions = {}): ChatSummary[] | null {
    const cached = this.chatListCache.get(this.chatListCacheKey(options));
    return cached ? cloneChatSummaries(cached.value) : null;
  }
  rememberChats(chats: ChatSummary[], options: ListChatsOptions = {}): void {
    this.chatListCache.set(this.chatListCacheKey(options), {
      value: cloneChatSummaries(chats),
      loadedAt: Date.now(),
    });
    if (chats.length > 0) {
      this.mergeIntoAllChatListCaches(chats);
    }
  }
  peekAllChats(options: ListAllChatsOptions = {}): ChatSummary[] | null {
    const cached = this.allChatListCache.get(this.allChatListCacheKey(options));
    return cached ? cloneChatSummaries(cached.value.chats) : null;
  }
  rememberAllChats(
    chats: ChatSummary[],
    options: ListAllChatsOptions = {},
  ): void {
    this.allChatListCache.set(this.allChatListCacheKey(options), {
      value: {
        chats: cloneChatSummaries(chats),
        diagnostics: [],
        partial: false,
      },
      loadedAt: Date.now(),
    });
  }
  peekChat(id: string): Chat | null {
    const cached = this.chatCache.get(id.trim());
    return cached ? cloneChat(cached.value) : null;
  }
  peekChatSummary(id: string): ChatSummary | null {
    const threadId = id.trim();
    if (!threadId) {
      return null;
    }
    const cachedChat = this.chatCache.get(threadId);
    if (cachedChat) {
      return cloneChatSummary(cachedChat.value);
    }
    for (const cachedList of this.chatListCache.values()) {
      const match = cachedList.value.find((chat) => chat.id === threadId);
      if (match) {
        return cloneChatSummary(match);
      }
    }
    for (const cachedList of this.allChatListCache.values()) {
      const match = cachedList.value.chats.find((chat) => chat.id === threadId);
      if (match) {
        return cloneChatSummary(match);
      }
    }
    return null;
  }
  peekChatShell(id: string): Chat | null {
    const cachedChat = this.peekChat(id);
    if (cachedChat) {
      return cachedChat;
    }
    const summary = this.peekChatSummary(id);
    return summary ? chatShellFromSummary(summary) : null;
  }
  rememberChat(chat: Chat): void {
    const cloned = cloneChat(chat);
    this.chatCache.set(chat.id, { value: cloned, loadedAt: Date.now() });
    for (const [key, cachedList] of this.chatListCache.entries()) {
      const index = cachedList.value.findIndex((entry) => entry.id === chat.id);
      if (index < 0) {
        continue;
      }
      const nextList = cloneChatSummaries(cachedList.value);
      nextList[index] = cloneChatSummary(chat);
      this.chatListCache.set(key, {
        value: nextList,
        loadedAt: cachedList.loadedAt,
      });
    }
    for (const [key, cachedList] of this.allChatListCache.entries()) {
      const index = cachedList.value.chats.findIndex(
        (entry) => entry.id === chat.id,
      );
      if (index < 0) {
        continue;
      }
      const nextList = cloneChatSummaries(cachedList.value.chats);
      nextList[index] = cloneChatSummary(chat);
      this.allChatListCache.set(key, {
        value: { ...cachedList.value, chats: nextList },
        loadedAt: cachedList.loadedAt,
      });
    }
  }
  primeChats(options: ListChatsOptions = {}): Promise<ChatSummary[]> {
    return this.listChats({
      cacheTtlMs: DEFAULT_PREFETCH_CACHE_TTL_MS,
      ...options,
    });
  }
  async listChats(options: ListChatsOptions = {}): Promise<ChatSummary[]> {
    const cacheKey = this.chatListCacheKey(options);
    const cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 0);
    const cached = this.chatListCache.get(cacheKey);
    if (!options.forceRefresh && cacheTtlMs > 0 && cached) {
      const ageMs = Date.now() - cached.loadedAt;
      if (ageMs <= cacheTtlMs) {
        return cloneChatSummaries(cached.value);
      }
    }
    const inFlight = this.chatListInFlight.get(cacheKey);
    if (inFlight) {
      return cloneChatSummaries(await inFlight);
    }
    const request = this.fetchChats(options).finally(() => {
      this.chatListInFlight.delete(cacheKey);
    });
    this.chatListInFlight.set(cacheKey, request);
    return cloneChatSummaries(await request);
  }
}
