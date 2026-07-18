import { Platform } from 'react-native';

import type {
  BridgeSnapshotRequiredParams,
  BridgeSnapshotRequiredReason,
  RpcNotification,
} from './types';

type EventListener = (event: RpcNotification) => void;
type StatusListener = (connected: boolean) => void;

interface HostBridgeWsClientOptions {
  authToken?: string | null;
  allowQueryTokenAuth?: boolean;
  requestTimeoutMs?: number;
}

interface ReactNativeWebSocketConstructor {
  new (
    url: string,
    protocols?: string | string[],
    options?: {
      headers?: Record<string, string>;
    }
  ): WebSocket;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface TurnCompletionSnapshot {
  threadId: string;
  turnId: string | null;
  status: string | null;
  errorMessage: string | null;
  completedAt: number;
}

export class RpcRequestError extends Error {
  readonly name = 'RpcRequestError';

  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isRpcRequestError(error: unknown): error is RpcRequestError {
  return error instanceof RpcRequestError;
}

export class BridgeProtocolVersionError extends Error {
  readonly name = 'BridgeProtocolVersionError';

  constructor(readonly receivedVersion: number) {
    super(
      `Unsupported bridge protocol version ${String(receivedVersion)}; expected ${String(HostBridgeWsClient.PROTOCOL_VERSION)}`
    );
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface ReplayEventsResponse {
  protocolVersion?: number;
  streamId?: string;
  events?: unknown[];
  hasMore?: boolean;
  earliestEventId?: number;
  latestEventId?: number;
  truncatedByBytes?: boolean;
  returnedBytes?: number;
  maxBytes?: number;
}

export class HostBridgeWsClient {
  static readonly PROTOCOL_VERSION = 1;
  private static readonly TURN_COMPLETION_TTL_MS = 5 * 60 * 1000;
  private socket: WebSocket | null = null;
  private pendingSocket: WebSocket | null = null;
  private connected = false;
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  private connectGeneration = 0;

  private readonly eventListeners = new Set<EventListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly pendingRequests = new Map<string | number, PendingRequest>();
  private readonly recentTurnCompletions = new Map<string, TurnCompletionSnapshot>();
  private readonly pendingEvents = new Map<number, RpcNotification>();
  private readonly authToken: string | null;
  private readonly allowQueryTokenAuth: boolean;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private lastSeenEventId = 0;
  private replaySupported = true;
  private replayInFlight: Promise<void> | null = null;
  private replayGeneration = 0;
  private requestCounter = 0;
  private streamId: string | null = null;
  private protocolError: BridgeProtocolVersionError | null = null;

  constructor(baseUrl: string, options: HostBridgeWsClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.authToken = options.authToken?.trim() || null;
    this.allowQueryTokenAuth = options.allowQueryTokenAuth ?? false;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 180_000;
  }

  public get isConnected(): boolean {
    return this.connected;
  }

  public get bridgeProtocolError(): BridgeProtocolVersionError | null {
    return this.protocolError;
  }

  connect(): void {
    if (this.protocolError) {
      return;
    }
    this.shouldReconnect = true;
    this.startConnect();
  }

  private startConnect(): void {
    if (
      !this.shouldReconnect ||
      this.socket ||
      this.pendingSocket ||
      this.connectPromise ||
      this.reconnectTimer
    ) {
      return;
    }

    const generation = ++this.connectGeneration;
    const promise = this.openSocket(generation).finally(() => {
      if (this.connectPromise !== promise) {
        return;
      }
      this.connectPromise = null;
      if (
        this.shouldReconnect &&
        generation === this.connectGeneration &&
        !this.socket &&
        !this.pendingSocket
      ) {
        this.scheduleReconnect();
      }
    });
    this.connectPromise = promise;
    void promise.catch(() => {
      // Connection errors are surfaced through status listeners and retries.
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.connectGeneration += 1;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.replayGeneration += 1;
    this.replayInFlight = null;

    const pendingSocket = this.pendingSocket;
    this.pendingSocket = null;
    const socket = this.socket;
    this.socket = null;
    this.connectPromise = null;

    if (!socket && !pendingSocket) {
      this.emitStatus(false);
      return;
    }

    if (pendingSocket && pendingSocket !== socket) {
      pendingSocket.close();
    }
    socket?.close();
    this.emitStatus(false);
    this.rejectAllPending(new Error('Bridge websocket disconnected'));
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureConnected();

    const id = `${Date.now()}-${++this.requestCounter}`;
    const payload: Record<string, unknown> = {
      id,
      method,
    };

    if (params !== undefined) {
      payload.params = params;
    }

    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      throw new Error('Bridge websocket is not connected');
    }

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout for method: ${method}`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });

      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async waitForTurnCompletion(
    threadId: string,
    turnId: string,
    timeoutMs = this.requestTimeoutMs
  ): Promise<void> {
    const cachedCompletion = this.getTurnCompletion(threadId, turnId);
    if (cachedCompletion) {
      this.assertTurnSucceeded(cachedCompletion);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const finish = (result: { ok: true } | { ok: false; error: Error }) => {
        clearTimeout(timeout);
        unsubscribe();
        if (result.ok) {
          resolve();
          return;
        }
        reject(result.error);
      };

      const timeout = setTimeout(() => {
        finish({ ok: false, error: new Error(`turn timed out after ${String(timeoutMs)}ms`) });
      }, timeoutMs);

      const unsubscribe = this.onEvent((event) => {
          if (event.method !== 'turn/completed') {
            return;
          }

          let normalizedCompletion: TurnCompletionSnapshot | null = null;
          const completion = toTurnCompletionSnapshot(event.params);
          if (completion) {
            if (completion.threadId !== threadId) {
              return;
            }

            if (completion.turnId !== turnId) {
              return;
            }
            normalizedCompletion = completion;
          }

          if (!normalizedCompletion) {
            return;
          }

          this.rememberTurnCompletion(normalizedCompletion);
          if (isFailedTurnStatus(normalizedCompletion.status)) {
            finish({
              ok: false,
              error: new Error(
                normalizedCompletion.errorMessage ??
                  `turn ${normalizedCompletion.status ?? 'failed'}`
              ),
            });
            return;
          }

          finish({ ok: true });
      });
    });
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);

    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);

    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected && this.socket?.readyState === 1) {
      return;
    }

    if (this.connectPromise) {
      await this.connectPromise;
    }

    if (!this.connected || this.socket?.readyState !== 1) {
      throw new Error('Unable to connect to bridge websocket');
    }
  }

  private async openSocket(generation: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const WebSocketCtor = globalThis.WebSocket as unknown as ReactNativeWebSocketConstructor;
        const socketUrl = this.socketUrl();
        const shouldUseQueryTokenAuth = this.shouldUseQueryTokenAuth();
        const shouldUseHeaderAuth =
          Boolean(this.authToken) &&
          Platform.OS !== 'web' &&
          !shouldUseQueryTokenAuth;
        const socket =
          shouldUseHeaderAuth
            ? new WebSocketCtor(socketUrl, undefined, {
                headers: {
                  Authorization: `Bearer ${this.authToken}`,
                },
              })
            : new WebSocketCtor(socketUrl);
        this.pendingSocket = socket;

        let settled = false;

        socket.onopen = () => {
          if (
            generation !== this.connectGeneration ||
            !this.shouldReconnect ||
            this.pendingSocket !== socket
          ) {
            socket.close();
            if (!settled) {
              settled = true;
              reject(new Error('Bridge websocket open ignored after disconnect'));
            }
            return;
          }

          settled = true;
          this.pendingSocket = null;
          this.socket = socket;
          this.reconnectAttempts = 0;
          this.emitStatus(true);
          resolve();
        };

        socket.onclose = () => {
          if (this.pendingSocket === socket) {
            this.pendingSocket = null;
          }

          if (this.socket === socket) {
            this.socket = null;
            this.emitStatus(false);
            this.rejectAllPending(new Error('Bridge websocket closed'));
          }

          if (!settled) {
            settled = true;
            reject(new Error('Bridge websocket closed before open'));
            return;
          }

          if (this.shouldReconnect && generation === this.connectGeneration) {
            this.scheduleReconnect();
          }
        };

        socket.onerror = () => {
          if (!settled) {
            settled = true;
            if (this.pendingSocket === socket) {
              this.pendingSocket = null;
            }
            socket.close();
            reject(new Error('Bridge websocket error'));
            return;
          }

          if (this.socket === socket) {
            this.socket = null;
            socket.close();
            this.emitStatus(false);
            this.rejectAllPending(new Error('Bridge websocket error'));
            if (this.shouldReconnect && generation === this.connectGeneration) {
              this.scheduleReconnect();
            }
          }
        };

        socket.onmessage = (message) => {
          if (generation !== this.connectGeneration || this.socket !== socket) {
            return;
          }
          this.handleIncoming(String(message.data));
        };
      });
  }

  private scheduleReconnect(): void {
    if (
      !this.shouldReconnect ||
      this.socket ||
      this.pendingSocket ||
      this.connectPromise ||
      this.reconnectTimer
    ) {
      return;
    }

    const attempt = this.reconnectAttempts;
    this.reconnectAttempts += 1;

    const jitter = Math.floor(Math.random() * 250);
    const delay = Math.min(5000, 500 * 2 ** attempt) + jitter;

    const generation = this.connectGeneration;
    const timer = setTimeout(() => {
      if (this.reconnectTimer !== timer) {
        return;
      }
      this.reconnectTimer = null;
      if (!this.shouldReconnect || generation !== this.connectGeneration) {
        return;
      }
      this.startConnect();
    }, delay);
    this.reconnectTimer = timer;
  }

  private handleIncoming(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const record = toRecord(parsed);
    if (!record) {
      return;
    }

    const hasMethod = typeof record.method === 'string';
    const hasId = typeof record.id === 'string' || typeof record.id === 'number';

    if (hasId) {
      const pending = this.pendingRequests.get(record.id as string | number);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      this.pendingRequests.delete(record.id as string | number);

      const error = toRecord(record.error);
      if (
        error &&
        typeof error.code === 'number' &&
        typeof error.message === 'string'
      ) {
        pending.reject(
          new RpcRequestError(pending.method, error.code, error.message, error.data)
        );
        return;
      }

      pending.resolve(record.result ?? null);
      return;
    }

    if (hasMethod) {
      this.handleNotificationRecord(record);
    }
  }

  private handleNotificationRecord(
    record: Record<string, unknown>,
    options?: {
      source?: 'live' | 'replay';
    }
  ): void {
    const method = readString(record.method);
    if (!method) {
      return;
    }

    const params = toRecord(record.params);
    const protocolVersion = readNumber(record.protocolVersion);
    const streamId = readString(record.streamId);
    const identityResult = this.applyStreamIdentity(protocolVersion, streamId);
    if (identityResult === 'unsupported') {
      return;
    }
    const eventId = readEventId(record);

    const event: RpcNotification = {
      method,
      params,
    };
    if (protocolVersion !== null) {
      event.protocolVersion = protocolVersion;
    }
    if (streamId) {
      event.streamId = streamId;
    }
    if (eventId !== null) {
      event.eventId = eventId;
    }

    if (eventId === null) {
      if (event.method === 'turn/completed') {
        const completion = toTurnCompletionSnapshot(event.params);
        if (completion?.turnId) {
          this.rememberTurnCompletion(completion);
        }
      }
      this.emitEvent(event);
    } else {
      if (protocolVersion === null && eventId === 1 && this.lastSeenEventId > 1) {
        this.resetDeliveryEpoch('streamChanged', null, null);
      }
      if (eventId <= this.lastSeenEventId || this.pendingEvents.has(eventId)) {
        return;
      }

      if (this.lastSeenEventId === 0) {
        this.emitNumberedEvent(event);
      } else {
        this.pendingEvents.set(eventId, event);
        if (options?.source === 'replay') {
          this.drainPendingEvents();
        } else if (!this.replayInFlight) {
          this.drainPendingEvents();
          if (this.hasPendingGap()) {
            this.scheduleReplay();
          }
        }
      }
    }

    if (
      method === 'bridge/connection/state' &&
      (identityResult === 'same' || identityResult === 'missing') &&
      this.lastSeenEventId > 0
    ) {
      this.scheduleReplay();
    }
  }

  private scheduleReplay(): void {
    if (!this.replaySupported) {
      return;
    }
    if (this.replayInFlight) {
      return;
    }
    if (!this.connected || !this.socket || this.socket.readyState !== 1) {
      return;
    }

    const generation = this.replayGeneration;
    let replayCompleted = false;
    const replayPromise = this.replayMissedEvents(generation)
      .then(() => {
        replayCompleted = true;
      })
      .catch(() => {
        // Keep buffered events for retry on the next live event or reconnect.
      })
      .finally(() => {
        if (this.replayInFlight !== replayPromise) {
          return;
        }
        this.replayInFlight = null;
        if (!replayCompleted || generation !== this.replayGeneration) {
          return;
        }
        this.drainPendingEvents();
        if (this.hasPendingGap()) {
          this.scheduleReplay();
        }
      });
    this.replayInFlight = replayPromise;
  }

  private async replayMissedEvents(generation: number): Promise<void> {
    if (!this.replaySupported || this.lastSeenEventId <= 0) {
      return;
    }

    let cursor = this.lastSeenEventId;
    let targetEventId: number | null = null;
    while (generation === this.replayGeneration) {
      let response: ReplayEventsResponse;
      try {
        response = await this.request<ReplayEventsResponse>('bridge/events/replay', {
          afterEventId: cursor,
          limit: 200,
        });
      } catch (error) {
        if (isRpcRequestError(error) && error.code === -32601) {
          this.replaySupported = false;
          return;
        }
        throw error;
      }

      if (generation !== this.replayGeneration) {
        return;
      }

      const identityResult = this.applyStreamIdentity(
        readNumber(response.protocolVersion),
        readString(response.streamId)
      );
      if (identityResult === 'unsupported' || identityResult === 'changed') {
        return;
      }

      const latestEventId = readNumber(response.latestEventId);
      const earliestEventId = readNumber(response.earliestEventId);
      if (latestEventId !== null && latestEventId < cursor) {
        this.resetDeliveryEpoch('replayInconsistent', earliestEventId, latestEventId);
        return;
      }
      if (earliestEventId !== null && earliestEventId > cursor + 1) {
        this.resetDeliveryEpoch('replayTruncated', earliestEventId, latestEventId);
        return;
      }
      if (earliestEventId === null && latestEventId !== null && latestEventId > cursor) {
        this.resetDeliveryEpoch('replayTruncated', earliestEventId, latestEventId);
        return;
      }
      if (targetEventId === null) {
        targetEventId = latestEventId;
      }

      const events = Array.isArray(response.events) ? response.events : [];
      for (const entry of events) {
        const record = toRecord(entry);
        if (!record) {
          continue;
        }
        this.handleNotificationRecord(record, { source: 'replay' });
      }

      const previousCursor = cursor;
      cursor = this.lastSeenEventId;
      const pageEventIds = events
        .map((entry) => toRecord(entry))
        .map((entry) => (entry ? readEventId(entry) : null))
        .filter((eventId): eventId is number => eventId !== null);
      if (targetEventId === null && pageEventIds.length > 0) {
        targetEventId = Math.max(...pageEventIds);
      }
      if (targetEventId === null || cursor >= targetEventId) {
        return;
      }

      const hasMore = response.hasMore === true;
      if (!hasMore) {
        this.resetDeliveryEpoch('replayInconsistent', earliestEventId, latestEventId);
        return;
      }
      if (cursor <= previousCursor) {
        this.resetDeliveryEpoch('replayInconsistent', earliestEventId, latestEventId);
        return;
      }
    }
  }

  private drainPendingEvents(): void {
    let nextEventId = this.lastSeenEventId + 1;
    while (this.pendingEvents.has(nextEventId)) {
      const event = this.pendingEvents.get(nextEventId);
      this.pendingEvents.delete(nextEventId);
      if (event) {
        this.emitNumberedEvent(event);
      }
      nextEventId = this.lastSeenEventId + 1;
    }
  }

  private hasPendingGap(): boolean {
    if (this.pendingEvents.size === 0) {
      return false;
    }
    return !this.pendingEvents.has(this.lastSeenEventId + 1);
  }

  private emitNumberedEvent(event: RpcNotification): void {
    if (typeof event.eventId !== 'number') {
      return;
    }
    this.lastSeenEventId = event.eventId;
    if (event.method === 'turn/completed') {
      const completion = toTurnCompletionSnapshot(event.params);
      if (completion?.turnId) {
        this.rememberTurnCompletion(completion);
      }
    }
    this.emitEvent(event);
  }

  private resetDeliveryEpoch(
    reason: BridgeSnapshotRequiredReason,
    earliestEventId: number | null,
    latestEventId: number | null,
    previousStreamId: string | null = this.streamId
  ): void {
    const lastDeliveredEventId = this.lastSeenEventId;
    const resumeAfterEventId = latestEventId ?? 0;
    this.replayGeneration += 1;
    if (reason === 'streamChanged') {
      this.pendingEvents.clear();
    } else {
      for (const eventId of this.pendingEvents.keys()) {
        if (eventId <= resumeAfterEventId) {
          this.pendingEvents.delete(eventId);
        }
      }
    }
    this.lastSeenEventId = resumeAfterEventId;
    this.replayInFlight = null;
    const params: BridgeSnapshotRequiredParams = {
      reason,
      previousStreamId,
      lastDeliveredEventId,
      resumeAfterEventId,
      earliestEventId,
      latestEventId,
    };
    this.emitEvent({
      method: 'bridge/events/snapshotRequired',
      protocolVersion: HostBridgeWsClient.PROTOCOL_VERSION,
      streamId: this.streamId ?? undefined,
      params: params as unknown as Record<string, unknown>,
    });
    this.drainPendingEvents();
  }

  private applyStreamIdentity(
    protocolVersion: number | null,
    streamId: string | null
  ): 'missing' | 'initial' | 'same' | 'changed' | 'unsupported' {
    if (protocolVersion === null || !streamId) {
      return 'missing';
    }
    if (protocolVersion !== HostBridgeWsClient.PROTOCOL_VERSION) {
      const error = new BridgeProtocolVersionError(protocolVersion);
      this.protocolError = error;
      this.shouldReconnect = false;
      this.connectGeneration += 1;
      this.rejectAllPending(error);
      this.socket?.close();
      return 'unsupported';
    }

    this.protocolError = null;
    if (this.streamId === null) {
      this.streamId = streamId;
      return 'initial';
    }
    if (this.streamId === streamId) {
      return 'same';
    }

    const previousStreamId = this.streamId;
    this.streamId = streamId;
    this.resetDeliveryEpoch('streamChanged', null, null, previousStreamId);
    return 'changed';
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private getTurnCompletion(threadId: string, turnId: string): TurnCompletionSnapshot | null {
    this.pruneTurnCompletions();
    return this.recentTurnCompletions.get(turnCompletionKey(threadId, turnId)) ?? null;
  }

  private rememberTurnCompletion(snapshot: TurnCompletionSnapshot): void {
    if (!snapshot.turnId) {
      return;
    }

    this.pruneTurnCompletions();
    this.recentTurnCompletions.set(
      turnCompletionKey(snapshot.threadId, snapshot.turnId),
      snapshot
    );
  }

  private pruneTurnCompletions(): void {
    const now = Date.now();
    for (const [key, snapshot] of this.recentTurnCompletions.entries()) {
      if (now - snapshot.completedAt > HostBridgeWsClient.TURN_COMPLETION_TTL_MS) {
        this.recentTurnCompletions.delete(key);
      }
    }
  }

  private assertTurnSucceeded(snapshot: TurnCompletionSnapshot): void {
    if (isFailedTurnStatus(snapshot.status)) {
      throw new Error(snapshot.errorMessage ?? `turn ${snapshot.status ?? 'failed'}`);
    }
  }

  private emitEvent(event: RpcNotification): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private emitStatus(connected: boolean): void {
    this.connected = connected;
    for (const listener of this.statusListeners) {
      listener(connected);
    }
  }

  private socketUrl(): string {
    const wsBase = this.baseUrl.startsWith('https://')
      ? this.baseUrl.replace('https://', 'wss://')
      : this.baseUrl.replace('http://', 'ws://');
    const base = `${wsBase}/rpc`;

    if (!this.authToken || !this.shouldUseQueryTokenAuth()) {
      return base;
    }

    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}token=${encodeURIComponent(this.authToken)}`;
  }

  private shouldUseQueryTokenAuth(): boolean {
    return (
      Boolean(this.authToken) &&
      this.allowQueryTokenAuth &&
      (Platform.OS === 'android' || Platform.OS === 'web')
    );
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return null;
}

function readEventId(record: Record<string, unknown>): number | null {
  const eventId = readNumber(record.eventId) ?? readNumber(record.event_id);
  if (eventId === null || eventId < 1) {
    return null;
  }
  return eventId;
}

function turnCompletionKey(threadId: string, turnId: string): string {
  return `${threadId}::${turnId}`;
}

function toTurnCompletionSnapshot(value: unknown): TurnCompletionSnapshot | null {
  const params = toRecord(value);
  if (!params) {
    return null;
  }

  const turn = toRecord(params.turn);
  const threadId = extractNotificationThreadId(params, turn);
  const turnId =
    readString(turn?.id) ?? readString(params.turnId) ?? readString(params.turn_id);
  if (!threadId) {
    return null;
  }

  const turnError = toRecord(turn?.error) ?? toRecord(params.error);

  return {
    threadId,
    turnId,
    status: readString(turn?.status) ?? readString(params.status),
    errorMessage: readString(turnError?.message),
    completedAt: Date.now(),
  };
}

function extractNotificationThreadId(
  params: Record<string, unknown> | null,
  msgArg?: Record<string, unknown> | null
): string | null {
  if (!params && !msgArg) {
    return null;
  }

  const msg = msgArg ?? toRecord(params?.msg);
  const threadRecord =
    toRecord(params?.thread) ??
    toRecord(params?.threadState) ??
    toRecord(params?.thread_state) ??
    toRecord(msg?.thread);
  const threadSourceRecord = toRecord(threadRecord?.source);
  const sourceRecord = toRecord(params?.source) ?? toRecord(msg?.source);
  const subagentThreadSpawnRecord = toRecord(
    toRecord(sourceRecord?.subagent ?? sourceRecord?.subAgent)?.thread_spawn
  );
  const threadSubagentThreadSpawnRecord = toRecord(
    toRecord(threadSourceRecord?.subagent ?? threadSourceRecord?.subAgent)?.thread_spawn
  );

  return (
    readString(msg?.thread_id) ??
    readString(msg?.threadId) ??
    readString(msg?.conversation_id) ??
    readString(msg?.conversationId) ??
    readString(params?.thread_id) ??
    readString(params?.threadId) ??
    readString(params?.conversation_id) ??
    readString(params?.conversationId) ??
    readString(threadRecord?.id) ??
    readString(threadRecord?.thread_id) ??
    readString(threadRecord?.threadId) ??
    readString(threadRecord?.conversation_id) ??
    readString(threadRecord?.conversationId) ??
    readString(sourceRecord?.thread_id) ??
    readString(sourceRecord?.threadId) ??
    readString(sourceRecord?.conversation_id) ??
    readString(sourceRecord?.conversationId) ??
    readString(sourceRecord?.parent_thread_id) ??
    readString(sourceRecord?.parentThreadId) ??
    readString(subagentThreadSpawnRecord?.parent_thread_id) ??
    readString(subagentThreadSpawnRecord?.parentThreadId) ??
    readString(threadSourceRecord?.parent_thread_id) ??
    readString(threadSourceRecord?.parentThreadId) ??
    readString(threadSubagentThreadSpawnRecord?.parent_thread_id) ??
    readString(threadSubagentThreadSpawnRecord?.parentThreadId) ??
    null
  );
}

function isFailedTurnStatus(status: string | null): boolean {
  return (
    status === 'failed' ||
    status === 'interrupted' ||
    status === 'error' ||
    status === 'aborted' ||
    status === 'cancelled' ||
    status === 'canceled'
  );
}
