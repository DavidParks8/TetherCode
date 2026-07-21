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
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });

  it('does not subscribe or resolve when a push action lacks an advertised permission option', () => {
    const api = { resolveApproval: jest.fn() };
    const ws = {
      isConnected: false,
      onStatus: jest.fn(),
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

    expect(ws.onStatus).not.toHaveBeenCalled();
    expect(api.resolveApproval).not.toHaveBeenCalled();
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
    expect(api.resolveApproval).not.toHaveBeenCalled();
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

  it('navigates a denial response without guessing a permission option id', () => {
    const navigate = jest.fn();
    const api = { resolveApproval: jest.fn().mockResolvedValue({ ok: true }) };
    const ws = {
      isConnected: false,
      onStatus: jest.fn(),
    };
    const controller = new PushResponseController(navigate);
    controller.setProfile({
      profileId: 'profile-1',
      registrationId: 'registration-1',
      api: api as never,
      ws: ws as never,
    });
    controller.handle(event({ actionId: 'notification-1:deny', action: 'deny' }));

    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ action: 'deny' }));
    expect(ws.onStatus).not.toHaveBeenCalled();
    expect(api.resolveApproval).not.toHaveBeenCalled();
  });

  it('does not retry an unadvertised approval choice', () => {
    const api = { resolveApproval: jest.fn().mockRejectedValue(new Error('offline')) };
    const controller = new PushResponseController(jest.fn());
    controller.setProfile({
      profileId: 'profile-1',
      registrationId: 'registration-1',
      api: api as never,
      ws: { isConnected: true, onStatus: jest.fn() } as never,
    });
    controller.handle(event());

    expect(api.resolveApproval).not.toHaveBeenCalled();
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
