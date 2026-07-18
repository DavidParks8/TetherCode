import type { HostBridgeApiClient } from './api/client';
import type { ApprovalDecision } from './api/types';
import type { HostBridgeWsClient } from './api/ws';
import type { PushResponseEvent } from './pushNotifications';

export interface PushResponseProfileClient {
  profileId: string;
  registrationId: string;
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
}

interface DeferredAction {
  timer: ReturnType<typeof setTimeout>;
  unsubscribe: () => void;
}

export class PushResponseController {
  private readonly handled = new Set<string>();
  private readonly handledOrder: string[] = [];
  private readonly deferred = new Map<string, DeferredAction>();
  private readonly pending = new Map<string, PushResponseEvent>();
  private profile: PushResponseProfileClient | null = null;

  constructor(
    private readonly onNavigate: (event: PushResponseEvent) => void,
    private readonly maxHandled = 256
  ) {}

  setProfile(profile: PushResponseProfileClient | null): void {
    if (
      this.profile?.profileId === profile?.profileId &&
      this.profile?.registrationId === profile?.registrationId
    ) {
      return;
    }
    this.cancelDeferred();
    this.profile = profile;
    if (profile) {
      const pending = [...this.pending.values()];
      this.pending.clear();
      for (const event of pending) this.handle(event);
    }
  }

  handle(event: PushResponseEvent): boolean {
    if (this.handled.has(event.actionId)) return false;
    const profile = this.profile;
    if (!profile) {
      if (this.pending.size < this.maxHandled) this.pending.set(event.actionId, event);
      return false;
    }
    if (
      event.target.profileId !== profile.profileId ||
      event.target.registrationId !== profile.registrationId
    ) {
      return false;
    }
    this.remember(event.actionId);
    this.onNavigate(event);
    if ((event.action === 'approve' || event.action === 'deny') && event.target.approvalId) {
      this.resolveWhenConnected(
        event.actionId,
        profile,
        event.target.approvalId,
        event.action === 'approve' ? 'accept' : 'decline'
      );
    }
    return true;
  }

  dispose(): void {
    this.cancelDeferred();
    this.pending.clear();
    this.profile = null;
  }

  private resolveWhenConnected(
    actionId: string,
    profile: PushResponseProfileClient,
    approvalId: string,
    decision: ApprovalDecision
  ): void {
    const attempt = () => {
      const deferred = this.deferred.get(actionId);
      if (deferred) {
        clearTimeout(deferred.timer);
        deferred.unsubscribe();
        this.deferred.delete(actionId);
      }
      if (this.profile !== profile) return;
      void this.resolveApproval(profile, actionId, approvalId, decision, 1);
    };
    if (profile.ws.isConnected) {
      attempt();
      return;
    }
    const unsubscribe = profile.ws.onStatus((connected) => {
      if (connected) attempt();
    });
    const timer = setTimeout(attempt, 10_000);
    this.deferred.set(actionId, { timer, unsubscribe });
  }

  private async resolveApproval(
    profile: PushResponseProfileClient,
    actionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    attempt: number
  ): Promise<void> {
    try {
      await profile.api.resolveApproval(approvalId, decision, actionId);
    } catch {
      if (this.profile !== profile || attempt >= 4) return;
      const timer = setTimeout(() => {
        this.deferred.delete(actionId);
        void this.resolveApproval(profile, actionId, approvalId, decision, attempt + 1);
      }, Math.min(1000 * 2 ** (attempt - 1), 4000));
      this.deferred.set(actionId, { timer, unsubscribe: () => {} });
    }
  }

  private remember(actionId: string): void {
    this.handled.add(actionId);
    this.handledOrder.push(actionId);
    while (this.handledOrder.length > this.maxHandled) {
      const oldest = this.handledOrder.shift();
      if (oldest) this.handled.delete(oldest);
    }
  }

  private cancelDeferred(): void {
    for (const deferred of this.deferred.values()) {
      clearTimeout(deferred.timer);
      deferred.unsubscribe();
    }
    this.deferred.clear();
  }
}
