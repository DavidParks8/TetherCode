import type { HostBridgeApiClient } from './api/client';
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
    return true;
  }

  dispose(): void {
    this.cancelDeferred();
    this.pending.clear();
    this.profile = null;
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
