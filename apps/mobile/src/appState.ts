import type {
  ApprovalMode,
  ChatEngine,
  CollaborationMode,
  EngineDefaultSettingsMap,
  ReasoningEffort,
  ServiceTier,
} from './api/types';
import {
  APP_SETTINGS_VERSION,
  DEFAULT_WORKSPACE_CHAT_LIMIT,
  parseAppSettings,
  type WorkspaceChatLimit,
} from './appSettings';
import {
  createEmptyBridgeProfileStore,
  parseBridgeProfileStore,
  removeBridgeProfile,
  renameBridgeProfile,
  setActiveBridgeProfile,
  upsertBridgeProfile,
  type BridgeProfileDraft,
  type BridgeProfileStore,
} from './bridgeProfiles';
import { dedupeRecentPreviewTargets, normalizePreviewTargetInput } from './browserPreview';
import {
  DEFAULT_FONT_PREFERENCE,
  normalizeFontPreference,
  type FontPreference,
} from './fonts';
import type { AppearancePreference, DarkUiPalette } from './theme';

export const APP_STATE_VERSION = 1;

export interface AppSettingsState {
  defaultStartCwd: string | null;
  defaultChatEngine: ChatEngine;
  defaultEngineSettings: EngineDefaultSettingsMap;
  approvalMode: ApprovalMode;
  showToolCalls: boolean;
  workspaceChatLimit: WorkspaceChatLimit;
  appearancePreference: AppearancePreference;
  darkUiPalette: DarkUiPalette;
  fontPreference: FontPreference;
  recentBrowserTargetUrls: string[];
}

export interface AppStateData {
  settings: AppSettingsState;
  bridgeProfiles: BridgeProfileStore;
}

export type AppStatePersistenceOperation = 'load' | 'import' | 'write';
export type AppStatePersistenceErrorCode = 'read_failed' | 'invalid_data' | 'write_failed';

export class AppStatePersistenceError extends Error {
  readonly code: AppStatePersistenceErrorCode;
  readonly operation: AppStatePersistenceOperation;
  override readonly cause: unknown;

  constructor(
    code: AppStatePersistenceErrorCode,
    operation: AppStatePersistenceOperation,
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.name = 'AppStatePersistenceError';
    this.code = code;
    this.operation = operation;
    this.cause = cause;
  }
}

export interface LegacyAppStateSource {
  settingsRaw: string | null;
  bridgeProfilesRaw: string | null;
}

export interface AppStatePersistenceAdapter {
  readCurrent(): Promise<string | null>;
  writeCurrent(raw: string): Promise<void>;
  readLegacy(): Promise<LegacyAppStateSource>;
}

export interface AppStateSnapshot {
  loaded: boolean;
  data: AppStateData;
  persistenceError: AppStatePersistenceError | null;
}

export type AppStateAction =
  | { type: 'settings/update'; patch: Partial<AppSettingsState> }
  | {
      type: 'settings/remember-thread';
      engine: ChatEngine;
      modelId: string | null;
      effort: ReasoningEffort | null;
      serviceTier: ServiceTier | null;
      collaborationMode: CollaborationMode;
    }
  | { type: 'profiles/save'; draft: BridgeProfileDraft }
  | { type: 'profiles/switch'; profileId: string }
  | { type: 'profiles/rename'; profileId: string; name: string }
  | { type: 'profiles/remove'; profileId: string }
  | { type: 'profiles/clear' };

export function createDefaultAppSettings(): AppSettingsState {
  return {
    defaultStartCwd: null,
    defaultChatEngine: 'codex',
    defaultEngineSettings: createEmptyEngineDefaultSettingsMap(),
    approvalMode: 'yolo',
    showToolCalls: true,
    workspaceChatLimit: DEFAULT_WORKSPACE_CHAT_LIMIT,
    appearancePreference: 'system',
    darkUiPalette: 'classic',
    fontPreference: DEFAULT_FONT_PREFERENCE,
    recentBrowserTargetUrls: [],
  };
}

