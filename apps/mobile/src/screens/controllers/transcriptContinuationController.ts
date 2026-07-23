import {
  mergeSnapshotPage,
  StaleSnapshotRevisionError,
  type HostBridgeApiClient,
} from '../../api/client';
import { applySnapshotToChat } from '../../api/chatMapping';
import type { Chat } from '../../api/types';

export interface TranscriptContinuationState {
  loading: boolean;
  error: string | null;
  exhausted: boolean;
  unavailableCount: number;
}

export type TranscriptContinuationResult =
  | { kind: 'merged'; chat: Chat; state: TranscriptContinuationState }
  | { kind: 'stale'; state: TranscriptContinuationState };

type SnapshotPageApi = Pick<HostBridgeApiClient, 'readSnapshotPage'>;

export function getTranscriptContinuationState(chat: Chat): TranscriptContinuationState {
  const snapshot = chat.acpSnapshot;
  const collections = [
    snapshot?.messageCollection,
    snapshot?.reasoningCollection,
    snapshot?.toolCollection,
  ].filter((value) => value !== undefined);
  const beforeCursor = collections.find(
    (collection) => collection && collection.omittedCount > 0 && collection.beforeCursor
  )?.beforeCursor;
  return {
    loading: false,
    error: null,
    exhausted: !beforeCursor,
    unavailableCount: snapshot?.continuation?.unavailableCount ?? 0,
  };
}

export class TranscriptContinuationController {
  private inFlightCursor: string | null = null;

  constructor(private readonly api: SnapshotPageApi) {}

  async loadEarlier(chat: Chat): Promise<TranscriptContinuationResult> {
    const snapshot = chat.acpSnapshot;
    const revision = snapshot?.continuation?.revision;
    const beforeCursor = [
      snapshot?.messageCollection,
      snapshot?.reasoningCollection,
      snapshot?.toolCollection,
    ].find((collection) => collection && collection.omittedCount > 0 && collection.beforeCursor)
      ?.beforeCursor;
    const baseState = getTranscriptContinuationState(chat);
    if (!snapshot || revision === undefined || !beforeCursor) {
      return { kind: 'merged', chat, state: baseState };
    }
    if (this.inFlightCursor === beforeCursor) {
      return { kind: 'merged', chat, state: { ...baseState, loading: true } };
    }

    this.inFlightCursor = beforeCursor;
    try {
      const page = await this.api.readSnapshotPage({
        threadId: chat.id,
        beforeCursor,
        revision,
        limit: snapshot.continuation?.maxPageSize || 50,
      });
      const mergedSnapshot = mergeSnapshotPage(snapshot, page);
      const mergedChat = applySnapshotToChat(chat, mergedSnapshot);
      return {
        kind: 'merged',
        chat: mergedChat,
        state: getTranscriptContinuationState(mergedChat),
      };
    } catch (error) {
      if (error instanceof StaleSnapshotRevisionError) {
        return { kind: 'stale', state: baseState };
      }
      return {
        kind: 'merged',
        chat,
        state: {
          ...baseState,
          error: (error as Error).message || 'Unable to load earlier history',
        },
      };
    } finally {
      if (this.inFlightCursor === beforeCursor) {
        this.inFlightCursor = null;
      }
    }
  }
}
