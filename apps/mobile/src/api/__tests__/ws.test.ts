import { Platform } from 'react-native';

import {
  BridgeProtocolVersionError,
  HostBridgeWsClient,
  RpcRequestError,
} from '../ws';

class MockWebSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  send = jest.fn();
  close = jest.fn();
  readyState = 1;

  simulateOpen() {
    this.onopen?.();
  }

  simulateClose() {
    this.onclose?.();
  }

  simulateError() {
    this.onerror?.();
  }

  simulateMessage(data: string) {
    this.onmessage?.({ data });
  }
}

let mockInstances: MockWebSocket[];

function latestMockSocket(): MockWebSocket {
  return mockInstances[mockInstances.length - 1];
}

beforeEach(() => {
  mockInstances = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).WebSocket = jest.fn(() => {
    const ws = new MockWebSocket();
    mockInstances.push(ws);
    return ws;
  });
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (global as any).WebSocket;
});

describe('HostBridgeWsClient', () => {
  it('connect() builds /rpc websocket URL', () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();

    expect(global.WebSocket).toHaveBeenCalledWith('ws://localhost:8787/rpc');
  });

  it('sends Authorization header on native when auth token is provided', () => {
    const client = new HostBridgeWsClient('http://localhost:8787', {
      authToken: 'token-abc',
    });
    client.connect();

    if (Platform.OS === 'web') {
      expect(global.WebSocket).toHaveBeenCalledWith('ws://localhost:8787/rpc');
      return;
    }

    expect(global.WebSocket).toHaveBeenCalledWith('ws://localhost:8787/rpc', undefined, {
      headers: { Authorization: 'Bearer token-abc' },
    });
  });

  it('supports query token auth fallback when enabled', () => {
    const client = new HostBridgeWsClient('http://localhost:8787', {
      authToken: 'token-xyz',
      allowQueryTokenAuth: true,
    });
    client.connect();

    if (Platform.OS === 'web' || Platform.OS === 'android') {
      expect(global.WebSocket).toHaveBeenCalledWith('ws://localhost:8787/rpc?token=token-xyz');
      return;
    }

    expect(global.WebSocket).toHaveBeenCalledWith('ws://localhost:8787/rpc', undefined, {
      headers: { Authorization: 'Bearer token-xyz' },
    });
  });

  it('onEvent emits rpc notifications', () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onEvent(listener);
    client.connect();
    latestMockSocket().simulateOpen();

    latestMockSocket().simulateMessage(
      JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr_1' } })
    );

    expect(listener).toHaveBeenCalledWith({
      method: 'turn/completed',
      params: { threadId: 'thr_1' },
    });
  });

  it('request() resolves using JSON-RPC response id', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();

    const socket = latestMockSocket();
    socket.simulateOpen();

    const requestPromise = client.request<{ ok: boolean }>('bridge/health/read');
    await Promise.resolve();

    const sentPayload = JSON.parse(String(socket.send.mock.calls[0][0])) as {
      id: string;
      method: string;
    };

    expect(sentPayload.method).toBe('bridge/health/read');

    socket.simulateMessage(
      JSON.stringify({
        id: sentPayload.id,
        result: { ok: true },
      })
    );

    await expect(requestPromise).resolves.toEqual({ ok: true });
  });

  it('request() preserves structured JSON-RPC errors', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();

    const socket = latestMockSocket();
    socket.simulateOpen();

    const requestPromise = client.request('thread/resume', { threadId: 'thr_1' });
    await Promise.resolve();

    const sentPayload = JSON.parse(String(socket.send.mock.calls[0][0])) as { id: string };
    socket.simulateMessage(
      JSON.stringify({
        id: sentPayload.id,
        error: {
          code: -32602,
          message: 'unknown field `experimentalRawEvents`',
          data: { field: 'experimentalRawEvents' },
        },
      })
    );

    const error = await requestPromise.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RpcRequestError);
    expect(error).toMatchObject({
      name: 'RpcRequestError',
      method: 'thread/resume',
      code: -32602,
      message: 'unknown field `experimentalRawEvents`',
      data: { field: 'experimentalRawEvents' },
    });
  });

  it('preserves structured bridge overload errors', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();
    const socket = latestMockSocket();
    socket.simulateOpen();
    const requestPromise = client.request('bridge/health/read');
    await Promise.resolve();
    const sentPayload = JSON.parse(String(socket.send.mock.calls[0][0])) as { id: string };

    socket.simulateMessage(
      JSON.stringify({
        id: sentPayload.id,
        error: {
          code: -32005,
          message: 'Bridge request capacity is exhausted',
          data: {
            error: 'overloaded',
            resource: 'global_in_flight_requests',
            limit: 128,
            retryable: true,
          },
        },
      })
    );

    await expect(requestPromise).rejects.toMatchObject({
      code: -32005,
      method: 'bridge/health/read',
      data: {
        error: 'overloaded',
        resource: 'global_in_flight_requests',
        retryable: true,
      },
    });
  });

  it('onStatus emits open/close state changes', () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onStatus(listener);
    client.connect();

    const socket = latestMockSocket();
    socket.simulateOpen();
    client.disconnect();

    expect(listener).toHaveBeenNthCalledWith(1, true);
    expect(listener).toHaveBeenNthCalledWith(2, false);
  });

  it('disconnect() ignores a late onopen from a socket that was still opening', () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onStatus(listener);

    client.connect();
    const firstSocket = latestMockSocket();

    client.disconnect();
    expect(firstSocket.close).toHaveBeenCalledTimes(1);
    expect(client.isConnected).toBe(false);

    firstSocket.simulateOpen();

    expect(client.isConnected).toBe(false);
    expect(listener.mock.calls).toEqual([[false]]);

    client.connect();
    const secondSocket = latestMockSocket();
    expect(secondSocket).not.toBe(firstSocket);

    secondSocket.simulateOpen();

    expect(client.isConnected).toBe(true);
    expect(listener.mock.calls).toEqual([[false], [true]]);
  });

  it('retries when a socket closes before opening', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const client = new HostBridgeWsClient('http://localhost:8787');
      client.connect();

      latestMockSocket().simulateClose();
      await Promise.resolve();
      await Promise.resolve();

      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(499);
      expect(mockInstances).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(mockInstances).toHaveLength(2);
    } finally {
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  });

  it('retries pre-open errors with one exponential backoff timer', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const client = new HostBridgeWsClient('http://localhost:8787');
      client.connect();

      const firstSocket = latestMockSocket();
      firstSocket.simulateError();
      await Promise.resolve();
      await Promise.resolve();

      expect(firstSocket.close).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(500);
      expect(mockInstances).toHaveLength(2);

      latestMockSocket().simulateClose();
      await Promise.resolve();
      await Promise.resolve();
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(999);
      expect(mockInstances).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(1);
      expect(mockInstances).toHaveLength(3);
    } finally {
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  });

  it('disconnect() cancels a scheduled reconnect', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const client = new HostBridgeWsClient('http://localhost:8787');
      client.connect();
      latestMockSocket().simulateClose();
      await Promise.resolve();
      await Promise.resolve();
      expect(jest.getTimerCount()).toBe(1);

      client.disconnect();
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(mockInstances).toHaveLength(1);
    } finally {
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  });

  it('ignores stale socket callbacks after a new connection owns the transport', () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onEvent(listener);

    client.connect();
    const staleSocket = latestMockSocket();
    client.disconnect();

    client.connect();
    const activeSocket = latestMockSocket();
    activeSocket.simulateOpen();
    simulateConnectionIdentity(activeSocket, 'stream-active');
    listener.mockClear();

    staleSocket.simulateOpen();
    staleSocket.simulateMessage(
      JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr_stale' } })
    );
    staleSocket.simulateClose();

    expect(client.isConnected).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it('waitForTurnCompletion resolves from cached completion events', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();
    latestMockSocket().simulateOpen();

    latestMockSocket().simulateMessage(
      JSON.stringify({
        method: 'turn/completed',
        params: {
          threadId: 'thr_1',
          turn: {
            id: 'turn_1',
            status: 'completed',
          },
        },
      })
    );

    await expect(client.waitForTurnCompletion('thr_1', 'turn_1', 100)).resolves.toBeUndefined();
  });

  it('waitForTurnCompletion accepts snake_case completion payloads', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();
    latestMockSocket().simulateOpen();

    const waitPromise = client.waitForTurnCompletion('thr_2', 'turn_2', 100);
    latestMockSocket().simulateMessage(
      JSON.stringify({
        method: 'turn/completed',
        params: {
          thread_id: 'thr_2',
          turn_id: 'turn_2',
          status: 'completed',
        },
      })
    );

    await expect(waitPromise).resolves.toBeUndefined();
  });

  it('waitForTurnCompletion ignores completion payloads without turn id', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();
    latestMockSocket().simulateOpen();

    const waitPromise = client.waitForTurnCompletion('thr_3', 'turn_3', 100);
    latestMockSocket().simulateMessage(
      JSON.stringify({
        method: 'turn/completed',
        params: {
          threadId: 'thr_3',
          status: 'completed',
        },
      })
    );

    await expect(waitPromise).rejects.toThrow('turn timed out');
  });

  it('waitForTurnCompletion ignores codex completion events without an exact turn id', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();
    latestMockSocket().simulateOpen();

    const waitPromise = client.waitForTurnCompletion('thr_4', 'turn_4', 100);
    latestMockSocket().simulateMessage(
      JSON.stringify({
        method: 'codex/event/task_complete',
        params: {
          msg: {
            type: 'task_complete',
            thread_id: 'thr_4',
          },
        },
      })
    );

    await expect(waitPromise).rejects.toThrow('turn timed out');
  });

  it('waitForTurnCompletion ignores parent-scoped codex completion events', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();
    latestMockSocket().simulateOpen();

    const waitPromise = client.waitForTurnCompletion('thr_5', 'turn_5', 100);
    latestMockSocket().simulateMessage(
      JSON.stringify({
        method: 'codex/event/task_complete',
        params: {
          msg: {
            type: 'task_complete',
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: 'thr_5',
                },
              },
            },
          },
        },
      })
    );

    await expect(waitPromise).rejects.toThrow('turn timed out');
  });

  it('waitForTurnCompletion still requires a turn id for direct-child codex events', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();
    latestMockSocket().simulateOpen();

    const waitPromise = client.waitForTurnCompletion('thr_child', 'turn_child', 100);
    latestMockSocket().simulateMessage(
      JSON.stringify({
        method: 'codex/event/task_complete',
        params: {
          msg: {
            type: 'task_complete',
            thread_id: 'thr_child',
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: 'thr_parent',
                },
              },
            },
          },
        },
      })
    );

    await expect(waitPromise).rejects.toThrow('turn timed out');
  });

  it('deduplicates notifications by eventId', () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onEvent(listener);
    client.connect();
    latestMockSocket().simulateOpen();

    latestMockSocket().simulateMessage(
      JSON.stringify({
        method: 'turn/completed',
        eventId: 5,
        params: {
          threadId: 'thr_1',
          turn: {
            id: 'turn_1',
            status: 'completed',
          },
        },
      })
    );
    latestMockSocket().simulateMessage(
      JSON.stringify({
        method: 'turn/completed',
        eventId: 5,
        params: {
          threadId: 'thr_1',
          turn: {
            id: 'turn_1',
            status: 'completed',
          },
        },
      })
    );
    latestMockSocket().simulateMessage(
      JSON.stringify({
        method: 'turn/completed',
        eventId: 4,
        params: {
          threadId: 'thr_1',
          turn: {
            id: 'turn_1',
            status: 'completed',
          },
        },
      })
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      method: 'turn/completed',
      eventId: 5,
      params: {
        threadId: 'thr_1',
        turn: {
          id: 'turn_1',
          status: 'completed',
        },
      },
    });
  });

  it('requests replay from latest event id after reconnect', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onEvent(listener);
    client.connect();

    const firstSocket = latestMockSocket();
    firstSocket.simulateOpen();
    simulateConnectionIdentity(firstSocket, 'stream-a');
    firstSocket.simulateMessage(
      JSON.stringify({
        method: 'turn/started',
        eventId: 10,
        params: {
          threadId: 'thr_9',
          turnId: 'turn_9',
        },
      })
    );

    client.disconnect();
    client.connect();
    const secondSocket = latestMockSocket();
    secondSocket.simulateOpen();
    simulateConnectionIdentity(secondSocket, 'stream-a');
    await Promise.resolve();

    const replayRequest = secondSocket.send.mock.calls
      .map((call) =>
        JSON.parse(String(call[0])) as {
          id: string;
          method: string;
          params?: {
            afterEventId?: number;
          };
        }
      )
      .find((payload) => payload.method === 'bridge/events/replay');

    expect(replayRequest).toBeDefined();
    expect(replayRequest?.params?.afterEventId).toBe(10);

    secondSocket.simulateMessage(
      JSON.stringify({
        id: replayRequest?.id,
        result: {
          protocolVersion: 1,
          streamId: 'stream-a',
          events: [
            {
              method: 'turn/completed',
              eventId: 11,
              params: {
                threadId: 'thr_9',
                turn: {
                  id: 'turn_9',
                  status: 'completed',
                },
              },
            },
          ],
          hasMore: false,
        },
      })
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(listener).toHaveBeenCalledWith({
      method: 'turn/completed',
      eventId: 11,
      params: {
        threadId: 'thr_9',
        turn: {
          id: 'turn_9',
          status: 'completed',
        },
      },
    });
  });

  it('replays missed events without duplicating live events received after reconnect', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onEvent(listener);
    client.connect();

    const firstSocket = latestMockSocket();
    firstSocket.simulateOpen();
    simulateConnectionIdentity(firstSocket, 'stream-a');
    firstSocket.simulateMessage(
      JSON.stringify({
        method: 'turn/started',
        eventId: 100,
        params: {
          threadId: 'thr_gap',
          turnId: 'turn_gap',
        },
      })
    );
    listener.mockClear();

    client.disconnect();
    client.connect();
    const secondSocket = latestMockSocket();
    secondSocket.simulateOpen();
    simulateConnectionIdentity(secondSocket, 'stream-a');
    await Promise.resolve();

    const replayRequest = secondSocket.send.mock.calls
      .map((call) =>
        JSON.parse(String(call[0])) as {
          id: string;
          method: string;
          params?: {
            afterEventId?: number;
          };
        }
      )
      .find((payload) => payload.method === 'bridge/events/replay');
    expect(replayRequest).toBeDefined();
    expect(replayRequest?.params?.afterEventId).toBe(100);

    secondSocket.simulateMessage(
      JSON.stringify({
        method: 'turn/started',
        eventId: 105,
        params: {
          threadId: 'thr_gap',
          turnId: 'turn_gap',
        },
      })
    );
    secondSocket.simulateMessage(
      JSON.stringify({
        method: 'turn/completed',
        eventId: 106,
        params: {
          threadId: 'thr_gap',
          turn: {
            id: 'turn_gap',
            status: 'completed',
          },
        },
      })
    );

    expect(
      listener.mock.calls
        .map((call) => (call[0] as { eventId?: number }).eventId)
        .filter((id): id is number => typeof id === 'number')
    ).toEqual([]);

    secondSocket.simulateMessage(
      JSON.stringify({
        id: replayRequest?.id,
        result: {
          protocolVersion: 1,
          streamId: 'stream-a',
          events: [
            {
              method: 'turn/started',
              eventId: 103,
              params: {
                threadId: 'thr_gap',
                turnId: 'turn_gap',
              },
            },
            {
              method: 'turn/started',
              eventId: 101,
              params: {
                threadId: 'thr_gap',
                turnId: 'turn_gap',
              },
            },
            {
              method: 'turn/started',
              eventId: 104,
              params: {
                threadId: 'thr_gap',
                turnId: 'turn_gap',
              },
            },
            {
              method: 'turn/started',
              eventId: 102,
              params: {
                threadId: 'thr_gap',
                turnId: 'turn_gap',
              },
            },
            {
              method: 'turn/completed',
              eventId: 106,
              params: {
                threadId: 'thr_gap',
                turn: {
                  id: 'turn_gap',
                  status: 'completed',
                },
              },
            },
            {
              method: 'turn/started',
              eventId: 105,
              params: {
                threadId: 'thr_gap',
                turnId: 'turn_gap',
              },
            },
          ],
          hasMore: false,
        },
      })
    );

    await Promise.resolve();
    await Promise.resolve();

    const eventIds = listener.mock.calls
      .map((call) => (call[0] as { eventId?: number }).eventId)
      .filter((id): id is number => typeof id === 'number');

    expect(eventIds).toEqual([101, 102, 103, 104, 105, 106]);
  });

  it('replays a live event gap before delivering the buffered event', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onEvent(listener);
    client.connect();

    const socket = latestMockSocket();
    socket.simulateOpen();
    simulateConnectionIdentity(socket, 'stream-gap');
    socket.simulateMessage(
      JSON.stringify({ method: 'turn/started', eventId: 10, params: { threadId: 'thr_gap' } })
    );
    listener.mockClear();

    socket.simulateMessage(
      JSON.stringify({ method: 'turn/completed', eventId: 12, params: { threadId: 'thr_gap' } })
    );
    await Promise.resolve();

    expect(listener).not.toHaveBeenCalled();
    const replayRequest = readLatestReplayRequest(socket);
    expect(replayRequest?.params?.afterEventId).toBe(10);

    socket.simulateMessage(
      JSON.stringify({
        id: replayRequest?.id,
        result: {
          protocolVersion: 1,
          streamId: 'stream-gap',
          earliestEventId: 1,
          latestEventId: 12,
          events: [
            { method: 'item/completed', eventId: 11, params: { threadId: 'thr_gap' } },
            { method: 'turn/completed', eventId: 12, params: { threadId: 'thr_gap' } },
          ],
          hasMore: false,
        },
      })
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(readDeliveredEventIds(listener)).toEqual([11, 12]);
  });

  it('emits a snapshot boundary when replay history is truncated', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onEvent(listener);
    client.connect();

    const firstSocket = latestMockSocket();
    firstSocket.simulateOpen();
    simulateConnectionIdentity(firstSocket, 'stream-truncated');
    firstSocket.simulateMessage(
      JSON.stringify({ method: 'turn/started', eventId: 10, params: { threadId: 'thr_1' } })
    );
    listener.mockClear();

    client.disconnect();
    client.connect();
    const secondSocket = latestMockSocket();
    secondSocket.simulateOpen();
    simulateConnectionIdentity(secondSocket, 'stream-truncated');
    await Promise.resolve();
    const replayRequest = readLatestReplayRequest(secondSocket);

    secondSocket.simulateMessage(
      JSON.stringify({ method: 'turn/started', eventId: 26, params: { threadId: 'thr_1' } })
    );

    secondSocket.simulateMessage(
      JSON.stringify({
        id: replayRequest?.id,
        result: {
          protocolVersion: 1,
          streamId: 'stream-truncated',
          earliestEventId: 20,
          latestEventId: 25,
          events: [],
          hasMore: false,
        },
      })
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'bridge/events/snapshotRequired',
        params: expect.objectContaining({
          reason: 'replayTruncated',
          lastDeliveredEventId: 10,
          resumeAfterEventId: 25,
          earliestEventId: 20,
          latestEventId: 25,
        }),
      })
    );

    expect(readDeliveredEventIds(listener)).toEqual([26]);
  });

  it('ignores a stale replay response after the stream changes', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onEvent(listener);
    client.connect();

    const firstSocket = latestMockSocket();
    firstSocket.simulateOpen();
    simulateConnectionIdentity(firstSocket, 'stream-old');
    firstSocket.simulateMessage(
      JSON.stringify({ method: 'turn/started', eventId: 10, params: { threadId: 'thr_old' } })
    );

    client.disconnect();
    client.connect();
    const secondSocket = latestMockSocket();
    secondSocket.simulateOpen();
    simulateConnectionIdentity(secondSocket, 'stream-old');
    await Promise.resolve();
    const replayRequest = readLatestReplayRequest(secondSocket);
    expect(replayRequest).toBeDefined();

    simulateConnectionIdentity(secondSocket, 'stream-new');
    secondSocket.simulateMessage(
      JSON.stringify({
        id: replayRequest?.id,
        result: {
          protocolVersion: 1,
          streamId: 'stream-old',
          earliestEventId: 1,
          latestEventId: 11,
          events: [
            { method: 'turn/completed', eventId: 11, params: { threadId: 'thr_old' } },
          ],
          hasMore: false,
        },
      })
    );
    await Promise.resolve();
    await Promise.resolve();

    secondSocket.simulateMessage(
      JSON.stringify({
        method: 'turn/started',
        protocolVersion: 1,
        streamId: 'stream-new',
        eventId: 4,
        params: { threadId: 'thr_new' },
      })
    );

    expect(readDeliveredEventIds(listener)).toEqual([10, 4]);
    expect(
      listener.mock.calls.some(
        (call) =>
          (call[0] as { eventId?: number; params?: { threadId?: string } }).eventId === 11
      )
    ).toBe(false);
  });

  it('accepts a non-one counter reset after the bridge stream changes', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onEvent(listener);
    client.connect();

    const firstSocket = latestMockSocket();
    firstSocket.simulateOpen();
    simulateConnectionIdentity(firstSocket, 'stream-a');
    firstSocket.simulateMessage(
      JSON.stringify({
        method: 'turn/started',
        eventId: 10,
        params: {
          threadId: 'thr_reset',
          turnId: 'turn_a',
        },
      })
    );

    client.disconnect();
    client.connect();
    const secondSocket = latestMockSocket();
    secondSocket.simulateOpen();
    simulateConnectionIdentity(secondSocket, 'stream-b');
    await Promise.resolve();

    const replayRequest = secondSocket.send.mock.calls
      .map((call) =>
        JSON.parse(String(call[0])) as {
          id: string;
          method: string;
        }
      )
      .find((payload) => payload.method === 'bridge/events/replay');
    expect(replayRequest).toBeUndefined();

    secondSocket.simulateMessage(
      JSON.stringify({
        method: 'turn/completed',
        protocolVersion: 1,
        streamId: 'stream-b',
        eventId: 5,
        params: {
          threadId: 'thr_reset',
          turn: {
            id: 'turn_a',
            status: 'completed',
          },
        },
      })
    );

    expect(listener).toHaveBeenLastCalledWith({
      method: 'turn/completed',
      protocolVersion: 1,
      streamId: 'stream-b',
      eventId: 5,
      params: {
        threadId: 'thr_reset',
        turn: {
          id: 'turn_a',
          status: 'completed',
        },
      },
    });
  });

  it('fails closed when the bridge protocol version is unsupported', () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();

    const socket = latestMockSocket();
    socket.simulateOpen();
    simulateConnectionIdentity(socket, 'stream-future', 2);

    expect(client.bridgeProtocolError).toBeInstanceOf(BridgeProtocolVersionError);
    expect(client.bridgeProtocolError?.receivedVersion).toBe(2);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it('supports secure URLs and query-token encoding on web', () => {
    const originalOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    try {
      const client = new HostBridgeWsClient('https://bridge.example/rpc-base/', {
        authToken: 'a b&c',
        allowQueryTokenAuth: true,
      });
      client.connect();
      expect(global.WebSocket).toHaveBeenCalledWith(
        'wss://bridge.example/rpc-base/rpc?token=a%20b%26c'
      );
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOs });
    }
  });

  it('ignores duplicate connect calls and connect after a protocol failure', () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();
    client.connect();
    expect(mockInstances).toHaveLength(1);
    latestMockSocket().simulateOpen();
    simulateConnectionIdentity(latestMockSocket(), 'future', 99);
    client.connect();
    expect(mockInstances).toHaveLength(1);
  });

  it('disconnects cleanly before any socket exists and removes listeners', () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const status = jest.fn();
    const event = jest.fn();
    const removeStatus = client.onStatus(status);
    const removeEvent = client.onEvent(event);
    removeStatus();
    removeEvent();
    client.disconnect();
    expect(status).not.toHaveBeenCalled();
  });

  it('rejects requests when disconnected and times out unanswered requests', async () => {
    const disconnected = new HostBridgeWsClient('http://localhost:8787');
    await expect(disconnected.request('no/connect')).rejects.toThrow('Unable to connect');

    jest.useFakeTimers();
    try {
      const client = new HostBridgeWsClient('http://localhost:8787', { requestTimeoutMs: 25 });
      client.connect();
      latestMockSocket().simulateOpen();
      const request = client.request('slow', { value: 1 });
      const expectation = expect(request).rejects.toThrow('RPC timeout for method: slow');
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(25);
      await expectation;
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a request when socket.send throws', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();
    const socket = latestMockSocket();
    socket.simulateOpen();
    socket.send.mockImplementationOnce(() => { throw new Error('send failed'); });
    await expect(client.request('broken/send')).rejects.toThrow('send failed');
  });

  it('rejects pending requests when an open socket closes or errors', async () => {
    for (const event of ['close', 'error'] as const) {
      const client = new HostBridgeWsClient('http://localhost:8787');
      client.connect();
      const socket = latestMockSocket();
      socket.simulateOpen();
      const request = client.request(`pending/${event}`);
      await Promise.resolve();
      if (event === 'close') socket.simulateClose();
      else socket.simulateError();
      await expect(request).rejects.toThrow(`Bridge websocket ${event === 'close' ? 'closed' : 'error'}`);
      client.disconnect();
    }
  });

  it('ignores malformed messages, unknown response ids, and nameless records', () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onEvent(listener);
    client.connect();
    const socket = latestMockSocket();
    socket.simulateOpen();
    for (const payload of ['not json', 'null', '1', JSON.stringify({ id: 'missing' }), JSON.stringify({ method: 2 })]) {
      socket.simulateMessage(payload);
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it('resolves missing JSON-RPC results as null', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();
    const socket = latestMockSocket();
    socket.simulateOpen();
    const request = client.request('empty/result');
    await Promise.resolve();
    const id = JSON.parse(String(socket.send.mock.calls[0][0])).id;
    socket.simulateMessage(JSON.stringify({ id }));
    await expect(request).resolves.toBeNull();
  });

  it.each([
    ['failed', 'model failed'],
    ['interrupted', 'turn interrupted'],
    ['error', 'turn error'],
    ['aborted', 'turn aborted'],
    ['cancelled', 'turn cancelled'],
    ['canceled', 'turn canceled'],
  ])('rejects cached %s turn completions', async (status, expectedMessage) => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();
    const socket = latestMockSocket();
    socket.simulateOpen();
    socket.simulateMessage(JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'thr_failed', turn: { id: `turn-${status}`, status, error: status === 'failed' ? { message: 'model failed' } : null } },
    }));
    await expect(client.waitForTurnCompletion('thr_failed', `turn-${status}`, 100)).rejects.toThrow(expectedMessage);
  });

  it('ignores unrelated completion events before resolving a matching completion', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();
    const socket = latestMockSocket();
    socket.simulateOpen();
    const wait = client.waitForTurnCompletion('thr_target', 'turn_target', 100);
    socket.simulateMessage(JSON.stringify({ method: 'item/completed', params: {} }));
    socket.simulateMessage(JSON.stringify({ method: 'turn/completed', params: { threadId: 'other', turn: { id: 'turn_target', status: 'completed' } } }));
    socket.simulateMessage(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr_target', turn: { id: 'other', status: 'completed' } } }));
    socket.simulateMessage(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr_target', turn: { id: 'turn_target', status: 'completed' } } }));
    await expect(wait).resolves.toBeUndefined();
  });

  it('rejects a live failed completion and ignores malformed completion params', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();
    const socket = latestMockSocket();
    socket.simulateOpen();
    const wait = client.waitForTurnCompletion('thr_live_failure', 'turn_live_failure', 100);
    socket.simulateMessage(JSON.stringify({ method: 'turn/completed', params: null }));
    socket.simulateMessage(JSON.stringify({ method: 'turn/completed', params: { turnId: 'turn_live_failure' } }));
    socket.simulateMessage(JSON.stringify({
      method: 'turn/completed',
      params: {
        thread: { id: 'thr_live_failure' },
        turnId: 'turn_live_failure',
        status: 'failed',
        error: { message: 'live failure' },
      },
    }));
    await expect(wait).rejects.toThrow('live failure');
  });

  it.each([
    [{ msg: { conversationId: 'thread-msg' }, turnId: 'turn' }, 'thread-msg'],
    [{ threadState: { thread_id: 'thread-state' }, turnId: 'turn' }, 'thread-state'],
    [{ source: { parentThreadId: 'thread-parent' }, turnId: 'turn' }, 'thread-parent'],
    [{ source: { subAgent: { thread_spawn: { parentThreadId: 'thread-spawn' } } }, turnId: 'turn' }, 'thread-spawn'],
    [{ thread: { source: { parent_thread_id: 'thread-source' } }, turnId: 'turn' }, 'thread-source'],
  ])('extracts completion thread id from payload aliases %#', async (params, threadId) => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();
    const socket = latestMockSocket();
    socket.simulateOpen();
    socket.simulateMessage(JSON.stringify({ method: 'turn/completed', params }));
    await expect(client.waitForTurnCompletion(threadId, 'turn', 100)).resolves.toBeUndefined();
  });

  it('does not number invalid event ids and ignores empty notification methods', () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onEvent(listener);
    client.connect();
    const socket = latestMockSocket();
    socket.simulateOpen();
    socket.simulateMessage(JSON.stringify({ method: '', eventId: 1, params: {} }));
    socket.simulateMessage(JSON.stringify({ method: 'zero', eventId: 0, params: {} }));
    socket.simulateMessage(JSON.stringify({ method: 'bad', eventId: 'bad', params: {} }));
    expect(listener).toHaveBeenCalledWith({ method: 'zero', params: {} });
    expect(listener).toHaveBeenCalledWith({ method: 'bad', params: {} });
  });

  it('accepts numeric string event metadata and resets legacy event-id epochs', () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onEvent(listener);
    client.connect();
    const socket = latestMockSocket();
    socket.simulateOpen();
    socket.simulateMessage(JSON.stringify({ method: 'event/one', event_id: '9.8', params: null }));
    socket.simulateMessage(JSON.stringify({ method: 'event/reset', eventId: 1, params: {} }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ method: 'bridge/events/snapshotRequired' }));
    expect(readDeliveredEventIds(listener)).toContain(1);
  });

  it('disables replay when the bridge does not support it', async () => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    client.connect();
    const socket = latestMockSocket();
    socket.simulateOpen();
    simulateConnectionIdentity(socket, 'no-replay');
    socket.simulateMessage(JSON.stringify({ method: 'event', eventId: 4, params: {} }));
    socket.simulateMessage(JSON.stringify({ method: 'event', eventId: 6, params: {} }));
    await Promise.resolve();
    const replay = readLatestReplayRequest(socket);
    socket.simulateMessage(JSON.stringify({ id: replay?.id, error: { code: -32601, message: 'not found' } }));
    await Promise.resolve();
    await Promise.resolve();
    socket.simulateMessage(JSON.stringify({ method: 'event', eventId: 8, params: {} }));
    await Promise.resolve();
    expect(socket.send.mock.calls.filter((call) => JSON.parse(String(call[0])).method === 'bridge/events/replay')).toHaveLength(1);
  });

  it.each([
    ['latest behind cursor', { earliestEventId: 1, latestEventId: 5, events: [] }, 'replayInconsistent'],
    ['missing earliest', { latestEventId: 12, events: [] }, 'replayTruncated'],
    ['stalled final page', { earliestEventId: 1, latestEventId: 12, events: [], hasMore: false }, 'replayInconsistent'],
    ['stalled next page', { earliestEventId: 1, latestEventId: 12, events: [], hasMore: true }, 'replayInconsistent'],
  ])('emits a snapshot for %s replay responses', async (_label, result, reason) => {
    const client = new HostBridgeWsClient('http://localhost:8787');
    const listener = jest.fn();
    client.onEvent(listener);
    client.connect();
    const socket = latestMockSocket();
    socket.simulateOpen();
    simulateConnectionIdentity(socket, `stream-${reason}`);
    socket.simulateMessage(JSON.stringify({ method: 'event', eventId: 10, params: {} }));
    socket.simulateMessage(JSON.stringify({ method: 'event', eventId: 13, params: {} }));
    await Promise.resolve();
    const replay = readLatestReplayRequest(socket);
    socket.simulateMessage(JSON.stringify({ id: replay?.id, result: { protocolVersion: 1, streamId: `stream-${reason}`, ...result } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      method: 'bridge/events/snapshotRequired',
      params: expect.objectContaining({ reason }),
    }));
  });
});

function simulateConnectionIdentity(
  socket: MockWebSocket,
  streamId: string,
  protocolVersion = 1
): void {
  socket.simulateMessage(
    JSON.stringify({
      method: 'bridge/connection/state',
      protocolVersion,
      streamId,
      params: {
        status: 'connected',
        at: '2026-07-17T00:00:00.000Z',
      },
    })
  );
}

function readLatestReplayRequest(socket: MockWebSocket): {
  id: string;
  params?: { afterEventId?: number };
} | undefined {
  return socket.send.mock.calls
    .map((call) => JSON.parse(String(call[0])) as {
      id: string;
      method: string;
      params?: { afterEventId?: number };
    })
    .filter((payload) => payload.method === 'bridge/events/replay')
    .at(-1);
}

function readDeliveredEventIds(listener: jest.Mock): number[] {
  return listener.mock.calls
    .map((call) => (call[0] as { eventId?: number }).eventId)
    .filter((id): id is number => typeof id === 'number');
}