export function createDefaultAppStateData(): AppStateData {
  return {
    settings: createDefaultAppSettings(),
    bridgeProfiles: createEmptyBridgeProfileStore(),
  };
}

export function appStateReducer(state: AppStateData, action: AppStateAction): AppStateData {
  switch (action.type) {
    case 'settings/update':
      return {
        ...state,
        settings: normalizeAppSettings({ ...state.settings, ...action.patch }),
      };
    case 'settings/remember-thread': {
      const engine = normalizeChatEngine(action.engine);
      return {
        ...state,
        settings: {
          ...state.settings,
          defaultChatEngine: engine,
          defaultEngineSettings: {
            ...state.settings.defaultEngineSettings,
            [engine]: {
              modelId: normalizeNullableString(action.modelId),
              effort: normalizeReasoningEffort(action.effort),
              serviceTier: action.serviceTier === 'fast' ? 'fast' : null,
              collaborationMode: normalizeCollaborationMode(
                action.collaborationMode,
                engine
              ),
            },
          },
        },
      };
    }
    case 'profiles/save':
      return {
        ...state,
        bridgeProfiles: upsertBridgeProfile(state.bridgeProfiles, action.draft).store,
      };
    case 'profiles/switch': {
      if (!state.bridgeProfiles.profiles.some((profile) => profile.id === action.profileId)) {
        throw new Error('The selected bridge profile no longer exists.');
      }
      return {
        ...state,
        bridgeProfiles: setActiveBridgeProfile(state.bridgeProfiles, action.profileId),
      };
    }
    case 'profiles/rename':
      return {
        ...state,
        bridgeProfiles: renameBridgeProfile(
          state.bridgeProfiles,
          action.profileId,
          action.name
        ),
      };
    case 'profiles/remove':
      return {
        ...state,
        bridgeProfiles: removeBridgeProfile(state.bridgeProfiles, action.profileId),
      };
    case 'profiles/clear':
      return {
        ...state,
        bridgeProfiles: createEmptyBridgeProfileStore(),
      };
  }
}

export function serializeAppState(data: AppStateData): string {
  const normalized = normalizeAppStateData(data);
  return JSON.stringify({
    version: APP_STATE_VERSION,
    settings: normalized.settings,
    bridgeProfiles: normalized.bridgeProfiles,
  });
}

export function parsePersistedAppState(raw: string): AppStateData {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== APP_STATE_VERSION) {
      throw new Error(`Unsupported app-state version: ${String(parsed?.version)}`);
    }
    return normalizeAppStateData({
      settings: normalizeAppSettings(parsed.settings),
      bridgeProfiles: parseBridgeProfileStore(JSON.stringify(parsed.bridgeProfiles ?? {})),
    });
  } catch (error) {
    if (error instanceof AppStatePersistenceError) {
      throw error;
    }
    throw new AppStatePersistenceError(
      'invalid_data',
      'load',
      'Saved app state is invalid and was not overwritten.',
      error
    );
  }
}

export function importLegacyAppState(source: LegacyAppStateSource): AppStateData {
  const parsedSettings = parseAppSettings(source.settingsRaw ?? '');
  let bridgeProfiles = parseBridgeProfileStore(source.bridgeProfilesRaw);
  if (
    bridgeProfiles.profiles.length === 0 &&
    parsedSettings.bridgeUrl &&
    parsedSettings.bridgeToken
  ) {
    bridgeProfiles = upsertBridgeProfile(bridgeProfiles, {
      name: null,
      bridgeUrl: parsedSettings.bridgeUrl,
      bridgeToken: parsedSettings.bridgeToken,
      activate: true,
    }).store;
  }

  return {
    settings: normalizeAppSettings(parsedSettings),
    bridgeProfiles,
  };
}

export class AppStateStore {
  private snapshot: AppStateSnapshot = {
    loaded: false,
    data: createDefaultAppStateData(),
    persistenceError: null,
  };
  private readonly listeners = new Set<() => void>();
  private initializePromise: Promise<void> | null = null;
  private initializedSuccessfully = false;
  private pendingData: AppStateData | null = null;
  private writeLoop: Promise<void> | null = null;
  private durableChain: Promise<unknown> = Promise.resolve();
  private durableRequests = 0;
  private readonly queuedActions: AppStateAction[] = [];

