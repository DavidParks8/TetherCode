import * as Crypto from 'expo-crypto';

import type { HostBridgeApiClient } from './api/client';
import type { AppStateStore, PushSettingsState } from './appState';
import { requestPushRegistration } from './pushNotifications';

export type PushSyncResult =
  | { status: 'registered'; token: string }
  | { status: 'optedOut' }
  | { status: 'unavailable' };

export async function syncPushRegistration(
  api: HostBridgeApiClient,
  store: AppStateStore,
  profileId: string
): Promise<PushSyncResult> {
  const initialSettings = store.getSnapshot().data.push;
  let registration = store
    .getSnapshot()
    .data.push.registrations.find((entry) => entry.profileId === profileId);
  if (initialSettings.optedOut && !registration) return { status: 'optedOut' };
  if (!registration) {
    const registrationId = `push-${Crypto.randomUUID()}`;
    const state = await store.dispatchDurable({
      type: 'push/ensure-registration',
      profileId,
      registrationId,
    });
    registration = state.push.registrations.find((entry) => entry.profileId === profileId);
  }
  if (!registration) {
    throw new Error('Could not create a push registration identity.');
  }

  const settings = store.getSnapshot().data.push;
  if (settings.optedOut) {
    if (registration.token) {
      await api.unregisterPushDevice({
        profileId: registration.profileId,
        registrationId: registration.registrationId,
      });
      await store.dispatchDurable({
        type: 'push/unregistered',
        profileId: registration.profileId,
        registrationId: registration.registrationId,
      });
    }
    return { status: 'optedOut' };
  }

  const token = await requestPushRegistration();
  if (!token) return { status: 'unavailable' };

  await api.registerPushDevice({
    profileId: registration.profileId,
    registrationId: registration.registrationId,
    token: token.token,
    platform: token.platform,
    deviceName: token.deviceName,
    events: settings.events,
  });
  await store.dispatchDurable({
    type: 'push/registered',
    profileId: registration.profileId,
    registrationId: registration.registrationId,
    token: token.token,
  });
  return { status: 'registered', token: token.token };
}

export async function enablePush(
  api: HostBridgeApiClient,
  store: AppStateStore,
  profileId: string
): Promise<PushSyncResult> {
  await store.dispatchDurable({ type: 'push/update', patch: { optedOut: false } });
  return syncPushRegistration(api, store, profileId);
}

export async function disablePush(
  api: HostBridgeApiClient,
  store: AppStateStore,
  profileId: string
): Promise<void> {
  await store.dispatchDurable({ type: 'push/update', patch: { optedOut: true } });
  await syncPushRegistration(api, store, profileId);
}

export async function updatePushEvents(
  api: HostBridgeApiClient,
  store: AppStateStore,
  profileId: string,
  events: PushSettingsState['events']
): Promise<void> {
  const state = await store.dispatchDurable({ type: 'push/update', patch: { events } });
  if (!state.push.optedOut) await syncPushRegistration(api, store, profileId);
}
