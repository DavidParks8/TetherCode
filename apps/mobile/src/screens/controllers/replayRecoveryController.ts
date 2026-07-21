import type { HostBridgeApiClient } from '../../api/client';
import type {
  BridgeCapabilities,
  BridgeThreadQueueState,
  Chat,
  PendingApproval,
  PendingUserInputRequest,
} from '../../api/types';

export const REPLAY_RECOVERY_CONCURRENCY = 4;
export const REPLAY_RECOVERY_MAX_LOADED_THREADS = 2_048;

export class ReplayRecoveryProtocolError extends Error {
  constructor(loadedThreadCount: number) {
    super(
      `Bridge returned ${loadedThreadCount} loaded threads; protocol maximum is ${REPLAY_RECOVERY_MAX_LOADED_THREADS}`
    );
    this.name = 'ReplayRecoveryProtocolError';
  }
}

type ReplayRecoveryApi = Pick<
  HostBridgeApiClient,
  | 'getChat'
  | 'listApprovals'
  | 'listLoadedChatIds'
  | 'listPendingUserInputs'
  | 'readBridgeCapabilities'
  | 'readThreadQueue'
>;

export interface ReplayRecoveryThreadSnapshot {
  chat: Chat;
  queue: BridgeThreadQueueState;
}

export interface ReplayRecoverySnapshot {
  capabilities: BridgeCapabilities;
  approvals: PendingApproval[];
  userInputs: PendingUserInputRequest[];
  threads: ReplayRecoveryThreadSnapshot[];
}

export function collectReplayRecoveryThreadIds(
  sources: ReadonlyArray<Iterable<string | null | undefined>>
): string[] {
  const ids = new Set<string>();
  for (const source of sources) {
    for (const candidate of source) {
      const threadId = candidate?.trim();
      if (threadId) ids.add(threadId);
    }
  }
  return [...ids];
}

function throwIfReplayRecoveryAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw replayRecoveryCancellationError(signal);
}

function replayRecoveryCancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Replay recovery cancelled');
}

async function awaitWithReplayRecoveryCancellation<T>(
  value: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return value;
  throwIfReplayRecoveryAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(replayRecoveryCancellationError(signal));
    signal.addEventListener('abort', abort, { once: true });
    void value.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        throwIfReplayRecoveryAborted(signal);
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await awaitWithReplayRecoveryCancellation(mapper(values[index]), signal);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

export async function fetchReplayRecoverySnapshot(
  api: ReplayRecoveryApi,
  trackedThreadIds: Iterable<string | null | undefined>,
  signal?: AbortSignal
): Promise<ReplayRecoverySnapshot> {
  throwIfReplayRecoveryAborted(signal);
  const [loadedThreadIds, approvals, userInputs, capabilities] =
    await awaitWithReplayRecoveryCancellation(Promise.all([
      api.listLoadedChatIds(),
      api.listApprovals(),
      api.listPendingUserInputs(),
      api.readBridgeCapabilities(),
    ]), signal);
  throwIfReplayRecoveryAborted(signal);
  if (loadedThreadIds.length > REPLAY_RECOVERY_MAX_LOADED_THREADS) {
    throw new ReplayRecoveryProtocolError(loadedThreadIds.length);
  }
  const threadIds = collectReplayRecoveryThreadIds([
    trackedThreadIds,
    loadedThreadIds,
    approvals.map((approval) => approval.threadId),
    userInputs.map((request) => request.threadId),
  ]);

  const threads = await mapWithConcurrency(
    threadIds,
    REPLAY_RECOVERY_CONCURRENCY,
    async (threadId) => {
      const [chat, queue] = await Promise.all([
        api.getChat(threadId, { forceRefresh: true }),
        api.readThreadQueue(threadId),
      ]);
      return { chat, queue };
    },
    signal
  );
  return { capabilities, approvals, userInputs, threads };
}