  constructor(private readonly persistence: AppStatePersistenceAdapter) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): AppStateSnapshot => this.snapshot;

  initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.loadInitialState();
    }
    return this.initializePromise;
  }

  dispatch(action: AppStateAction): void {
    if (!this.snapshot.loaded) {
      throw new Error('App state has not loaded.');
    }
    if (this.durableRequests > 0) {
      this.queuedActions.push(action);
      return;
    }
    this.publish(appStateReducer(this.snapshot.data, action), null);
    this.queuePersistence(this.snapshot.data);
  }

  dispatchDurable(action: AppStateAction): Promise<AppStateData> {
    this.durableRequests += 1;
    const operation = this.durableChain.then(() => this.applyDurable(action));
    this.durableChain = operation.catch(() => undefined);
    return operation;
  }

  async retryPersistence(): Promise<void> {
    if (!this.initializedSuccessfully) {
      this.initializePromise = null;
      await this.initialize();
      return;
    }
    if (this.writeLoop) {
      await this.writeLoop;
    }
    this.pendingData = this.snapshot.data;
    this.publish(this.snapshot.data, null);
    this.startWriteLoop();
    await this.flushPersistence();
  }

  async flushPersistence(): Promise<void> {
    if (this.pendingData && !this.writeLoop) {
      this.publish(this.snapshot.data, null);
      this.startWriteLoop();
    }
    await this.writeLoop;
    if (this.snapshot.persistenceError) {
      throw this.snapshot.persistenceError;
    }
  }

  private async loadInitialState(): Promise<void> {
    try {
      const raw = await this.persistence.readCurrent().catch((error) => {
        throw persistenceError('read_failed', 'load', 'Could not load saved app state.', error);
      });
      if (raw !== null) {
        const data = parsePersistedAppState(raw);
        this.pendingData = null;
        this.initializedSuccessfully = true;
        this.publish(data, null, true);
        return;
      }

      const legacy = await this.persistence.readLegacy().catch((error) => {
        throw persistenceError(
          'read_failed',
          'import',
          'Could not import the existing app settings.',
          error
        );
      });
      const data = importLegacyAppState(legacy);
      try {
        await this.persistence.writeCurrent(serializeAppState(data));
        this.pendingData = null;
        this.initializedSuccessfully = true;
        this.publish(data, null, true);
      } catch (error) {
        this.pendingData = data;
        this.publish(
          data,
          persistenceError(
            'write_failed',
            'import',
            'Imported settings could not be saved. Retry before changing connections.',
            error
          ),
          true
        );
      }
    } catch (error) {
      this.publish(
        this.snapshot.data,
        error instanceof AppStatePersistenceError
          ? error
          : persistenceError('read_failed', 'load', 'Could not load saved app state.', error),
        true
      );
    }
  }

  private async applyDurable(action: AppStateAction): Promise<AppStateData> {
    if (!this.snapshot.loaded) {
      await this.initialize();
    }
    try {
      await this.flushPersistence();
      const nextData = appStateReducer(this.snapshot.data, action);
      try {
        await this.persistence.writeCurrent(serializeAppState(nextData));
      } catch (error) {
        const typedError = persistenceError(
          'write_failed',
          'write',
          'The app-state change was not saved. Please retry.',
          error
        );
        this.publish(this.snapshot.data, typedError);
        throw typedError;
      }
      this.initializedSuccessfully = true;
      this.publish(nextData, null);
      return nextData;
    } finally {
      this.durableRequests -= 1;
      if (this.durableRequests === 0) {
        this.applyQueuedActions();
      }
    }
  }

  private applyQueuedActions(): void {
    if (this.queuedActions.length === 0) {
      return;
    }
    let data = this.snapshot.data;
    for (const action of this.queuedActions.splice(0)) {
      data = appStateReducer(data, action);
    }
    this.publish(data, null);
    this.queuePersistence(data);
  }

  private queuePersistence(data: AppStateData): void {
    this.pendingData = data;
    this.startWriteLoop();
  }

  private startWriteLoop(): void {
    if (this.writeLoop || !this.pendingData) {
      return;
    }
    this.writeLoop = Promise.resolve()
      .then(async () => {
        while (this.pendingData) {
          const data = this.pendingData;
          this.pendingData = null;
          try {
            await this.persistence.writeCurrent(serializeAppState(data));
            this.initializedSuccessfully = true;
            this.publish(this.snapshot.data, null);
          } catch (error) {
            this.pendingData = this.pendingData ?? data;
            this.publish(
              this.snapshot.data,
              persistenceError(
                'write_failed',
                'write',
                'Settings could not be saved. Retry to persist the latest changes.',
                error
              )
            );
            return;
          }
        }
      })
      .finally(() => {
        this.writeLoop = null;
      });
  }

  private publish(
    data: AppStateData,
    persistenceError: AppStatePersistenceError | null,
    loaded = this.snapshot.loaded
  ): void {
    this.snapshot = { loaded, data, persistenceError };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function createAppStateStore(persistence: AppStatePersistenceAdapter): AppStateStore {
  return new AppStateStore(persistence);
}

function normalizeAppStateData(data: AppStateData): AppStateData {
  return {
    settings: normalizeAppSettings(data.settings),
    bridgeProfiles: parseBridgeProfileStore(JSON.stringify(data.bridgeProfiles)),
  };
}

function normalizeAppSettings(value: unknown): AppSettingsState {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const parsed = parseAppSettings(
    JSON.stringify({
      version: APP_SETTINGS_VERSION,
      defaultStartCwd: record.defaultStartCwd,
      lastUsedChatEngine: record.defaultChatEngine,
      lastUsedEngineSettings: record.defaultEngineSettings,
      approvalMode: record.approvalMode,
      showToolCalls: record.showToolCalls,
      workspaceChatLimit: record.workspaceChatLimit,
      appearancePreference: record.appearancePreference,
      darkUiPalette: record.darkUiPalette,
      fontPreference: record.fontPreference,
      recentBrowserTargetUrls: record.recentBrowserTargetUrls,
    })
  );
  return {
    defaultStartCwd: parsed.defaultStartCwd,
    defaultChatEngine: parsed.defaultChatEngine,
    defaultEngineSettings: parsed.defaultEngineSettings,
    approvalMode: parsed.approvalMode,
    showToolCalls: parsed.showToolCalls,
    workspaceChatLimit: parsed.workspaceChatLimit,
    appearancePreference: parsed.appearancePreference,
    darkUiPalette: parsed.darkUiPalette,
    fontPreference: normalizeFontPreference(parsed.fontPreference),
    recentBrowserTargetUrls: dedupeRecentPreviewTargets(
      parsed.recentBrowserTargetUrls
        .map(normalizePreviewTargetInput)
        .filter((target): target is string => target !== null)
    ),
  };
}

function createEmptyEngineDefaultSettingsMap(): EngineDefaultSettingsMap {
  return {
    codex: { modelId: null, effort: null, serviceTier: null, collaborationMode: 'default' },
    opencode: { modelId: null, effort: null, serviceTier: null, collaborationMode: 'default' },
    cursor: { modelId: null, effort: null, serviceTier: null, collaborationMode: 'default' },
  };
}

function normalizeChatEngine(value: unknown): ChatEngine {
  return value === 'opencode' || value === 'cursor' ? value : 'codex';
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  return value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
    ? value
    : null;
}

function normalizeCollaborationMode(
  value: CollaborationMode,
  engine: ChatEngine
): CollaborationMode {
  return value === 'plan' || (value === 'ask' && engine === 'cursor') ? value : 'default';
}

function persistenceError(
  code: AppStatePersistenceErrorCode,
  operation: AppStatePersistenceOperation,
  message: string,
  cause: unknown
): AppStatePersistenceError {
  return cause instanceof AppStatePersistenceError
    ? cause
    : new AppStatePersistenceError(code, operation, message, cause);
}
