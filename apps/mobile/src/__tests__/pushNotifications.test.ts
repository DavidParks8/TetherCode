import { mapResponseAction, parsePushNavigationTarget } from '../pushNotifications';

describe('parsePushNavigationTarget', () => {
  const identity = {
    notificationId: 'notification-1',
    profileId: 'profile-1',
    registrationId: 'registration-1',
  };

  it('requires and preserves immutable push identity', () => {
    expect(
      parsePushNavigationTarget({
        ...identity,
        type: 'approval_requested',
        threadId: 'thread-1',
        approvalId: 'approval-1',
      })
    ).toEqual({
      ...identity,
      type: 'approvalRequested',
      threadId: 'thread-1',
      approvalId: 'approval-1',
    });
  });

  it('rejects identity-less and malformed payloads', () => {
    expect(parsePushNavigationTarget({ type: 'turn_completed', threadId: 'thread-1' })).toBeNull();
    expect(parsePushNavigationTarget({ ...identity, type: 'something_else' })).toBeNull();
    expect(parsePushNavigationTarget(null)).toBeNull();
  });
});

describe('mapResponseAction', () => {
  it('maps action identifiers', () => {
    expect(mapResponseAction('approve')).toBe('approve');
    expect(mapResponseAction('deny')).toBe('deny');
    expect(mapResponseAction('other')).toBe('default');
  });
});
