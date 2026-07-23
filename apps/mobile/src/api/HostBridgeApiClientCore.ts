import type { RawThread } from "./chatMapping";
import type {
  CacheEntry,
  ChatListPage,
  ChatListResult,
  ChatListStreamBatch,
  ChatListStreamController,
  ChatListStreamOptions,
  ChatReadOptions,
  ChatSummariesReadOptions,
  ListAllChatsOptions,
} from "./clientChatListInternals";
import type {
  AgentId,
  ApprovalPolicy,
  BridgeCapabilities,
  BridgeStatus,
  BridgeThreadQueueActionResponse,
  BridgeThreadQueueState,
  BrowserPreviewDiscoveryResponse,
  BrowserPreviewSession,
  Chat,
  ChatSummary,
  CreateChatRequest,
  DismissBridgeUiSurfaceResponse,
  FileSystemListRequest,
  FileSystemListResponse,
  GitBranchesResponse,
  GitCloneRequest,
  GitCloneResponse,
  GitCommitRequest,
  GitCommitResponse,
  GitDiffResponse,
  GitFileRequest,
  GitHistoryResponse,
  GitHubAuthGrantInput,
  GitHubAuthInstallResponse,
  GitPushResponse,
  GitStageAllResponse,
  GitStageResponse,
  GitStatusResponse,
  GitSwitchRequest,
  GitSwitchResponse,
  GitUnstageAllResponse,
  GitUnstageResponse,
  ModelOption,
  PendingApproval,
  PendingUserInputRequest,
  ResolveApprovalResponse,
  ResolveBridgeUiSurfaceRequest,
  ResolveBridgeUiSurfaceResponse,
  ResolveUserInputRequest,
  ResolveUserInputResponse,
  SendChatMessageRequest,
  SteerChatTurnRequest,
  TerminalExecRequest,
  TerminalExecResponse,
  UploadAttachmentRequest,
  UploadAttachmentResponse,
  WorkspaceListResponse,
} from "./types";
import type {
  ApiClientOptions,
  AppServerReadResponse,
  AppServerThreadRuntimeSettings,
  ChatListPageOptions,
  ChatSnapshot,
  HealthResponse,
  ListChatsOptions,
  PreparedTurnRequest,
  PrepareTurnRequestOptions,
  SendChatMessageOptions,
  SendOrQueueChatMessageResult,
  SnapshotPageResponse,
  TurnInputLocalImage,
  TurnInputMention,
} from "./clientContractsAndSnapshotInternals";
import type { HostBridgeWsClient } from "./ws";

