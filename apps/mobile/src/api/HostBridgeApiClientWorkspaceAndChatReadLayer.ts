import { HostBridgeApiClientChatListingLayer } from "./HostBridgeApiClientChatListingLayer";
import { chatShellFromSummary, cloneChat } from "./clientChatCloneAndRetryInternals";
import {
  mapChatSummary,
  readString,
  toRawThread,
  toRecord,
} from "./chatMapping";
import {
  normalizeAcpMode,
  normalizeApprovalPolicy,
  normalizeEffort,
  normalizeModel,
  normalizeServiceTier,
  readBrowserPreviewDiscoveryResponse,
  readBrowserPreviewSession,
  readFileSystemListResponse,
  readWorkspaceListResponse,
  toThreadConfig,
} from "./clientBridgeResponseNormalization";
import { normalizeAgentId } from "./clientTurnInputInternals";
import {
  type AppServerLoadedThreadListResponse,
  type AppServerStartResponse,
  type ListChatsOptions,
  MOBILE_DEFAULT_SANDBOX,
  MOBILE_DEVELOPER_INSTRUCTIONS,
} from "./clientContractsAndSnapshotInternals";
import {
  type BridgeThreadCreateResponse,
  type BrowserPreviewDiscoveryResponse,
  type BrowserPreviewSession,
  type Chat,
  type ChatSummary,
  type CreateChatRequest,
  type FileSystemListRequest,
  type FileSystemListResponse,
  type WorkspaceListResponse,
} from "./types";
import {
  type ChatReadOptions,
  DEFAULT_CHAT_LIST_LIMIT,
  DEFAULT_SUB_AGENT_CHAT_LIST_LIMIT,
  type ListAllChatsOptions,
  mergeChatSummariesById,
  normalizeCwd,
  normalizeListLimit,
} from "./clientChatListInternals";

