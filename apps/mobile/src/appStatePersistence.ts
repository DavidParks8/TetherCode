import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { AppStatePersistenceAdapter, LegacyAppStateSource } from './appState';

const APP_STATE_STORE_KEY = 'tethercode.app-state.v1';
const LEGACY_BRIDGE_PROFILE_STORE_KEY = 'tethercode.bridge-profiles.v1';
const LEGACY_APP_SETTINGS_FILE = 'tethercode-app-settings.json';

interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createAppStatePersistence(): AppStatePersistenceAdapter {
  return {
    readCurrent: () => readSecureValue(APP_STATE_STORE_KEY),
    writeCurrent: (raw) => writeSecureValue(APP_STATE_STORE_KEY, raw),
    readLegacy: readLegacyAppState,
  };
}

async function readLegacyAppState(): Promise<LegacyAppStateSource> {
  const settingsPath = getLegacyAppSettingsPath();
  let settingsRaw: string | null = null;
  if (settingsPath) {
    try {
      settingsRaw = await FileSystem.readAsStringAsync(settingsPath);
    } catch {
      // The legacy settings file is optional on fresh installs.
    }
  }
  return {
    settingsRaw,
    bridgeProfilesRaw: await readSecureValue(LEGACY_BRIDGE_PROFILE_STORE_KEY),
  };
}

async function readSecureValue(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    return getWebStorage()?.getItem(key) ?? null;
  }
  return SecureStore.getItemAsync(key);
}

async function writeSecureValue(key: string, raw: string): Promise<void> {
  if (Platform.OS === 'web') {
    const storage = getWebStorage();
    if (!storage) {
      throw new Error('Browser storage is unavailable.');
    }
    storage.setItem(key, raw);
    return;
  }
  await SecureStore.setItemAsync(key, raw, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

function getLegacyAppSettingsPath(): string | null {
  const base = FileSystem.documentDirectory;
  return typeof base === 'string' && base.trim().length > 0
    ? `${base}${LEGACY_APP_SETTINGS_FILE}`
    : null;
}

function getWebStorage(): WebStorageLike | null {
  if (typeof globalThis !== 'object' || globalThis === null) {
    return null;
  }
  const storage = (
    globalThis as typeof globalThis & { localStorage?: Partial<WebStorageLike> }
  ).localStorage;
  return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
    ? (storage as WebStorageLike)
    : null;
}
