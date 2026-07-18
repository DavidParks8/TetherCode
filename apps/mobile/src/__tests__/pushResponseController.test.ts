import { PushResponseController } from '../pushResponseController';
import type { PushResponseEvent } from '../pushNotifications';

function event(overrides: Partial<PushResponseEvent> = {}): PushResponseEvent {
  return {
    actionId: 'notification-1:approve',
    action: 'approve',
    target: {
      type: 'approvalRequested',
      notificationId: 'notification-1',
      profileId: 'profile-1',
      registrationId: 'registration-1',
      threadId: 'thread-1',
      approvalId: 'approval-1',
    },
    ...overrides,
  };
}

describe('PushResponseController', () => {
  it('deduplicates cold and live responses and rejects another profile', () => {
    const navigate = jest.fn();
    const api = { resolveApproval: jest.fn().mockResolvedValue({ ok: true }) };
    const ws = { isConnected: true, onStatus: jest.fn() };
    const controller = new PushResponseController(navigate);
    controller.setProfile({
      profileId: 'profile-1',
      registrationId: 'registration-1',
      api: api as never,
      ws: ws as never,
    });

    expect(controller.handle(event())).toBe(true);
    expect(controller.handle(event())).toBe(false);
    expect(
      controller.handle(
        event({
          actionId: 'notification-2:approve',
          target: { ...event().target, notificationId: 'notification-2', profileId: 'profile-2' },
        })
      )
    ).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(api.resolveApproval).toHaveBeenCalledWith(
      'approval-1',
      'accept',
      'notification-1:approve'
    );
  });

  it('cancels deferred approval listeners and timers on profile change', () => {
    jest.useFakeTimers();
    const unsubscribe = jest.fn();
    const statusHandler: { current: ((connected: boolean) => void) | null } = { current: null };
    const api = { resolveApproval: jest.fn() };
    const ws = {
      isConnected: false,
      onStatus: jest.fn((handler) => {
        statusHandler.current = handler;
        return unsubscribe;
      }),
    };
    const controller = new PushResponseController(jest.fn());
    controller.setProfile({
      profileId: 'profile-1',
      registrationId: 'registration-1',
      api: api as never,
      ws: ws as never,
    });
    controller.handle(event());
    controller.setProfile(null);
    statusHandler.current?.(true);
    jest.runAllTimers();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(api.resolveApproval).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('handles a cold response after its profile client is installed', () => {
    const navigate = jest.fn();
    const api = { resolveApproval: jest.fn().mockResolvedValue({ ok: true }) };
    const ws = { isConnected: true, onStatus: jest.fn() };
    const controller = new PushResponseController(navigate);

    expect(controller.handle(event())).toBe(false);
    controller.setProfile({
      profileId: 'profile-1',
      registrationId: 'registration-1',
      api: api as never,
      ws: ws as never,
    });

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(api.resolveApproval).toHaveBeenCalledTimes(1);
  });

  it('ignores same-profile updates and non-action taps', () => {
    const navigate = jest.fn();
    const api = { resolveApproval: jest.fn() };
    const ws = { isConnected: true, onStatus: jest.fn() };
    const profile = {
      profileId: 'profile-1',
      registrationId: 'registration-1',
      api: api as never,
      ws: ws as never,
    };
    const controller = new PushResponseController(navigate);
    controller.setProfile(profile);
    controller.setProfile({ ...profile, api: {} as never });

    expect(
      controller.handle(event({ actionId: 'tap', action: 'default' }))
    ).toBe(true);
    expect(
      controller.handle(
        event({
          actionId: 'approve-without-id',
          target: { ...event().target, approvalId: null },
        })
      )
    ).toBe(true);
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });

  it('resolves a deferred denial after the websocket connects', async () => {
    jest.useFakeTimers();
    const unsubscribe = jest.fn();
    let statusHandler: ((connected: boolean) => void) | undefined;
    const api = { resolveApproval: jest.fn().mockResolvedValue({ ok: true }) };
    const ws = {
      isConnected: false,
      onStatus: jest.fn((handler) => {
        statusHandler = handler;
        return unsubscribe;
      }),
    };
    const controller = new PushResponseController(jest.fn());
    controller.setProfile({
      profileId: 'profile-1',
      registrationId: 'registration-1',
      api: api as never,
      ws: ws as never,
    });
    controller.handle(event({ actionId: 'notification-1:deny', action: 'deny' }));
    statusHandler?.(false);
    expect(api.resolveApproval).not.toHaveBeenCalled();
    statusHandler?.(true);
    await Promise.resolve();

    expect(unsubscribe).toHaveBeenCalled();
    expect(api.resolveApproval).toHaveBeenCalledWith(
      'approval-1',
      'decline',
      'notification-1:deny'
    );
    jest.useRealTimers();
  });

  it('retries failed approval resolution up to four attempts', async () => {
    jest.useFakeTimers();
    const api = { resolveApproval: jest.fn().mockRejectedValue(new Error('offline')) };
    const controller = new PushResponseController(jest.fn());
    controller.setProfile({
      profileId: 'profile-1',
      registrationId: 'registration-1',
      api: api as never,
      ws: { isConnected: true, onStatus: jest.fn() } as never,
    });
    controller.handle(event());

    for (let attempt = 1; attempt < 4; attempt += 1) {
      await Promise.resolve();
      jest.runOnlyPendingTimers();
    }
    await Promise.resolve();
    expect(api.resolveApproval).toHaveBeenCalledTimes(4);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it('evicts old handled and pending responses at the configured limit', () => {
    const navigate = jest.fn();
    const controller = new PushResponseController(navigate, 1);
    expect(controller.handle(event({ actionId: 'pending-1' }))).toBe(false);
    expect(controller.handle(event({ actionId: 'pending-2' }))).toBe(false);
    controller.setProfile({
      profileId: 'profile-1',
      registrationId: 'registration-1',
      api: { resolveApproval: jest.fn().mockResolvedValue({ ok: true }) } as never,
      ws: { isConnected: true, onStatus: jest.fn() } as never,
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ actionId: 'pending-1' }));

    expect(controller.handle(event({ actionId: 'handled-2', action: 'default' }))).toBe(true);
    expect(controller.handle(event({ actionId: 'pending-1', action: 'default' }))).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(3);
    controller.dispose();
  });
});
