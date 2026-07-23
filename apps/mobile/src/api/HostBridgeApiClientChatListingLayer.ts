import { HostBridgeApiClientHealthAndCacheLayer } from "./HostBridgeApiClientHealthAndCacheLayer";
import { cloneChatSummaries } from "./clientChatCloneAndRetryInternals";
import {
  mapChatSummary,
  readString,
  toRawThread,
  toRecord,
} from "./chatMapping";
import {
  type AppServerListResponse,
  CHAT_LIST_SOURCE_KINDS,
  CHAT_LIST_SOURCE_KINDS_WITH_SUBAGENTS,
  type ChatListPageOptions,
  type ListChatsOptions,
  type SnapshotPageResponse,
  THREAD_LIST_STREAM_BATCH_METHOD,
  THREAD_LIST_STREAM_ERROR_METHOD,
  type ThreadListStreamStartResponse,
} from "./clientContractsAndSnapshotInternals";
import {
  type ChatListPage,
  type ChatListResult,
  type ChatListStreamBatch,
  type ChatListStreamController,
  type ChatListStreamOptions,
  cloneChatListResult,
  DEFAULT_CHAT_LIST_LIMIT,
  DEFAULT_SUB_AGENT_CHAT_LIST_LIMIT,
  isSubAgentSource,
  type ListAllChatsOptions,
  MAX_CHAT_LIST_PAGES,
  mergeChatSummariesById,
  normalizeChatListStreamLimits,
  normalizeCursor,
  normalizeListLimit,
  readSnapshotPageResponse,
} from "./clientChatListInternals";
import { type ChatSummary, type RpcNotification } from "./types";

