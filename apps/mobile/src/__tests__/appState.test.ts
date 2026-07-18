import {
  APP_STATE_VERSION,
  AppStatePersistenceError,
  appStateReducer,
  createAppStateStore,
  createDefaultAppStateData,
  importLegacyAppState,
  parsePersistedAppState,
  serializeAppState,
  type AppStatePersistenceAdapter,
} from '../appState';

function createPersistence(
  overrides: Partial<AppStatePersistenceAdapter> = {}
): AppStatePersistenceAdapter {
  return {
    readCurrent: jest.fn().mockResolvedValue(serializeAppState(createDefaultAppStateData())),
    writeCurrent: jest.fn().mockResolvedValue(undefined),
    readLegacy: jest.fn().mockResolvedValue({ settingsRaw: null, bridgeProfilesRaw: null }),
    ...overrides,
  };
}

describe('appStateReducer', () => {
  it('merges rapid unrelated settings changes against the latest state', () => {
    const appearanceChanged = appStateReducer(createDefaultAppStateData(), {
      type: 'settings/update',
      patch: { appearancePreference: 'light' },
    });
    const toolsChanged = appStateReducer(appearanceChanged, {
      type: 'settings/update',
      patch: { showToolCalls: false },
    });

    expect(toolsChanged.settings.appearancePreference).toBe('light');
    expect(toolsChanged.settings.showToolCalls).toBe(false);
    expect(toolsChanged.settings.approvalMode).toBe('yolo');
  });

  it('merges remembered engine settings without replacing other engines', () => {
    const state = appStateReducer(createDefaultAppStateData(), {
      type: 'settings/remember-thread',
      engine: 'cursor',
      modelId: 'cursor-small',
      effort: 'high',
      serviceTier: 'fast',
      collaborationMode: 'ask',
    });

    expect(state.settings.defaultChatEngine).toBe('cursor');
    expect(state.settings.defaultEngineSettings.cursor).toEqual({
      modelId: 'cursor-small',
      effort: 'high',
      serviceTier: 'fast',
      collaborationMode: 'ask',
    });
    expect(state.settings.defaultEngineSettings.codex).toMatchObject({
      modelId: null,
      effort: null,
    });
  });
});

describe('app-state persistence format', () => {
  it('round-trips the current version', () => {
    const raw = serializeAppState(createDefaultAppStateData());
    expect(JSON.parse(raw).version).toBe(APP_STATE_VERSION);
    expect(parsePersistedAppState(raw)).toEqual(createDefaultAppStateData());
  });

  it('rejects unknown versions without falling back and overwriting them', () => {
    expect(() => parsePersistedAppState('{"version":999}')).toThrow(
      AppStatePersistenceError
    );
  });

  it('imports the currently persisted settings and bridge credentials', () => {
    const imported = importLegacyAppState({
      settingsRaw: JSON.stringify({
        version: 11,
        bridgeUrl: 'http://10.0.0.4:8787',
        bridgeToken: 'secret',
        approvalMode: 'normal',
        appearancePreference: 'dark',
      }),
      bridgeProfilesRaw: null,
    });

    expect(imported.settings.approvalMode).toBe('normal');
    expect(imported.settings.appearancePreference).toBe('dark');
    expect(imported.bridgeProfiles.profiles[0]).toMatchObject({
      bridgeUrl: 'http://10.0.0.4:8787',
      bridgeToken: 'secret',
    });
    expect(imported.bridgeProfiles.activeProfileId).toBe(imported.bridgeProfiles.profiles[0]?.id);
  });
});

describe('AppStateStore', () => {
  it('serializes writes and coalesces changes made during an in-flight write', async () => {
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const writeCurrent = jest
      .fn<Promise<void>, [string]>()
      .mockImplementationOnce(() => firstWrite)
      .mockResolvedValue(undefined);
    const store = createAppStateStore(createPersistence({ writeCurrent }));
    await store.initialize();

    store.dispatch({ type: 'settings/update', patch: { appearancePreference: 'light' } });
    await Promise.resolve();
    store.dispatch({ type: 'settings/update', patch: { showToolCalls: false } });
    store.dispatch({ type: 'settings/update', patch: { workspaceChatLimit: 10 } });

    expect(writeCurrent).toHaveBeenCalledTimes(1);
    releaseFirstWrite();
    await store.flushPersistence();

    expect(writeCurrent).toHaveBeenCalledTimes(2);
    const persisted = parsePersistedAppState(writeCurrent.mock.calls[1]![0]);
    expect(persisted.settings).toMatchObject({
      appearancePreference: 'light',
      showToolCalls: false,
      workspaceChatLimit: 10,
    });
  });

  it('exposes typed write failures and retries the latest state', async () => {
    const writeCurrent = jest
      .fn<Promise<void>, [string]>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    const store = createAppStateStore(createPersistence({ writeCurrent }));
    await store.initialize();

    store.dispatch({ type: 'settings/update', patch: { showToolCalls: false } });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getSnapshot().persistenceError).toMatchObject({
      code: 'write_failed',
      operation: 'write',
    });
    await store.retryPersistence();
    expect(store.getSnapshot().persistenceError).toBeNull();
    expect(parsePersistedAppState(writeCurrent.mock.calls[1]![0]).settings.showToolCalls).toBe(
      false
    );
  });

  it('does not publish a profile switch until that exact state is durable', async () => {
    const initial = importLegacyAppState({
      settingsRaw: null,
      bridgeProfilesRaw: JSON.stringify({
        activeProfileId: 'one',
        profiles: [
          { id: 'one', name: 'One', bridgeUrl: 'http://10.0.0.1:8787', bridgeToken: 'a' },
          { id: 'two', name: 'Two', bridgeUrl: 'http://10.0.0.2:8787', bridgeToken: 'b' },
        ],
      }),
    });
    let releaseSwitch!: () => void;
    const switchWrite = new Promise<void>((resolve) => {
      releaseSwitch = resolve;
    });
    const writeCurrent = jest.fn<Promise<void>, [string]>().mockReturnValue(switchWrite);
    const store = createAppStateStore(
      createPersistence({
        readCurrent: jest.fn().mockResolvedValue(serializeAppState(initial)),
        writeCurrent,
      })
    );
    await store.initialize();

    const switching = store.dispatchDurable({ type: 'profiles/switch', profileId: 'two' });
    await Promise.resolve();
    store.dispatch({ type: 'settings/update', patch: { showToolCalls: false } });
    expect(store.getSnapshot().data.bridgeProfiles.activeProfileId).toBe('one');

    releaseSwitch();
    await switching;
    expect(store.getSnapshot().data.bridgeProfiles.activeProfileId).toBe('two');
    expect(store.getSnapshot().data.settings.showToolCalls).toBe(false);
  });
});
