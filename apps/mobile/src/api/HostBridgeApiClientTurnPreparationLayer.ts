import { HostBridgeApiClientBridgeActionsLayer } from "./HostBridgeApiClientBridgeActionsLayer";
import {
  appendSyntheticUserMessage,
  isMaterializationGapError,
  isTransientThreadReadError,
  sleep,
} from "./clientChatCloneAndRetryInternals";
import {
  buildTurnInput,
  chatHasRecentUserMessage,
  normalizeAgentName,
  normalizeCollaborationMode,
  normalizeLocalImages,
  normalizeMentions,
  rawThreadHasTurns,
  rawThreadHasTurnUserMessage,
  toTurnCollaborationMode,
} from "./clientTurnInputInternals";
import { mapChat, type RawThread, toRawThread } from "./chatMapping";
import {
  normalizeApprovalPolicy,
  normalizeEffort,
  normalizeModel,
  normalizeServiceTier,
} from "./clientBridgeResponseNormalization";
import { normalizeCwd } from "./clientChatListInternals";
import {
  type AppServerReadResponse,
  type AppServerThreadRuntimeSettings,
  type ChatSnapshot,
  type PreparedTurnRequest,
  type PrepareTurnRequestOptions,
  TRANSIENT_THREAD_READ_RETRY_DELAYS_MS,
  type TurnInputLocalImage,
  type TurnInputMention,
} from "./clientContractsAndSnapshotInternals";
import {
  type Chat,
  type ChatSummary,
  type GitPushResponse,
  type SendChatMessageRequest,
} from "./types";