export abstract class HostBridgeApiClientWorkspaceAndChatReadLayer extends HostBridgeApiClientChatListingLayer {
  protected chatListCacheKey(options: ListChatsOptions): string {
    const includeSubAgents = options.includeSubAgents === true;
    const limit = normalizeListLimit(
      options.limit ??
        (includeSubAgents
          ? DEFAULT_SUB_AGENT_CHAT_LIST_LIMIT
          : DEFAULT_CHAT_LIST_LIMIT),
    );
    return `${includeSubAgents ? "with-subagents" : "default"}:${String(limit)}`;
  }
  protected allChatListCacheKey(options: ListAllChatsOptions): string {
    return options.includeSubAgents === true ? "with-subagents" : "default";
  }
  protected mergeIntoAllChatListCaches(chats: ChatSummary[]): void {
    for (const [key, cachedList] of this.allChatListCache.entries()) {
      this.allChatListCache.set(key, {
        value: {
          ...cachedList.value,
          chats: mergeChatSummariesById(cachedList.value.chats, chats),
        },
        loadedAt: cachedList.loadedAt,
      });
    }
  }
  async listLoadedChatIds(): Promise<string[]> {
    const response = await this.ws.request<AppServerLoadedThreadListResponse>(
      "thread/loaded/list",
      undefined,
    );
    const ids = Array.isArray(response.data) ? response.data : [];
    return ids
      .map((value) => readString(value)?.trim() ?? "")
      .filter((value): value is string => value.length > 0);
  }
  async listWorkspaceRoots(limit = 200): Promise<WorkspaceListResponse> {
    const response = await this.ws.request<Record<string, unknown>>(
      "bridge/workspaces/list",
      { limit },
    );
    return readWorkspaceListResponse(response);
  }
  async listFilesystemEntries(
    request?: FileSystemListRequest,
  ): Promise<FileSystemListResponse> {
    const params: Record<string, unknown> = {
      path: normalizeCwd(request?.path) ?? null,
      includeHidden: request?.includeHidden === true,
      directoriesOnly: request?.directoriesOnly !== false,
    };
    if (request?.includeGitRepo === true) {
      params.includeGitRepo = true;
    }
    const response = await this.ws.request<Record<string, unknown>>(
      "bridge/fs/list",
      params,
    );
    return readFileSystemListResponse(response);
  }
  async createBrowserPreviewSession(
    targetUrl: string,
  ): Promise<BrowserPreviewSession> {
    const response = await this.ws.request<Record<string, unknown>>(
      "bridge/browser/session/create",
      { targetUrl },
    );
    const session = readBrowserPreviewSession(response);
    if (!session) {
      throw new Error(
        "bridge/browser/session/create returned an invalid session payload",
      );
    }
    return session;
  }
  async listBrowserPreviewSessions(): Promise<BrowserPreviewSession[]> {
    const response = await this.ws.request<Record<string, unknown>>(
      "bridge/browser/sessions/list",
    );
    const record = toRecord(response) ?? {};
    const rawSessions = Array.isArray(record.sessions) ? record.sessions : [];
    return rawSessions
      .map((entry) => readBrowserPreviewSession(entry))
      .filter((entry): entry is BrowserPreviewSession => entry !== null);
  }
  async closeBrowserPreviewSession(sessionId: string): Promise<boolean> {
    const response = await this.ws.request<Record<string, unknown>>(
      "bridge/browser/session/close",
      { sessionId },
    );
    return response.closed === true;
  }
  async discoverBrowserPreviewTargets(): Promise<BrowserPreviewDiscoveryResponse> {
    const response = await this.ws.request<Record<string, unknown>>(
      "bridge/browser/targets/discover",
    );
    return readBrowserPreviewDiscoveryResponse(response);
  }
  async createChat(body: CreateChatRequest): Promise<Chat> {
    const requestedAgentId = normalizeAgentId(body.agentId);
    const requestedCwd = normalizeCwd(body.cwd);
    const requestedModel = normalizeModel(body.model);
    const requestedEffort = normalizeEffort(body.effort);
    const requestedMode =
      normalizeAcpMode(body.agentMode) ??
      (body.collaborationMode === "plan" ? "plan" : "build");
    const requestedServiceTier = normalizeServiceTier(body.serviceTier);
    const requestedApprovalPolicy =
      normalizeApprovalPolicy(body.approvalPolicy) ?? "untrusted";
    const started = await this.ws.request<AppServerStartResponse>(
      "thread/start",
      {
        agentId: requestedAgentId ?? undefined,
        model: requestedModel ?? null,
        effort: requestedEffort ?? null,
        mode: requestedMode,
        modelProvider: null,
        cwd: requestedCwd ?? null,
        approvalPolicy: requestedApprovalPolicy,
        sandbox: MOBILE_DEFAULT_SANDBOX,
        config: toThreadConfig(requestedServiceTier),
        baseInstructions: null,
        developerInstructions: MOBILE_DEVELOPER_INSTRUCTIONS,
        personality: null,
        ephemeral: null,
        experimentalRawEvents: true,
        persistExtendedHistory: true,
      },
    );
    const chatId = started.thread?.id;
    if (!chatId) {
      throw new Error("thread/start did not return a chat id");
    }
    const initialPrompt = body.message?.trim();
    if (initialPrompt) {
      return this.sendChatMessage(chatId, {
        content: initialPrompt,
        role: "user",
        cwd: requestedCwd ?? undefined,
        model: requestedModel ?? undefined,
        effort: requestedEffort ?? undefined,
        approvalPolicy: requestedApprovalPolicy,
      });
    }
    if (started.thread) {
      return this.mapChatWithCachedTitle(started.thread);
    }
    return this.getChat(chatId);
  }
  async createChatIdempotent(
    body: CreateChatRequest,
    submissionId: string,
  ): Promise<Chat> {
    const requestedAgentId = normalizeAgentId(body.agentId);
    const requestedCwd = normalizeCwd(body.cwd);
    const requestedModel = normalizeModel(body.model);
    const requestedEffort = normalizeEffort(body.effort);
    const requestedMode =
      normalizeAcpMode(body.agentMode) ??
      (body.collaborationMode === "plan" ? "plan" : "build");
    const requestedServiceTier = normalizeServiceTier(body.serviceTier);
    const requestedApprovalPolicy =
      normalizeApprovalPolicy(body.approvalPolicy) ?? "untrusted";
    const started = await this.ws.request<BridgeThreadCreateResponse>(
      "bridge/thread/create",
      {
        submissionId,
        threadStart: {
          agentId: requestedAgentId ?? undefined,
          model: requestedModel ?? null,
          effort: requestedEffort ?? null,
          mode: requestedMode,
          modelProvider: null,
          cwd: requestedCwd ?? null,
          approvalPolicy: requestedApprovalPolicy,
          sandbox: MOBILE_DEFAULT_SANDBOX,
          config: toThreadConfig(requestedServiceTier),
          baseInstructions: null,
          developerInstructions: MOBILE_DEVELOPER_INSTRUCTIONS,
          personality: null,
          ephemeral: null,
          experimentalRawEvents: true,
          persistExtendedHistory: true,
        },
      },
    );
    const thread = toRecord(started.thread);
    const chatId = readString(thread?.id);
    if (!chatId || !thread)
      throw new Error("bridge/thread/create did not return a chat");
    return this.mapChatWithCachedTitle(thread);
  }
  async getChat(id: string, options: ChatReadOptions = {}): Promise<Chat> {
    const threadId = id.trim();
    const cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 0);
    const cached = this.chatCache.get(threadId);
    if (!options.forceRefresh && cacheTtlMs > 0 && cached) {
      const ageMs = Date.now() - cached.loadedAt;
      if (ageMs <= cacheTtlMs) {
        return cloneChat(cached.value);
      }
    }
    const inFlight = this.chatInFlight.get(threadId);
    if (inFlight) {
      return cloneChat(await inFlight);
    }
    const request = this.readChatSnapshot(threadId)
      .then((snapshot) => {
        this.rememberChat(snapshot.chat);
        return snapshot.chat;
      })
      .finally(() => {
        this.chatInFlight.delete(threadId);
      });
    this.chatInFlight.set(threadId, request);
    return cloneChat(await request);
  }
  async getChatSummary(id: string): Promise<ChatSummary> {
    const response = await this.readAppServerThread(id, false);
    const rawThread = toRawThread(response.thread);
    this.rememberRawThreadTitle(rawThread);
    const mapped = mapChatSummary(rawThread);
    if (!mapped) {
      throw new Error("chat id missing in app-server response");
    }
    const summary = this.applyRememberedTitle(mapped);
    const cachedChat = this.peekChat(summary.id);
    this.rememberChat(
      cachedChat
        ? { ...cachedChat, ...summary, messages: cachedChat.messages }
        : chatShellFromSummary(summary),
    );
    return summary;
  }
}
