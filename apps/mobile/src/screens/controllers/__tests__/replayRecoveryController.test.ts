import type { HostBridgeApiClient } from '../../../api/client';
import type { BridgeCapabilities, Chat } from '../../../api/types';
import {
  collectReplayRecoveryThreadIds,
  fetchReplayRecoverySnapshot,
  REPLAY_RECOVERY_CONCURRENCY,
  REPLAY_RECOVERY_MAX_LOADED_THREADS,
  ReplayRecoveryProtocolError,
} from '../replayRecoveryController';

const capabilities = { agents: [] } as unknown as BridgeCapabilities;

function chat(id: string): Chat {
  return { id, messages: [] } as unknown as Chat;
}

function createApi() {
  return {
    listLoadedChatIds: jest.fn().mockResolvedValue(['selected', 'background-b', 'loaded-new']),
    listApprovals: jest.fn().mockResolvedValue([{ id: 'approval', threadId: 'background-a' }]),
    listPendingUserInputs: jest.fn().mockResolvedValue([{ id: 'input', threadId: 'background-b' }]),
    readBridgeCapabilities: jest.fn().mockResolvedValue(capabilities),
    getChat: jest.fn((threadId: string) => Promise.resolve(chat(threadId))),
    readThreadQueue: jest.fn((threadId: string) => Promise.resolve({ threadId })),
  } as unknown as jest.Mocked<HostBridgeApiClient>;
}

describe('replay recovery controller', () => {
  it('deduplicates tracked IDs and ignores empty IDs', () => {
    expect(collectReplayRecoveryThreadIds([[' selected ', null], ['selected', '', 'background']]))
      .toEqual(['selected', 'background']);
  });

  it('expands through loaded threads and pending interactions before returning one snapshot', async () => {
    const api = createApi();
    const result = await fetchReplayRecoverySnapshot(api, ['selected', 'background-a']);

    expect(result.threads.map(({ chat: value }) => value.id)).toEqual([
      'selected', 'background-a', 'background-b', 'loaded-new',
    ]);
    expect(result.approvals).toHaveLength(1);
    expect(result.userInputs).toHaveLength(1);
    expect(result.capabilities).toBe(capabilities);
    expect(api.getChat).toHaveBeenCalledTimes(4);
    expect(api.readThreadQueue).toHaveBeenCalledTimes(4);
  });

  it('rejects the entire snapshot when one late thread fails and refetches all threads on retry', async () => {
    const api = createApi();
    api.listApprovals.mockResolvedValue([]);
    api.listPendingUserInputs.mockResolvedValue([]);
    api.listLoadedChatIds.mockResolvedValue(['thread-0', 'thread-1', 'thread-2', 'thread-3', 'thread-4']);
    api.getChat.mockImplementation((threadId) => threadId === 'thread-4'
      ? Promise.reject(new Error('background unavailable'))
      : Promise.resolve(chat(threadId)));

    await expect(fetchReplayRecoverySnapshot(api, []))
      .rejects.toThrow('background unavailable');
    const failedAttemptCalls = api.getChat.mock.calls.length;
    api.getChat.mockImplementation((threadId) => Promise.resolve(chat(threadId)));
    await expect(fetchReplayRecoverySnapshot(api, []))
      .resolves.toMatchObject({ threads: expect.any(Array) });
    expect(api.getChat.mock.calls.length - failedAttemptCalls).toBe(5);
    expect(api.readThreadQueue.mock.calls.length - failedAttemptCalls).toBe(5);
  });

  it.each([201, REPLAY_RECOVERY_MAX_LOADED_THREADS])(
    'fetches every snapshot and queue for %i loaded threads with concurrency at most four',
    async (threadCount) => {
    const api = createApi();
    api.listApprovals.mockResolvedValue([]);
    api.listPendingUserInputs.mockResolvedValue([]);
    api.listLoadedChatIds.mockResolvedValue(
      Array.from({ length: threadCount }, (_, index) => `thread-${index}`)
    );
    let active = 0;
    let maximumActive = 0;
    api.getChat.mockImplementation(async (threadId) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return chat(threadId);
    });
    const recovery = await fetchReplayRecoverySnapshot(api, []);
    expect(recovery.threads).toHaveLength(threadCount);
    expect(api.getChat).toHaveBeenCalledTimes(threadCount);
    expect(api.readThreadQueue).toHaveBeenCalledTimes(threadCount);
    expect(maximumActive).toBeLessThanOrEqual(REPLAY_RECOVERY_CONCURRENCY);
  });

  it('fails with a protocol error before thread reads when the bridge loaded list exceeds its maximum', async () => {
    const api = createApi();
    api.listLoadedChatIds.mockResolvedValue(
      Array.from({ length: REPLAY_RECOVERY_MAX_LOADED_THREADS + 1 }, (_, index) => `thread-${index}`)
    );
    await expect(fetchReplayRecoverySnapshot(api, [])).rejects.toBeInstanceOf(ReplayRecoveryProtocolError);
    expect(api.getChat).not.toHaveBeenCalled();
  });

  it('aborts a stale recovery promptly without dispatching the remaining threads', async () => {
    const api = createApi();
    api.listLoadedChatIds.mockResolvedValue(
      Array.from({ length: 201 }, (_, index) => `thread-${index}`)
    );
    api.getChat.mockImplementation(() => new Promise<Chat>(() => {}));
    const controller = new AbortController();
    const recovery = fetchReplayRecoverySnapshot(api, [], controller.signal);
    while (api.getChat.mock.calls.length < REPLAY_RECOVERY_CONCURRENCY) await Promise.resolve();
    controller.abort(new Error('stale watermark'));
    await expect(recovery).rejects.toThrow('stale watermark');
    expect(api.getChat).toHaveBeenCalledTimes(REPLAY_RECOVERY_CONCURRENCY);
    expect(api.readThreadQueue).toHaveBeenCalledTimes(REPLAY_RECOVERY_CONCURRENCY);
  });
});