import { HostBridgeWsClientCore } from "./HostBridgeWsClientCore";
import type { BridgeProtocolVersionError } from "./wsErrors";
import {
  isFailedTurnStatus,
  toAgUiTurnCompletionSnapshot,
} from "./wsEventParsingInternals";
import {
  type EventListener,
  type StatusListener,
  type TurnCompletionSnapshot,
} from "./wsTypes";

export abstract class HostBridgeWsClientConnectionLayer extends HostBridgeWsClientCore {
  public get isConnected(): boolean {
    return this.connected;
  }
  public get bridgeProtocolError(): BridgeProtocolVersionError | null {
    return this.protocolError;
  }
  acknowledgeSnapshotRecovery(resumeAfterEventId: number): boolean {
    if (this.recoveryWatermark !== resumeAfterEventId) {
      return false;
    }
    this.recoveryWatermark = null;
    this.awaitingFreshRecoveryBaseline = false;
    this.drainPendingEvents();
    if (this.hasPendingGap()) {
      this.scheduleReplay();
    }
    return true;
  }
  connect(): void {
    if (this.protocolError) {
      return;
    }
    this.shouldReconnect = true;
    this.startConnect();
  }
  resetRecoveryEpoch(): void {
    const lastDeliveredEventId = this.lastSeenEventId;
    const previousStreamId = this.streamId;
    const socket = this.socket;
    const pendingSocket = this.pendingSocket;
    this.connectGeneration += 1;
    this.replayGeneration += 1;
    this.replayInFlight = null;
    this.pendingEvents.clear();
    this.recoveryWatermark = 0;
    this.awaitingFreshRecoveryBaseline = true;
    this.lastSeenEventId = 0;
    this.streamId = null;
    this.socket = null;
    this.pendingSocket = null;
    this.connectPromise = null;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (pendingSocket && pendingSocket !== socket) {
      pendingSocket.close();
    }
    socket?.close();
    this.emitStatus(false);
    this.rejectAllPending(new Error("Bridge websocket recovery epoch reset"));
    this.emitEvent({
      method: "bridge/events/snapshotRequired",
      protocolVersion: HostBridgeWsClientCore.PROTOCOL_VERSION,
      params: {
        reason: "recoveryOverflow",
        previousStreamId,
        lastDeliveredEventId,
        resumeAfterEventId: 0,
        earliestEventId: null,
        latestEventId: null,
      },
    });
    if (this.shouldReconnect) {
      this.startConnect();
    }
  }
  protected startConnect(): void {
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
    this.rejectAllPending(new Error("Bridge websocket disconnected"));
  }
  async request<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureConnected();
    const id = `${Date.now()}-${++this.requestCounter}`;
    const payload: Record<string, unknown> = { id, method };
    if (params !== undefined) {
      payload.params = params;
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      throw new Error("Bridge websocket is not connected");
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
    timeoutMs = this.requestTimeoutMs,
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
        finish({
          ok: false,
          error: new Error(`turn timed out after ${String(timeoutMs)}ms`),
        });
      }, timeoutMs);
      const unsubscribe = this.onEvent((event) => {
        let normalizedCompletion: TurnCompletionSnapshot | null = null;
        const completion = toAgUiTurnCompletionSnapshot(event);
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
                `turn ${normalizedCompletion.status ?? "failed"}`,
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
  protected async ensureConnected(): Promise<void> {
    if (this.connected && this.socket?.readyState === 1) {
      return;
    }
    if (this.connectPromise) {
      await this.connectPromise;
    }
    if (!this.connected || this.socket?.readyState !== 1) {
      throw new Error("Unable to connect to bridge websocket");
    }
  }
}