export abstract class HostBridgeApiClientChatListingLayer extends HostBridgeApiClientHealthAndCacheLayer {
  async listAllChats(
    options: ListAllChatsOptions = {},
  ): Promise<ChatListResult> {
    const cacheKey = this.allChatListCacheKey(options);
    const cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 0);
    const cached = this.allChatListCache.get(cacheKey);
    if (!options.forceRefresh && cacheTtlMs > 0 && cached) {
      const ageMs = Date.now() - cached.loadedAt;
      if (ageMs <= cacheTtlMs) {
        return cloneChatListResult(cached.value);
      }
    }
    const inFlight = this.allChatListInFlight.get(cacheKey);
    if (inFlight) {
      return cloneChatListResult(await inFlight);
    }
    const request = this.fetchAllChats(options).finally(() => {
      this.allChatListInFlight.delete(cacheKey);
    });
    this.allChatListInFlight.set(cacheKey, request);
    return cloneChatListResult(await request);
  }
  async startChatListStream(
    options: ChatListStreamOptions = {},
    onBatch: (batch: ChatListStreamBatch) => void,
    onError?: (error: Error) => void,
  ): Promise<ChatListStreamController> {
    const includeSubAgents = options.includeSubAgents === true;
    const limits = normalizeChatListStreamLimits(
      options.limits,
      includeSubAgents
        ? DEFAULT_SUB_AGENT_CHAT_LIST_LIMIT
        : DEFAULT_CHAT_LIST_LIMIT,
    );
    const streamId = `mobile-thread-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let closed = false;
    const unsubscribe = this.ws.onEvent((event: RpcNotification) => {
      const params = toRecord(event.params);
      if (!params || readString(params.streamId) !== streamId) {
        return;
      }
      if (event.method === THREAD_LIST_STREAM_ERROR_METHOD) {
        closed = true;
        unsubscribe();
        onError?.(
          new Error(readString(params.error) ?? "thread list stream failed"),
        );
        return;
      }
      if (event.method !== THREAD_LIST_STREAM_BATCH_METHOD) {
        return;
      }
      const limit = normalizeListLimit(params.limit);
      const rawList = Array.isArray(params.data) ? params.data : [];
      const chats = this.mapChatListItems(rawList, includeSubAgents);
      this.rememberChats(chats, { includeSubAgents, limit });
      onBatch({ streamId, limit, done: params.done === true, chats });
      if (params.done === true) {
        closed = true;
        unsubscribe();
      }
    });
    const cancel = () => {
      if (closed) {
        return;
      }
      closed = true;
      unsubscribe();
      void this.ws
        .request("bridge/thread/list/stream/cancel", { streamId })
        .catch(() => {});
    };
    try {
      const response = await this.ws.request<ThreadListStreamStartResponse>(
        "bridge/thread/list/stream/start",
        {
          streamId,
          includeSubAgents,
          limits,
          delayMs:
            typeof options.delayMs === "number" &&
            Number.isFinite(options.delayMs)
              ? Math.max(0, Math.round(options.delayMs))
              : undefined,
        },
      );
      if (
        readString(response.streamId) !== streamId ||
        response.started === false
      ) {
        cancel();
        throw new Error("thread list stream did not start");
      }
    } catch (error) {
      cancel();
      throw error;
    }
    return { streamId, cancel };
  }
  protected async fetchChats(
    options: ListChatsOptions,
  ): Promise<ChatSummary[]> {
    const page = await this.fetchChatPage(options);
    this.rememberChats(page.chats, options);
    return page.chats;
  }
  protected async fetchAllChats(
    options: ListAllChatsOptions,
  ): Promise<ChatListResult> {
    const includeSubAgents = options.includeSubAgents === true;
    const pageLimit = normalizeListLimit(
      options.pageLimit ??
        (includeSubAgents
          ? DEFAULT_SUB_AGENT_CHAT_LIST_LIMIT
          : DEFAULT_CHAT_LIST_LIMIT),
    );
    let cursor: string | null = null;
    let chats: ChatSummary[] = [];
    const diagnostics = new Set<string>();
    let partial = false;
    const seenCursors = new Set<string>();
    let pageCount = 0;
    do {
      if (pageCount >= MAX_CHAT_LIST_PAGES) {
        diagnostics.add("Chat listing reached the 32-page safety limit.");
        partial = true;
        break;
      }
      const requestedCursor = cursor;
      if (requestedCursor && seenCursors.has(requestedCursor)) {
        diagnostics.add("Chat listing repeated a page cursor.");
        partial = true;
        break;
      }
      if (requestedCursor) seenCursors.add(requestedCursor);
      pageCount += 1;
      const previousCount = chats.length;
      const page = await this.fetchChatPage({
        includeSubAgents,
        limit: pageLimit,
        cursor,
        forceRefresh: true,
      });
      chats = mergeChatSummariesById(chats, page.chats);
      page.diagnostics.forEach((diagnostic) => diagnostics.add(diagnostic));
      partial ||= page.partial;
      if (options.onPage) {
        options.onPage(cloneChatSummaries(chats), {
          ...page,
          chats: cloneChatSummaries(page.chats),
        });
      }
      cursor = page.nextCursor;
      if (cursor && chats.length === previousCount) {
        diagnostics.add("Chat listing made no progress on a page.");
        partial = true;
        break;
      }
    } while (cursor);
    const result = {
      chats,
      diagnostics: [...diagnostics],
      partial,
    };
    this.allChatListCache.set(this.allChatListCacheKey(options), {
      value: cloneChatListResult(result),
      loadedAt: Date.now(),
    });
    return result;
  }
  protected async fetchChatPage(
    options: ChatListPageOptions,
  ): Promise<ChatListPage> {
    const includeSubAgents = options?.includeSubAgents === true;
    const limit = normalizeListLimit(
      options.limit ??
        (includeSubAgents
          ? DEFAULT_SUB_AGENT_CHAT_LIST_LIMIT
          : DEFAULT_CHAT_LIST_LIMIT),
    );
    const response = await this.ws.request<AppServerListResponse>(
      "thread/list",
      {
        cursor: normalizeCursor(options.cursor),
        limit,
        sortKey: "updated_at",
        modelProviders: null,
        sourceKinds: includeSubAgents
          ? CHAT_LIST_SOURCE_KINDS_WITH_SUBAGENTS
          : CHAT_LIST_SOURCE_KINDS,
        archived: false,
        cwd: null,
        agentId: options.agentId,
      },
    );
    const listRaw = Array.isArray(response.data) ? response.data : [];
    const chats = this.mapChatListItems(listRaw, includeSubAgents);
    return {
      chats,
      nextCursor:
        readString(response.nextCursor) ??
        readString(response.next_cursor) ??
        null,
      backwardsCursor:
        readString(response.backwardsCursor) ??
        readString(response.backwards_cursor) ??
        null,
      diagnostics: Array.isArray(response.diagnostics)
        ? response.diagnostics
            .map((value) => readString(value))
            .filter((value): value is string => Boolean(value))
        : [],
      partial:
        response.partial === true ||
        (Array.isArray(response.diagnostics) &&
          response.diagnostics.length > 0),
    };
  }
  async readSnapshotPage(request: {
    threadId: string;
    beforeCursor?: string | null;
    afterCursor?: string | null;
    revision?: number;
    limit?: number;
  }): Promise<SnapshotPageResponse> {
    const response = await this.ws.request<Record<string, unknown>>(
      "thread/snapshot/page",
      {
        threadId: request.threadId,
        beforeCursor: request.beforeCursor ?? null,
        afterCursor: request.afterCursor ?? null,
        revision: request.revision,
        limit: request.limit ?? 50,
      },
    );
    return readSnapshotPageResponse(response);
  }
  protected mapChatListItems(
    listRaw: unknown[],
    includeSubAgents: boolean,
  ): ChatSummary[] {
    return listRaw
      .map((item) => {
        const rawThread = toRawThread(item);
        this.rememberRawThreadTitle(rawThread);
        const mapped = mapChatSummary(rawThread);
        if (!mapped) {
          return null;
        }
        return this.applyRememberedTitle(mapped);
      })
      .filter((item): item is ChatSummary => item !== null)
      .filter((item) => includeSubAgents || !isSubAgentSource(item.sourceKind))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
