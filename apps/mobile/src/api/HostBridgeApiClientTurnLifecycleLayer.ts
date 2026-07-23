import { HostBridgeApiClientWorkspaceAndChatReadLayer } from "./HostBridgeApiClientWorkspaceAndChatReadLayer";
import {
  ACTIVE_TURN_STATUSES,
  type ChatSummariesReadOptions,
  normalizeConcurrency,
  normalizeCwd,
  normalizeUniqueThreadIds,
} from "./clientChatListInternals";
import {
  buildTurnInput,
  normalizeLocalImages,
  normalizeMentions,
  readThreadRuntimeSettings,
} from "./clientTurnInputInternals";
import {
  normalizeApprovalPolicy,
  normalizeModel,
  normalizeTurnStatus,
} from "./clientBridgeResponseNormalization";
import { readString } from "./chatMapping";
import {
  type AppServerThreadRuntimeSettings,
  type AppServerTurnResponse,
  createSubmissionId,
  DEFAULT_CHAT_SUMMARY_HYDRATION_CONCURRENCY,
  MAX_CHAT_SUMMARY_HYDRATION_CONCURRENCY,
  MOBILE_DEFAULT_SANDBOX,
  MOBILE_DEVELOPER_INSTRUCTIONS,
  type PrepareTurnRequestOptions,
  type SendChatMessageOptions,
  type SendOrQueueChatMessageResult,
} from "./clientContractsAndSnapshotInternals";
import {
  type ApprovalPolicy,
  type BridgeThreadQueueSendResponse,
  type BridgeThreadQueueState,
  type Chat,
  type ChatSummary,
  type SendChatMessageRequest,
  type SteerChatTurnRequest,
} from "./types";