export abstract class HostBridgeApiClientCore {
  protected readonly ws: HostBridgeWsClient;
  protected readonly bridgeUrl: string | null;
  protected readonly authToken: string | null;
  protected readonly renamedTitles = new Map<string, string>();
  protected readonly chatListCache = new Map<
    string,
    CacheEntry<ChatSummary[]>
  >();
  protected readonly chatListInFlight = new Map<
    string,
    Promise<ChatSummary[]>
  >();
  protected readonly allChatListCache = new Map<
    string,
    CacheEntry<ChatListResult>
  >();
  protected readonly allChatListInFlight = new Map<
    string,
    Promise<ChatListResult>
  >();
  protected readonly chatCache = new Map<string, CacheEntry<Chat>>();
  protected readonly chatInFlight = new Map<string, Promise<Chat>>();
  constructor(options: ApiClientOptions) {
    this.ws = options.ws;
    this.bridgeUrl = options.bridgeUrl?.replace(/\/$/, "") ?? null;
    this.authToken = options.authToken?.trim() || null;
  }
  abstract health(): Promise<HealthResponse>;
  abstract readBridgeStatus(): Promise<BridgeStatus>;
  abstract readBridgeCapabilities(): Promise<BridgeCapabilities>;
  abstract listModelOptions(agentId?: AgentId | null): Promise<ModelOption[]>;
  abstract setThreadConfigOption(
    threadId: string,
    configId: string,
    value: string | boolean,
  ): Promise<Chat>;
  abstract renameChat(threadId: string, title: string): Promise<Chat>;
  abstract registerPushDevice(input: {
    profileId: string;
    registrationId: string;
    token: string;
    platform: string;
    deviceName: string;
    events: { turnCompleted: boolean; approvalRequested: boolean };
  }): Promise<{ ok: boolean; deviceCount: number }>;
  abstract unregisterPushDevice(input: {
    profileId: string;
    registrationId: string;
  }): Promise<{ ok: boolean; removed: boolean }>;
  abstract peekChats(options?: ListChatsOptions): ChatSummary[] | null;
  abstract rememberChats(
    chats: ChatSummary[],
    options?: ListChatsOptions,
  ): void;
  abstract peekAllChats(options?: ListAllChatsOptions): ChatSummary[] | null;
  abstract rememberAllChats(
    chats: ChatSummary[],
    options?: ListAllChatsOptions,
  ): void;
  abstract peekChat(id: string): Chat | null;
  abstract peekChatSummary(id: string): ChatSummary | null;
  abstract peekChatShell(id: string): Chat | null;
  abstract rememberChat(chat: Chat): void;
  abstract primeChats(options?: ListChatsOptions): Promise<ChatSummary[]>;
  abstract listChats(options?: ListChatsOptions): Promise<ChatSummary[]>;
  abstract listAllChats(options?: ListAllChatsOptions): Promise<ChatListResult>;
  abstract startChatListStream(
    options: ChatListStreamOptions | undefined,
    onBatch: (batch: ChatListStreamBatch) => void,
    onError?: (error: Error) => void,
  ): Promise<ChatListStreamController>;
  protected abstract fetchChats(
    options: ListChatsOptions,
  ): Promise<ChatSummary[]>;
  protected abstract fetchAllChats(
    options: ListAllChatsOptions,
  ): Promise<ChatListResult>;
  protected abstract fetchChatPage(
    options: ChatListPageOptions,
  ): Promise<ChatListPage>;
  abstract readSnapshotPage(request: {
    threadId: string;
    beforeCursor?: string | null;
    afterCursor?: string | null;
    revision?: number;
    limit?: number;
  }): Promise<SnapshotPageResponse>;
  protected abstract mapChatListItems(
    listRaw: unknown[],
    includeSubAgents: boolean,
  ): ChatSummary[];
  protected abstract chatListCacheKey(options: ListChatsOptions): string;
  protected abstract allChatListCacheKey(options: ListAllChatsOptions): string;
  protected abstract mergeIntoAllChatListCaches(chats: ChatSummary[]): void;
  abstract listLoadedChatIds(): Promise<string[]>;
  abstract listWorkspaceRoots(limit?: number): Promise<WorkspaceListResponse>;
  abstract listFilesystemEntries(
    request?: FileSystemListRequest,
  ): Promise<FileSystemListResponse>;
  abstract createBrowserPreviewSession(
    targetUrl: string,
  ): Promise<BrowserPreviewSession>;
  abstract listBrowserPreviewSessions(): Promise<BrowserPreviewSession[]>;
  abstract closeBrowserPreviewSession(sessionId: string): Promise<boolean>;
  abstract discoverBrowserPreviewTargets(): Promise<BrowserPreviewDiscoveryResponse>;
  abstract createChat(body: CreateChatRequest): Promise<Chat>;
  abstract createChatIdempotent(
    body: CreateChatRequest,
    submissionId: string,
  ): Promise<Chat>;
  abstract getChat(id: string, options?: ChatReadOptions): Promise<Chat>;
  abstract getChatSummary(id: string): Promise<ChatSummary>;
  abstract getChatSummaries(
    ids: readonly string[],
    options?: ChatSummariesReadOptions,
  ): Promise<ChatSummary[]>;
  abstract setChatWorkspace(id: string, cwd: string): Promise<Chat>;
  abstract resumeThread(
    id: string,
    options?: {
      cwd?: string | null;
      model?: string | null;
      approvalPolicy?: ApprovalPolicy | null;
    },
  ): Promise<AppServerThreadRuntimeSettings>;
  abstract sendChatMessage(
    id: string,
    body: SendChatMessageRequest,
    options?: SendChatMessageOptions,
  ): Promise<Chat>;
  abstract sendChatMessageIdempotent(
    id: string,
    body: SendChatMessageRequest,
    submissionId: string,
    options?: Pick<SendChatMessageOptions, "onTurnStarted">,
  ): Promise<Chat>;
  abstract sendOrQueueChatMessage(
    id: string,
    body: SendChatMessageRequest,
    options?: PrepareTurnRequestOptions,
  ): Promise<SendOrQueueChatMessageResult>;
  abstract steerChatTurn(
    threadId: string,
    expectedTurnId: string,
    body: SteerChatTurnRequest,
  ): Promise<void>;
  abstract interruptTurn(threadId: string, turnId: string): Promise<void>;
  abstract interruptLatestTurn(threadId: string): Promise<string | null>;
  abstract readThreadQueue(threadId: string): Promise<BridgeThreadQueueState>;
  abstract steerQueuedThreadMessage(
    threadId: string,
    itemId: string,
  ): Promise<BridgeThreadQueueActionResponse>;
  abstract cancelQueuedThreadMessage(
    threadId: string,
    itemId: string,
  ): Promise<BridgeThreadQueueActionResponse>;
  abstract uploadAttachment(
    body: UploadAttachmentRequest,
  ): Promise<UploadAttachmentResponse>;
  abstract listApprovals(): Promise<PendingApproval[]>;
  abstract listPendingUserInputs(): Promise<PendingUserInputRequest[]>;
  abstract resolveApproval(
    id: string,
    decision: string,
    resolutionId: string,
  ): Promise<ResolveApprovalResponse>;
  abstract resolveUserInput(
    id: string,
    body: ResolveUserInputRequest,
  ): Promise<ResolveUserInputResponse>;
  abstract resolveBridgeUiSurface(
    id: string,
    body: ResolveBridgeUiSurfaceRequest,
  ): Promise<ResolveBridgeUiSurfaceResponse>;
  abstract dismissBridgeUiSurface(
    id: string,
    threadId?: string | null,
  ): Promise<DismissBridgeUiSurfaceResponse>;
  abstract execTerminal(
    body: TerminalExecRequest,
  ): Promise<TerminalExecResponse>;
  abstract installGitHubAuth(
    body:
      | { accessToken: string; repositories?: string[] }
      | { grants: GitHubAuthGrantInput[] },
  ): Promise<GitHubAuthInstallResponse>;
  abstract gitStatus(cwd?: string): Promise<GitStatusResponse>;
  abstract gitDiff(cwd?: string): Promise<GitDiffResponse>;
  abstract gitHistory(
    cwd?: string,
    limit?: number,
  ): Promise<GitHistoryResponse>;
  abstract gitBranches(cwd?: string): Promise<GitBranchesResponse>;
  abstract gitClone(body: GitCloneRequest): Promise<GitCloneResponse>;
  abstract gitStage(body: GitFileRequest): Promise<GitStageResponse>;
  abstract gitStageAll(cwd?: string): Promise<GitStageAllResponse>;
  abstract gitUnstage(body: GitFileRequest): Promise<GitUnstageResponse>;
  abstract gitUnstageAll(cwd?: string): Promise<GitUnstageAllResponse>;
  abstract gitCommit(body: GitCommitRequest): Promise<GitCommitResponse>;
  abstract gitSwitch(body: GitSwitchRequest): Promise<GitSwitchResponse>;
  abstract gitPush(cwd?: string): Promise<GitPushResponse>;
  protected abstract prepareTurnRequest(
    id: string,
    body: SendChatMessageRequest,
    options?: PrepareTurnRequestOptions,
  ): Promise<PreparedTurnRequest>;
  protected abstract mapChatWithCachedTitle(rawThreadValue: unknown): Chat;
  protected abstract rememberRawThreadTitle(rawThread: RawThread): void;
  protected abstract applyRememberedTitle<T extends ChatSummary>(mapped: T): T;
  protected abstract readChatSnapshot(id: string): Promise<ChatSnapshot>;
  protected abstract readAppServerThread(
    threadId: string,
    includeTurns: boolean,
  ): Promise<AppServerReadResponse>;
  protected abstract getChatWithUserMessage(
    id: string,
    turnId: string,
    content: string,
    mentions?: TurnInputMention[],
    localImages?: TurnInputLocalImage[],
  ): Promise<Chat>;
}
