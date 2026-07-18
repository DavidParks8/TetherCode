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
});