export abstract class HostBridgeApiClientTurnPreparationLayer extends HostBridgeApiClientBridgeActionsLayer {
  gitPush(cwd?: string): Promise<GitPushResponse> {
    const normalizedCwd = normalizeCwd(cwd);
    return this.ws.request<GitPushResponse>("bridge/git/push", {
      cwd: normalizedCwd ?? null,
    });
  }
  protected async prepareTurnRequest(
    id: string,
    body: SendChatMessageRequest,
    options?: PrepareTurnRequestOptions,
  ): Promise<PreparedTurnRequest> {
    const content = body.content.trim();
    if (!content) {
      return {
        content: "",
        mentions: [],
        localImages: [],
        turnStartParams: { threadId: id, input: [] },
      };
    }
    if ((body.role ?? "user") !== "user") {
      throw new Error("Only user role is supported in bridge/chat messaging");
    }
    const normalizedCwd = normalizeCwd(body.cwd);
    const normalizedModel = normalizeModel(body.model);
    const normalizedEffort = normalizeEffort(body.effort);
    const normalizedServiceTier = normalizeServiceTier(body.serviceTier);
    const normalizedApprovalPolicy =
      normalizeApprovalPolicy(body.approvalPolicy) ?? "untrusted";
    const normalizedMentions = normalizeMentions(body.mentions);
    const normalizedLocalImages = normalizeLocalImages(body.localImages);
    const requestedCollaborationMode = normalizeCollaborationMode(
      body.collaborationMode,
    );
    const requestedAgent = normalizeAgentName(body.agent);
    let resumedThreadSettings: AppServerThreadRuntimeSettings | null = null;
    if (!options?.skipResume) {
      resumedThreadSettings = await this.resumeThread(id, {
        model: normalizedModel,
        cwd: normalizedCwd,
        approvalPolicy: normalizedApprovalPolicy,
      });
    }
    const effectiveModel =
      normalizedModel ?? resumedThreadSettings?.model ?? null;
    const effectiveEffort = requestedCollaborationMode
      ? (normalizedEffort ?? resumedThreadSettings?.effort ?? null)
      : normalizedEffort;
    const normalizedCollaborationMode = toTurnCollaborationMode(
      requestedCollaborationMode,
      effectiveModel,
      effectiveEffort,
    );
    return {
      content,
      mentions: normalizedMentions,
      localImages: normalizedLocalImages,
      turnStartParams: {
        threadId: id,
        input: buildTurnInput(
          content,
          normalizedMentions,
          normalizedLocalImages,
        ),
        cwd: normalizedCwd ?? null,
        approvalPolicy: normalizedApprovalPolicy,
        sandboxPolicy: null,
        model: effectiveModel ?? null,
        effort: effectiveEffort ?? null,
        serviceTier: normalizedServiceTier ?? null,
        summary: "auto",
        personality: null,
        outputSchema: null,
        collaborationMode: normalizedCollaborationMode,
        agent: requestedAgent,
      },
    };
  }
  protected mapChatWithCachedTitle(rawThreadValue: unknown): Chat {
    const rawThread = toRawThread(rawThreadValue);
    this.rememberRawThreadTitle(rawThread);
    const mapped = mapChat(rawThread);
    const chat = this.applyRememberedTitle(mapped);
    this.rememberChat(chat);
    return chat;
  }
  protected rememberRawThreadTitle(rawThread: RawThread): void {
    const threadId = rawThread.id?.trim();
    const rawTitle = rawThread.name?.trim();
    if (!threadId || !rawTitle) {
      return;
    }
    this.renamedTitles.set(threadId, rawTitle);
  }
  protected applyRememberedTitle<T extends ChatSummary>(mapped: T): T {
    const cachedTitle = this.renamedTitles.get(mapped.id);
    if (!cachedTitle) {
      return mapped;
    }
    return { ...mapped, title: cachedTitle };
  }
  protected async readChatSnapshot(id: string): Promise<ChatSnapshot> {
    try {
      const response = await this.readAppServerThread(id, true);
      const rawThread = toRawThread(response.thread);
      return { rawThread, chat: this.mapChatWithCachedTitle(rawThread) };
    } catch (error) {
      if (!isMaterializationGapError(error)) {
        throw error;
      }
      const response = await this.readAppServerThread(id, false);
      const rawThread = toRawThread(response.thread);
      return { rawThread, chat: this.mapChatWithCachedTitle(rawThread) };
    }
  }
  protected async readAppServerThread(
    threadId: string,
    includeTurns: boolean,
  ): Promise<AppServerReadResponse> {
    let lastTransientError: unknown = null;
    for (
      let attempt = 0;
      attempt <= TRANSIENT_THREAD_READ_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      try {
        return await this.ws.request<AppServerReadResponse>("thread/read", {
          threadId,
          includeTurns,
        });
      } catch (error) {
        if (!isTransientThreadReadError(error)) {
          throw error;
        }
        lastTransientError = error;
        const retryDelayMs = TRANSIENT_THREAD_READ_RETRY_DELAYS_MS[attempt];
        if (retryDelayMs === undefined) {
          throw error;
        }
        await sleep(retryDelayMs);
      }
    }
    throw lastTransientError;
  }
  protected async getChatWithUserMessage(
    id: string,
    turnId: string,
    content: string,
    mentions: TurnInputMention[] = [],
    localImages: TurnInputLocalImage[] = [],
  ): Promise<Chat> {
    const normalizedContent = content.trim();
    let latestSnapshot = await this.readChatSnapshot(id);
    let latest = latestSnapshot.chat;
    if (!normalizedContent) {
      return latest;
    }
    const hasMatchingTurnMessage = rawThreadHasTurnUserMessage(
      latestSnapshot.rawThread,
      turnId,
      normalizedContent,
      mentions,
      localImages,
    );
    const hasFallbackRecentMessage =
      !rawThreadHasTurns(latestSnapshot.rawThread) &&
      chatHasRecentUserMessage(
        latest,
        normalizedContent,
        mentions,
        localImages,
      );
    if (hasMatchingTurnMessage || hasFallbackRecentMessage) {
      this.rememberChat(latest);
      return latest;
    }
    const retryDelaysMs = [25, 50, 100, 150];
    for (const delayMs of retryDelaysMs) {
      await sleep(delayMs);
      latestSnapshot = await this.readChatSnapshot(id);
      latest = latestSnapshot.chat;
      const matchedAfterRetry = rawThreadHasTurnUserMessage(
        latestSnapshot.rawThread,
        turnId,
        normalizedContent,
        mentions,
        localImages,
      );
      const matchedByFallback =
        !rawThreadHasTurns(latestSnapshot.rawThread) &&
        chatHasRecentUserMessage(
          latest,
          normalizedContent,
          mentions,
          localImages,
        );
      if (matchedAfterRetry || matchedByFallback) {
        this.rememberChat(latest);
        return latest;
      }
    }
    const synthetic = appendSyntheticUserMessage(
      latest,
      normalizedContent,
      mentions,
      localImages,
    );
    this.rememberChat(synthetic);
    return synthetic;
  }
}
