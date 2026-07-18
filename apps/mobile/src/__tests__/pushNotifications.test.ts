jest.mock('expo-notifications', () => ({
  __esModule: true,
  AndroidImportance: { HIGH: 4 },
  setNotificationCategoryAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
  getLastNotificationResponseAsync: jest.fn(),
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {},
}));
jest.mock('expo-device', () => ({
  __esModule: true,
  isDevice: true,
  deviceName: 'Test phone',
}));

import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';

import {
  addNotificationResponseListener,
  getInitialNotificationResponse,
  mapResponseAction,
  parsePushNavigationTarget,
  registerNotificationCategories,
  requestPushRegistration,
  setupNotificationHandler,
} from '../pushNotifications';

const mockNotifications = Notifications as unknown as {
  setNotificationCategoryAsync: jest.Mock;
  setNotificationHandler: jest.Mock;
  setNotificationChannelAsync: jest.Mock;
  getPermissionsAsync: jest.Mock;
  requestPermissionsAsync: jest.Mock;
  getExpoPushTokenAsync: jest.Mock;
  addNotificationResponseReceivedListener: jest.Mock;
  getLastNotificationResponseAsync: jest.Mock;
};
const mockConstants = Constants as unknown as {
  expoConfig?: { extra?: { eas?: { projectId?: unknown } } };
  easConfig?: { projectId?: unknown };
};
const mockDevice = Device as unknown as { isDevice: boolean; deviceName: unknown };

function response(data: unknown, actionIdentifier = 'default') {
  return {
    actionIdentifier,
    notification: { request: { content: { data } } },
  };
}