export abstract class HostBridgeApiClientTurnLifecycleLayer extends HostBridgeApiClientWorkspaceAndChatReadLayer {
  async getChatSummaries(
    ids: readonly string[],
    options: ChatSummariesReadOptions = {},
  ): Promise<ChatSummary[]> {
    const uniqueIds = normalizeUniqueThreadIds(ids);
    if (uniqueIds.length === 0) {
      return [];
    }
    const concurrency = normalizeConcurrency(
      options.concurrency,
      DEFAULT_CHAT_SUMMARY_HYDRATION_CONCURRENCY,
      MAX_CHAT_SUMMARY_HYDRATION_CONCURRENCY,
    );
    const results: Array<ChatSummary | null> = Array(uniqueIds.length).fill(
      null,
    );
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, uniqueIds.length) },
      async () => {
        while (nextIndex < uniqueIds.length) {
          const index = nextIndex;
          nextIndex += 1;
          try {
            results[index] = await this.getChatSummary(uniqueIds[index]);
          } catch {
            results[index] = null;
          }
        }
      },
    );
    await Promise.all(workers);
    return results.filter(
      (summary): summary is ChatSummary => summary !== null,
    );
  }
  async setChatWorkspace(id: string, cwd: string): Promise<Chat> {
    const normalizedCwd = normalizeCwd(cwd);
    if (!normalizedCwd) {
      throw new Error("Workspace path cannot be empty");
    }
    await this.resumeThread(id, { cwd: normalizedCwd });
    const updated = await this.getChat(id);
    if (updated.cwd === normalizedCwd) {
      return updated;
    }
    return { ...updated, cwd: normalizedCwd };
  }
  async resumeThread(
    id: string,
    options?: {
      cwd?: string | null;
      model?: string | null;
      approvalPolicy?: ApprovalPolicy | null;
    },
  ): Promise<AppServerThreadRuntimeSettings> {
    const threadId = id.trim();
    if (!threadId) {
      throw new Error("thread id is required");
    }
    const requestedCwd = normalizeCwd(options?.cwd);
    if (!requestedCwd) {
      throw new Error(
        "Cannot resume thread without its canonical workspace path",
      );
    }
    const requestedApprovalPolicy =
      normalizeApprovalPolicy(options?.approvalPolicy) ?? "untrusted";
    const request = {
      threadId,
      history: null,
      path: null,
      model: normalizeModel(options?.model) ?? null,
      modelProvider: null,
      cwd: requestedCwd,
      approvalPolicy: requestedApprovalPolicy,
      sandbox: MOBILE_DEFAULT_SANDBOX,
      config: null,
      baseInstructions: null,
      developerInstructions: MOBILE_DEVELOPER_INSTRUCTIONS,
      personality: null,
      experimentalRawEvents: true,
      persistExtendedHistory: true,
    };
    const response = await this.ws.request<Record<string, unknown>>(
      "thread/resume",
      request,
    );
    return readThreadRuntimeSettings(response);
  }
  async sendChatMessage(
    id: string,
    body: SendChatMessageRequest,
    options?: SendChatMessageOptions,
  ): Promise<Chat> {
    const prepared = await this.prepareTurnRequest(id, body);
    if (!prepared.content) {
      return this.getChat(id);
    }
    const turnStart = await this.ws.request<AppServerTurnResponse>(
      "turn/start",
      prepared.turnStartParams,
    );
    const turnId = turnStart.turn?.id;
    if (!turnId) {
      throw new Error("turn/start did not return turn id");
    }
    options?.onTurnStarted?.(turnId);
    return this.getChatWithUserMessage(
      id,
      turnId,
      prepared.content,
      prepared.mentions,
      prepared.localImages,
    );
  }
  async sendChatMessageIdempotent(
    id: string,
    body: SendChatMessageRequest,
    submissionId: string,
    options?: Pick<SendChatMessageOptions, "onTurnStarted">,
  ): Promise<Chat> {
    const result = await this.sendOrQueueChatMessage(id, body, {
      submissionId,
    });
    if (result.disposition === "queued") {
      return this.getChat(id);
    }
    options?.onTurnStarted?.(result.turnId);
    return result.chat;
  }
  async sendOrQueueChatMessage(
    id: string,
    body: SendChatMessageRequest,
    options?: PrepareTurnRequestOptions,
  ): Promise<SendOrQueueChatMessageResult> {
    const prepared = await this.prepareTurnRequest(id, body, options);
    if (!prepared.content) {
      return {
        disposition: "sent",
        queue: await this.readThreadQueue(id),
        turnId: "",
        chat: await this.getChat(id),
      };
    }
    const response = await this.ws.request<BridgeThreadQueueSendResponse>(
      "bridge/thread/queue/send",
      {
        threadId: id,
        submissionId: options?.submissionId?.trim() || createSubmissionId(),
        content: prepared.content,
        turnStart: prepared.turnStartParams,
      },
    );
    if (response.disposition === "queued") {
      return {
        disposition: "queued",
        queue: response.queue,
        turnId: null,
        chat: null,
      };
    }
    const turnId = response.turnId?.trim();
    if (!turnId) {
      throw new Error(
        "bridge/thread/queue/send did not return turn id for sent message",
      );
    }
    const chat = await this.getChatWithUserMessage(
      id,
      turnId,
      prepared.content,
      prepared.mentions,
      prepared.localImages,
    );
    return { disposition: "sent", queue: response.queue, turnId, chat };
  }
  async steerChatTurn(
    threadId: string,
    expectedTurnId: string,
    body: SteerChatTurnRequest,
  ): Promise<void> {
    const normalizedThreadId = threadId.trim();
    const normalizedExpectedTurnId = expectedTurnId.trim();
    const content = body.content.trim();
    if (!normalizedThreadId || !normalizedExpectedTurnId || !content) {
      return;
    }
    const normalizedMentions = normalizeMentions(body.mentions);
    const normalizedLocalImages = normalizeLocalImages(body.localImages);
    await this.ws.request<Record<string, never>>("turn/steer", {
      threadId: normalizedThreadId,
      expectedTurnId: normalizedExpectedTurnId,
      input: buildTurnInput(content, normalizedMentions, normalizedLocalImages),
    });
  }
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const normalizedThreadId = threadId.trim();
    const normalizedTurnId = turnId.trim();
    if (!normalizedThreadId || !normalizedTurnId) {
      throw new Error("threadId and turnId are required to interrupt a turn");
    }
    await this.ws.request<Record<string, never>>("turn/interrupt", {
      threadId: normalizedThreadId,
      turnId: normalizedTurnId,
    });
  }
  async interruptLatestTurn(threadId: string): Promise<string | null> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("threadId is required to interrupt the active turn");
    }
    const snapshot = await this.readChatSnapshot(normalizedThreadId);
    const turns = Array.isArray(snapshot.rawThread.turns)
      ? snapshot.rawThread.turns
      : [];
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i];
      const turnId = readString(turn.id);
      const status = normalizeTurnStatus(readString(turn.status));
      if (!turnId || !status || !ACTIVE_TURN_STATUSES.has(status)) {
        continue;
      }
      await this.interruptTurn(normalizedThreadId, turnId);
      return turnId;
    }
    return null;
  }
  readThreadQueue(threadId: string): Promise<BridgeThreadQueueState> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      return Promise.resolve({
        threadId: "",
        items: [],
        pendingSteers: [],
        pendingSteerCount: 0,
        waitingForToolCalls: false,
        steeringInFlight: false,
        lastError: null,
      });
    }
    return this.ws.request<BridgeThreadQueueState>("bridge/thread/queue/read", {
      threadId: normalizedThreadId,
    });
  }
}
