import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import type { BridgeUiSurface } from '../../api/types';
import {
  type ActivePlanState,
  CHAT_BRIDGE_UI_SURFACES_VERSION,
  CHAT_MODEL_PREFERENCES_VERSION,
  CHAT_PLAN_SNAPSHOTS_VERSION,
  type ChatModelPreference,
  WORKSPACE_FAVORITES_VERSION,
  getChatBridgeUiSurfacesPath,
  getChatModelPreferencesPath,
  getChatPlanSnapshotsPath,
  getWorkspaceFavoritesPath,
  parseChatBridgeUiSurfaces,
  parseChatModelPreferences,
  parseChatPlanSnapshots,
  parseWorkspaceFavoritePaths,
} from '../mainScreenHelpers';

export interface MainScreenStorage {
  read(path: string): Promise<string>;
  write(path: string, value: string): Promise<void>;
}

export interface MainScreenPersistencePaths {
  modelPreferences: () => string | null;
  planSnapshots: () => string | null;
  bridgeUiSurfaces: () => string | null;
  workspaceFavorites: () => string | null;
}

const fileStorage: MainScreenStorage = {
  read: FileSystem.readAsStringAsync,
  write: FileSystem.writeAsStringAsync,
};

interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const webStorage: MainScreenStorage = {
  read: async (key) => {
    const value = getWebStorage()?.getItem(key);
    if (value === null || value === undefined) throw new Error('missing');
    return value;
  },
  write: async (key, value) => {
    const storage = getWebStorage();
    if (!storage) throw new Error('Browser storage is unavailable.');
    storage.setItem(key, value);
  },
};

const WEB_PATH_PREFIX = 'tethercode.main-screen.';

export class MainScreenPersistenceController {
  private readonly paths: MainScreenPersistencePaths;

  constructor(
    storage?: MainScreenStorage,
    paths: Partial<MainScreenPersistencePaths> = {},
    platform: string = Platform.OS
  ) {
    this.storage = storage ?? (platform === 'web' ? webStorage : fileStorage);
    const webPath = (name: string, nativePath: () => string | null) => () =>
      platform === 'web' ? `${WEB_PATH_PREFIX}${name}` : nativePath();
    this.paths = {
      modelPreferences: paths.modelPreferences ?? webPath('model-preferences.v1', getChatModelPreferencesPath),
      planSnapshots: paths.planSnapshots ?? webPath('plan-snapshots.v1', getChatPlanSnapshotsPath),
      bridgeUiSurfaces: paths.bridgeUiSurfaces ?? webPath('bridge-ui-surfaces.v1', getChatBridgeUiSurfacesPath),
      workspaceFavorites: paths.workspaceFavorites ?? webPath('workspace-favorites.v1', getWorkspaceFavoritesPath),
    };
  }

  private readonly storage: MainScreenStorage;

  loadModelPreferences(): Promise<Record<string, ChatModelPreference>> {
    return this.read(this.paths.modelPreferences(), parseChatModelPreferences, {});
  }

  saveModelPreferences(entries: Record<string, ChatModelPreference>): Promise<void> {
    return this.write(this.paths.modelPreferences(), {
      version: CHAT_MODEL_PREFERENCES_VERSION,
      entries,
    });
  }

  loadPlanSnapshots(): Promise<Record<string, ActivePlanState>> {
    return this.read(this.paths.planSnapshots(), parseChatPlanSnapshots, {});
  }

  savePlanSnapshots(entries: Record<string, ActivePlanState>): Promise<void> {
    return this.write(this.paths.planSnapshots(), {
      version: CHAT_PLAN_SNAPSHOTS_VERSION,
      entries,
    });
  }

  loadBridgeUiSurfaces(): Promise<Record<string, BridgeUiSurface[]>> {
    return this.read(this.paths.bridgeUiSurfaces(), parseChatBridgeUiSurfaces, {});
  }

  saveBridgeUiSurfaces(entries: Record<string, BridgeUiSurface[]>): Promise<void> {
    return this.write(this.paths.bridgeUiSurfaces(), {
      version: CHAT_BRIDGE_UI_SURFACES_VERSION,
      entries,
    });
  }

  loadWorkspaceFavorites(): Promise<string[]> {
    return this.read(this.paths.workspaceFavorites(), parseWorkspaceFavoritePaths, []);
  }

  saveWorkspaceFavorites(paths: string[]): Promise<void> {
    return this.write(this.paths.workspaceFavorites(), {
      version: WORKSPACE_FAVORITES_VERSION,
      paths,
    });
  }

  private async read<T>(
    path: string | null,
    parse: (raw: string) => T,
    fallback: T
  ): Promise<T> {
    if (!path) return fallback;
    try {
      return parse(await this.storage.read(path));
    } catch {
      return fallback;
    }
  }

  private async write(path: string | null, value: unknown): Promise<void> {
    if (!path) return;
    try {
      await this.storage.write(path, JSON.stringify(value));
    } catch {
      // Main-screen persistence is best effort.
    }
  }
}

function getWebStorage(): WebStorageLike | null {
  if (typeof globalThis !== 'object' || globalThis === null) return null;
  const storage = (
    globalThis as typeof globalThis & { localStorage?: Partial<WebStorageLike> }
  ).localStorage;
  return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
    ? (storage as WebStorageLike)
    : null;
}
