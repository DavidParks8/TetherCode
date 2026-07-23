import { HostBridgeWsClientReplayAndOrderingLayer } from "./HostBridgeWsClientReplayAndOrderingLayer";
import { HostBridgeWsClientCore } from "./HostBridgeWsClientCore";
import { Platform } from "react-native";
import { isFailedTurnStatus, turnCompletionKey } from "./wsEventParsingInternals";
import { type RpcNotification } from "./types";
import { type TurnCompletionSnapshot } from "./wsTypes";

export abstract class HostBridgeWsClientCompletionAndDispatchLayer extends HostBridgeWsClientReplayAndOrderingLayer {
  protected getTurnCompletion(
    threadId: string,
    turnId: string,
  ): TurnCompletionSnapshot | null {
    this.pruneTurnCompletions();
    return (
      this.recentTurnCompletions.get(turnCompletionKey(threadId, turnId)) ??
      null
    );
  }
  protected rememberTurnCompletion(snapshot: TurnCompletionSnapshot): void {
    if (!snapshot.turnId) {
      return;
    }
    this.pruneTurnCompletions();
    this.recentTurnCompletions.set(
      turnCompletionKey(snapshot.threadId, snapshot.turnId),
      snapshot,
    );
  }
  protected pruneTurnCompletions(): void {
    const now = Date.now();
    for (const [key, snapshot] of this.recentTurnCompletions.entries()) {
      if (
        now - snapshot.completedAt >
        HostBridgeWsClientCore.TURN_COMPLETION_TTL_MS
      ) {
        this.recentTurnCompletions.delete(key);
      }
    }
  }
  protected assertTurnSucceeded(snapshot: TurnCompletionSnapshot): void {
    if (isFailedTurnStatus(snapshot.status)) {
      throw new Error(
        snapshot.errorMessage ?? `turn ${snapshot.status ?? "failed"}`,
      );
    }
  }
  protected emitEvent(event: RpcNotification): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
  protected emitStatus(connected: boolean): void {
    this.connected = connected;
    for (const listener of this.statusListeners) {
      listener(connected);
    }
  }
  protected socketUrl(): string {
    const wsBase = this.baseUrl.startsWith("https://")
      ? this.baseUrl.replace("https://", "wss://")
      : this.baseUrl.replace("http://", "ws://");
    const base = `${wsBase}/rpc`;
    if (!this.authToken || !this.shouldUseQueryTokenAuth()) {
      return base;
    }
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}token=${encodeURIComponent(this.authToken)}`;
  }
  protected shouldUseQueryTokenAuth(): boolean {
    return (
      Boolean(this.authToken) &&
      this.allowQueryTokenAuth &&
      (Platform.OS === "android" || Platform.OS === "web")
    );
  }
}