describe('pushNotifications', () => {
  const identity = {
    notificationId: 'notification-1',
    profileId: 'profile-1',
    registrationId: 'registration-1',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockConstants.expoConfig = undefined;
    mockConstants.easConfig = undefined;
    mockDevice.isDevice = true;
    mockDevice.deviceName = 'Test phone';
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    mockNotifications.setNotificationCategoryAsync.mockResolvedValue(undefined);
    mockNotifications.setNotificationChannelAsync.mockResolvedValue(undefined);
    mockNotifications.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: false });
    mockNotifications.requestPermissionsAsync.mockResolvedValue({ granted: true });
    mockNotifications.getExpoPushTokenAsync.mockResolvedValue({ data: 'push-token' });
  });

  it('requires and preserves immutable push identity', () => {
    expect(
      parsePushNavigationTarget({
        ...identity,
        type: 'approval_requested',
        threadId: ' thread-1 ',
        approvalId: ' approval-1 ',
      })
    ).toEqual({
      ...identity,
      type: 'approvalRequested',
      threadId: 'thread-1',
      approvalId: 'approval-1',
    });
    expect(parsePushNavigationTarget({ ...identity, type: 'turn_completed' })).toEqual({
      ...identity,
      type: 'turnCompleted',
      threadId: null,
      approvalId: null,
    });
  });

  it('rejects identity-less and malformed payloads', () => {
    expect(parsePushNavigationTarget({ type: 'turn_completed', threadId: 'thread-1' })).toBeNull();
    expect(parsePushNavigationTarget({ ...identity, type: 'something_else' })).toBeNull();
    expect(parsePushNavigationTarget({ ...identity, notificationId: ' ', type: 'turn_completed' }))
      .toBeNull();
    expect(parsePushNavigationTarget({ ...identity, profileId: 1, type: 'turn_completed' })).toBeNull();
    expect(parsePushNavigationTarget({ ...identity, registrationId: null, type: 'turn_completed' }))
      .toBeNull();
    expect(parsePushNavigationTarget(null)).toBeNull();
    expect(parsePushNavigationTarget('payload')).toBeNull();
  });

  it('maps action identifiers', () => {
    expect(mapResponseAction('approve')).toBe('approve');
    expect(mapResponseAction('deny')).toBe('deny');
    expect(mapResponseAction('other')).toBe('default');
  });

  it('registers approval actions and tolerates unsupported categories', async () => {
    await registerNotificationCategories();
    expect(mockNotifications.setNotificationCategoryAsync).toHaveBeenCalledWith(
      'approval',
      expect.arrayContaining([
        expect.objectContaining({ identifier: 'approve' }),
        expect.objectContaining({ identifier: 'deny' }),
      ])
    );

    mockNotifications.setNotificationCategoryAsync.mockRejectedValue(new Error('unsupported'));
    await expect(registerNotificationCategories()).resolves.toBeUndefined();
  });

  it('suppresses foreground banners and enables background banners', async () => {
    setupNotificationHandler();
    const handler = mockNotifications.setNotificationHandler.mock.calls[0][0];
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
    await expect(handler.handleNotification()).resolves.toEqual({
      shouldShowBanner: false,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'background' });
    await expect(handler.handleNotification()).resolves.toEqual(
      expect.objectContaining({ shouldShowBanner: true, shouldPlaySound: true })
    );
  });

  it('returns null on simulators, denied permissions, and empty tokens', async () => {
    mockDevice.isDevice = false;
    await expect(requestPushRegistration()).resolves.toBeNull();

    mockDevice.isDevice = true;
    mockNotifications.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false });
    await expect(requestPushRegistration()).resolves.toBeNull();

    mockNotifications.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: false });
    mockNotifications.getExpoPushTokenAsync.mockResolvedValue({ data: ' ' });
    await expect(requestPushRegistration()).resolves.toBeNull();
    mockNotifications.getExpoPushTokenAsync.mockResolvedValue({ data: 7 });
    await expect(requestPushRegistration()).resolves.toBeNull();
  });

  it('requests permission and uses project and device metadata', async () => {
    mockConstants.expoConfig = { extra: { eas: { projectId: ' project-extra ' } } };
    mockNotifications.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true });
    mockNotifications.getExpoPushTokenAsync.mockResolvedValue({ data: ' token ' });
    mockDevice.deviceName = ' Phone ';

    await expect(requestPushRegistration()).resolves.toEqual({
      token: 'token',
      platform: 'ios',
      deviceName: 'Phone',
    });
    expect(mockNotifications.requestPermissionsAsync).toHaveBeenCalled();
    expect(mockNotifications.getExpoPushTokenAsync).toHaveBeenCalledWith({
      projectId: 'project-extra',
    });
  });

  it('falls back to EAS config and platform device names', async () => {
    mockConstants.expoConfig = { extra: { eas: { projectId: ' ' } } };
    mockConstants.easConfig = { projectId: ' eas-project ' };
    mockDevice.deviceName = null;
    await expect(requestPushRegistration()).resolves.toEqual(
      expect.objectContaining({ deviceName: 'iPhone' })
    );
    expect(mockNotifications.getExpoPushTokenAsync).toHaveBeenCalledWith({
      projectId: 'eas-project',
    });

    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    mockConstants.easConfig = { projectId: null };
    await expect(requestPushRegistration()).resolves.toEqual(
      expect.objectContaining({ platform: 'android', deviceName: 'Android device' })
    );
    expect(mockNotifications.getExpoPushTokenAsync).toHaveBeenLastCalledWith(undefined);
  });

  it('tolerates Android channel setup failures and normalizes token errors', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    mockNotifications.setNotificationChannelAsync.mockRejectedValue(new Error('no channel'));
    mockNotifications.getExpoPushTokenAsync.mockRejectedValue('native failure');
    await expect(requestPushRegistration()).rejects.toThrow('Could not retrieve the push token.');

    const failure = new Error('token failure');
    mockNotifications.getExpoPushTokenAsync.mockRejectedValue(failure);
    await expect(requestPushRegistration()).rejects.toBe(failure);
  });

  it('parses live and initial notification responses and ignores malformed ones', async () => {
    let listener: ((value: unknown) => void) | undefined;
    const remove = jest.fn();
    mockNotifications.addNotificationResponseReceivedListener.mockImplementation((handler) => {
      listener = handler;
      return { remove };
    });
    const handler = jest.fn();
    const subscription = addNotificationResponseListener(handler);
    listener?.(response({ ...identity, type: 'approval_requested', approvalId: 'approval-1' }, 'deny'));
    listener?.(response({ type: 'invalid' }));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'notification-1:deny', action: 'deny' })
    );
    expect(handler).toHaveBeenCalledTimes(1);
    subscription.remove();
    expect(remove).toHaveBeenCalled();

    mockNotifications.getLastNotificationResponseAsync.mockResolvedValue(null);
    await expect(getInitialNotificationResponse()).resolves.toBeNull();
    mockNotifications.getLastNotificationResponseAsync.mockResolvedValue(
      response({ ...identity, type: 'turn_completed' })
    );
    await expect(getInitialNotificationResponse()).resolves.toEqual(
      expect.objectContaining({ actionId: 'notification-1:default', action: 'default' })
    );
  });
});
