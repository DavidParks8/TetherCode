import * as Crypto from 'expo-crypto';

import type { AppStateAction, AppStateData } from '../appState';
import { createDefaultAppStateData } from '../appState';
import {
  disablePush,
  enablePush,
  syncPushRegistration,
  updatePushEvents,
} from '../pushController';
import { requestPushRegistration } from '../pushNotifications';

jest.mock('../pushNotifications', () => ({
  requestPushRegistration: jest.fn(),
}));

const requestRegistration = requestPushRegistration as jest.MockedFunction<
  typeof requestPushRegistration
>;

function createStore(initial: Partial<AppStateData['push']> = {}) {
  const data = createDefaultAppStateData();
  data.push = { ...data.push, ...initial };
  const dispatchDurable = jest.fn(async (action: AppStateAction) => {
    switch (action.type) {
      case 'push/update':
        data.push = { ...data.push, ...action.patch };
        break;
      case 'push/ensure-registration':
        if (!data.push.registrations.some((entry) => entry.profileId === action.profileId)) {
          data.push.registrations.push({
            profileId: action.profileId,
            registrationId: action.registrationId,
            token: null,
          });
        }
        break;
      case 'push/registered': {
        const registration = data.push.registrations.find(
          (entry) => entry.profileId === action.profileId
        );
        if (registration) registration.token = action.token;
        break;
      }
      case 'push/unregistered': {
        const registration = data.push.registrations.find(
          (entry) => entry.profileId === action.profileId
        );
        if (registration) registration.token = null;
        break;
      }
    }
    return data;
  });
  return {
    data,
    store: { getSnapshot: () => ({ data }), dispatchDurable } as never,
    dispatchDurable,
  };
}

describe('pushController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Crypto, 'randomUUID').mockReturnValue('generated-id');
  });

  afterEach(() => jest.restoreAllMocks());

  it('does nothing when an opted-out profile has no registration', async () => {
    const { store, dispatchDurable } = createStore({ optedOut: true });
    const api = { unregisterPushDevice: jest.fn() };

    await expect(syncPushRegistration(api as never, store, 'profile-1')).resolves.toEqual({
      status: 'optedOut',
    });
    expect(dispatchDurable).not.toHaveBeenCalled();
  });

  it('creates and registers a durable device identity', async () => {
    const { store, dispatchDurable } = createStore();
    const api = { registerPushDevice: jest.fn().mockResolvedValue(undefined) };
    requestRegistration.mockResolvedValue({
      token: 'ExponentPushToken[value]',
      platform: 'ios',
      deviceName: 'Phone',
    });

    await expect(syncPushRegistration(api as never, store, 'profile-1')).resolves.toEqual({
      status: 'registered',
      token: 'ExponentPushToken[value]',
    });
    expect(dispatchDurable).toHaveBeenNthCalledWith(1, {
      type: 'push/ensure-registration',
      profileId: 'profile-1',
      registrationId: 'push-generated-id',
    });
    expect(api.registerPushDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'profile-1',
        registrationId: 'push-generated-id',
        token: 'ExponentPushToken[value]',
      })
    );
    expect(dispatchDurable).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'push/registered', token: 'ExponentPushToken[value]' })
    );
  });

  it('reports unavailable registration and detects failed identity creation', async () => {
    const existing = {
      profileId: 'profile-1',
      registrationId: 'registration-1',
      token: null,
    };
    const { store } = createStore({ registrations: [existing] });
    requestRegistration.mockResolvedValue(null);
    await expect(syncPushRegistration({} as never, store, 'profile-1')).resolves.toEqual({
      status: 'unavailable',
    });

    const brokenStore = {
      getSnapshot: () => ({ data: createDefaultAppStateData() }),
      dispatchDurable: jest.fn(async () => createDefaultAppStateData()),
    };
    await expect(syncPushRegistration({} as never, brokenStore as never, 'profile-1')).rejects.toThrow(
      'Could not create a push registration identity.'
    );
  });

  it('unregisters an opted-out token and retains a tokenless identity', async () => {
    const registration = {
      profileId: 'profile-1',
      registrationId: 'registration-1',
      token: 'old-token' as string | null,
    };
    const { store, dispatchDurable } = createStore({ optedOut: true, registrations: [registration] });
    const api = { unregisterPushDevice: jest.fn().mockResolvedValue(undefined) };

    await expect(syncPushRegistration(api as never, store, 'profile-1')).resolves.toEqual({
      status: 'optedOut',
    });
    expect(api.unregisterPushDevice).toHaveBeenCalledWith({
      profileId: 'profile-1',
      registrationId: 'registration-1',
    });
    expect(dispatchDurable).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'push/unregistered' })
    );

    registration.token = null;
    api.unregisterPushDevice.mockClear();
    dispatchDurable.mockClear();
    await syncPushRegistration(api as never, store, 'profile-1');
    expect(api.unregisterPushDevice).not.toHaveBeenCalled();
    expect(dispatchDurable).not.toHaveBeenCalled();
  });

  it('enables, disables, and conditionally syncs event preferences', async () => {
    const registration = {
      profileId: 'profile-1',
      registrationId: 'registration-1',
      token: 'old-token',
    };
    const { store, data } = createStore({ optedOut: true, registrations: [registration] });
    const api = {
      registerPushDevice: jest.fn().mockResolvedValue(undefined),
      unregisterPushDevice: jest.fn().mockResolvedValue(undefined),
    };
    requestRegistration.mockResolvedValue({ token: 'new-token', platform: 'ios', deviceName: 'Phone' });

    await expect(enablePush(api as never, store, 'profile-1')).resolves.toEqual({
      status: 'registered',
      token: 'new-token',
    });
    await disablePush(api as never, store, 'profile-1');
    expect(api.unregisterPushDevice).toHaveBeenCalledTimes(1);

    const events = { turnCompleted: false, approvalRequested: true };
    await updatePushEvents(api as never, store, 'profile-1', events);
    expect(data.push.events).toEqual(events);
    expect(requestRegistration).toHaveBeenCalledTimes(1);

    data.push.optedOut = false;
    await updatePushEvents(api as never, store, 'profile-1', events);
    expect(requestRegistration).toHaveBeenCalledTimes(2);
  });
});
