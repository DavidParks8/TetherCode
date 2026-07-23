import { HostBridgeWsClientConnectionLayer } from "./HostBridgeWsClientConnectionLayer";
import { HostBridgeWsClientCore } from "./HostBridgeWsClientCore";
import { Platform } from "react-native";
import { RpcRequestError } from "./wsErrors";
import {
  readEventId,
  readNumber,
  readString,
  toAgUiTurnCompletionSnapshot,
  toRecord,
} from "./wsEventParsingInternals";
import { type ReactNativeWebSocketConstructor } from "./wsTypes";
import { type RpcNotification } from "./types";

export abstract class HostBridgeWsClientSocketTransportLayer extends HostBridgeWsClientConnectionLayer {
  protected async openSocket(generation: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const WebSocketCtor =
        globalThis.WebSocket as unknown as ReactNativeWebSocketConstructor;
      const socketUrl = this.socketUrl();
      const shouldUseQueryTokenAuth = this.shouldUseQueryTokenAuth();
      const shouldUseHeaderAuth =
        Boolean(this.authToken) &&
        Platform.OS !== "web" &&
        !shouldUseQueryTokenAuth;
      const socket = shouldUseHeaderAuth
        ? new WebSocketCtor(socketUrl, undefined, {
            headers: { Authorization: `Bearer ${this.authToken}` },
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
            reject(new Error("Bridge websocket open ignored after disconnect"));
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
          this.rejectAllPending(new Error("Bridge websocket closed"));
        }
        if (!settled) {
          settled = true;
          reject(new Error("Bridge websocket closed before open"));
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
          reject(new Error("Bridge websocket error"));
          return;
        }
        if (this.socket === socket) {
          this.socket = null;
          socket.close();
          this.emitStatus(false);
          this.rejectAllPending(new Error("Bridge websocket error"));
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
  protected scheduleReconnect(): void {
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
  protected handleIncoming(raw: string): void {
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
    const hasMethod = typeof record.method === "string";
    const hasId =
      typeof record.id === "string" || typeof record.id === "number";
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
        typeof error.code === "number" &&
        typeof error.message === "string"
      ) {
        pending.reject(
          new RpcRequestError(
            pending.method,
            error.code,
            error.message,
            error.data,
          ),
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
  protected handleNotificationRecord(
    record: Record<string, unknown>,
    options?: { source?: "live" | "replay" },
  ): void {
    const method = readString(record.method);
    if (!method) {
      return;
    }
    const params = toRecord(record.params);
    const protocolVersion = readNumber(record.protocolVersion);
    const streamId = readString(record.streamId);
    const identityResult = this.applyStreamIdentity(protocolVersion, streamId);
    if (identityResult === "unsupported") {
      return;
    }
    const eventId = readEventId(record);
    const event: RpcNotification = { method, params };
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
      const completion = toAgUiTurnCompletionSnapshot(event);
      if (completion?.turnId) {
        this.rememberTurnCompletion(completion);
      }
      this.emitEvent(event);
    } else {
      if (
        protocolVersion === null &&
        eventId === 1 &&
        this.lastSeenEventId > 1
      ) {
        this.resetDeliveryEpoch("streamChanged", null, null);
      }
      if (eventId <= this.lastSeenEventId || this.pendingEvents.has(eventId)) {
        return;
      }
      if (this.lastSeenEventId === 0 && !this.awaitingFreshRecoveryBaseline) {
        this.emitNumberedEvent(event);
      } else {
        this.pendingEvents.set(eventId, event);
        if (
          this.recoveryWatermark !== null &&
          this.pendingEvents.size >
            HostBridgeWsClientCore.MAX_RECOVERY_BUFFERED_EVENTS
        ) {
          this.handleRecoveryBufferOverflow();
          return;
        }
        if (options?.source === "replay") {
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
      method === "bridge/connection/state" &&
      (identityResult === "same" || identityResult === "missing") &&
      (this.lastSeenEventId > 0 || this.recoveryWatermark !== null)
    ) {
      this.scheduleReplay();
    }
  }
}
