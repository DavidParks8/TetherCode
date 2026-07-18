import type { HostBridgeApiClient } from '../../api/client';
import type { SendOrQueueChatMessageResult } from '../../api/client';
import type {
  BridgeThreadQueueActionResponse,
  Chat,
  CreateChatRequest,
  SendChatMessageRequest,
} from '../../api/types';

type TurnApi = Pick<
  HostBridgeApiClient,
  | 'createChat'
  | 'sendChatMessage'
  | 'sendOrQueueChatMessage'
  | 'interruptTurn'
  | 'interruptLatestTurn'
  | 'steerQueuedThreadMessage'
  | 'cancelQueuedThreadMessage'
>;

export interface CreateAndStartTurnRequest {
  create: CreateChatRequest;
  message: SendChatMessageRequest | ((chat: Chat) => SendChatMessageRequest);
  onCreated?: (chat: Chat) => void;
  onTurnStarted?: (threadId: string, turnId: string) => void;
}

export class TurnExecutionController {
  constructor(private readonly api: TurnApi) {}

  create(request: CreateChatRequest): Promise<Chat> {
    return this.api.createChat(request);
  }

  send(
    threadId: string,
    message: SendChatMessageRequest,
    onTurnStarted?: (turnId: string) => void
  ): Promise<Chat> {
    return this.api.sendChatMessage(
      threadId,
      message,
      onTurnStarted ? { onTurnStarted } : undefined
    );
  }

  async createAndStart(request: CreateAndStartTurnRequest): Promise<Chat> {
    const created = await this.create(request.create);
    request.onCreated?.(created);
    const message =
      typeof request.message === 'function' ? request.message(created) : request.message;
    return this.send(created.id, message, (turnId) =>
      request.onTurnStarted?.(created.id, turnId)
    );
  }

  sendOrQueue(
    threadId: string,
    message: SendChatMessageRequest,
    skipResume: boolean
  ): Promise<SendOrQueueChatMessageResult> {
    return this.api.sendOrQueueChatMessage(threadId, message, { skipResume });
  }

  async interrupt(threadId: string, turnId?: string | null): Promise<string | null> {
    if (turnId) {
      await this.api.interruptTurn(threadId, turnId);
      return turnId;
    }
    return this.api.interruptLatestTurn(threadId);
  }

  steer(threadId: string, messageId: string): Promise<BridgeThreadQueueActionResponse> {
    return this.api.steerQueuedThreadMessage(threadId, messageId);
  }

  cancelQueued(threadId: string, messageId: string): Promise<BridgeThreadQueueActionResponse> {
    return this.api.cancelQueuedThreadMessage(threadId, messageId);
  }
}
