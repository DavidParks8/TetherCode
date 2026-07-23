import {
  APP_STATE_VERSION,
  AppStateStore,
  AppStatePersistenceError,
  appStateReducer,
  createAppStateStore,
  createDefaultAppStateData,
  importLegacyAppState,
  parsePersistedAppState,
  serializeAppState,
  type AppStatePersistenceAdapter,
} from './appState';

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

const profileDraft = {
  id: null,
  name: 'Local',
  bridgeUrl: 'http://127.0.0.1:3001',
  bridgeToken: 'token',
  activate: true,
};

function withProfile() {
  return appStateReducer(createDefaultAppStateData(), { type: 'profiles/save', draft: profileDraft });
}

function persistence(overrides: Partial<AppStatePersistenceAdapter> = {}): AppStatePersistenceAdapter {
  return {
    readCurrent: jest.fn().mockResolvedValue(null),
    readLegacy: jest.fn().mockResolvedValue({ settingsRaw: null, bridgeProfilesRaw: null }),
    writeCurrent: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('current appState production behavior', () => {
  it('reduces settings, profiles, remembered modes, and push registrations', () => {
    let state = withProfile();
    const profileId = state.bridgeProfiles.activeProfileId as string;
    state = appStateReducer(state, {
      type: 'settings/update',
      patch: { defaultStartCwd: ' /workspace ', showToolCalls: false, recentBrowserTargetUrls: ['3000', '3000'] },
    });
    expect(state.settings).toEqual(expect.objectContaining({ defaultStartCwd: '/workspace', showToolCalls: false }));
    expect(state.settings.recentBrowserTargetUrls).toEqual(['http://127.0.0.1:3000/']);
    state = appStateReducer(state, { type: 'settings/remember-thread', agentId: ' codex ', collaborationMode: 'plan' });
    expect(state.settings.preferredAgentId).toBe('codex');
    expect(state.settings.agentSettings.codex.collaborationMode).toBe('plan');
    expect(appStateReducer(state, { type: 'settings/remember-thread', agentId: ' ', collaborationMode: 'default' })).toBe(state);
    state = appStateReducer(state, { type: 'push/ensure-registration', profileId, registrationId: ' registration ' });
    state = appStateReducer(state, { type: 'push/ensure-registration', profileId, registrationId: 'ignored' });
    expect(state.push.registrations).toEqual([{ profileId, registrationId: 'registration', token: null }]);
    state = appStateReducer(state, { type: 'push/registered', profileId, registrationId: 'registration', token: ' push-token ' });
    expect(state.push.registrations[0].token).toBe('push-token');
    state = appStateReducer(state, { type: 'push/unregistered', profileId, registrationId: 'registration' });
    expect(state.push.registrations).toEqual([]);
    state = appStateReducer(state, { type: 'profiles/rename', profileId, name: 'Renamed' });
    state = appStateReducer(state, { type: 'profiles/remove', profileId });
    expect(state.bridgeProfiles.profiles).toEqual([]);
    expect(appStateReducer(withProfile(), { type: 'profiles/clear' }).bridgeProfiles.activeProfileId).toBeNull();
  });

  it('rejects invalid actions and clears registration on identity changes', () => {
    const state = withProfile();
    const profileId = state.bridgeProfiles.activeProfileId as string;
    expect(() => appStateReducer(state, { type: 'profiles/switch', profileId: 'missing' })).toThrow('no longer exists');
    expect(appStateReducer(state, { type: 'push/ensure-registration', profileId: 'missing', registrationId: 'id' })).toBe(state);
    expect(() => appStateReducer(state, { type: 'push/ensure-registration', profileId, registrationId: ' ' })).toThrow('registrationId');
    expect(() => appStateReducer(state, { type: 'push/registered', profileId, registrationId: 'missing', token: ' ' })).toThrow('token');
    const registered = appStateReducer(state, { type: 'push/ensure-registration', profileId, registrationId: 'id' });
    const changed = appStateReducer(registered, { type: 'profiles/save', draft: { ...profileDraft, id: profileId, bridgeUrl: 'http://127.0.0.1:4000' } });
    expect(changed.push.registrations).toEqual([]);
  });

  it('serializes supported versions, normalizes push data, and rejects corrupt state', () => {
    const state = withProfile();
    const profileId = state.bridgeProfiles.activeProfileId as string;
    const raw = serializeAppState({ ...state, push: { optedOut: true, events: { turnCompleted: false, approvalRequested: true }, registrations: [
      { profileId, registrationId: 'one', token: 'token' },
      { profileId, registrationId: 'duplicate-profile', token: null },
      { profileId: 'missing', registrationId: 'missing', token: null },
    ] } });
    expect(parsePersistedAppState(raw).push.registrations).toHaveLength(1);
    for (const version of [1, 2, 3]) expect(parsePersistedAppState(JSON.stringify({ ...JSON.parse(raw), version })).bridgeProfiles.profiles).toHaveLength(1);
    for (const rawValue of ['', '{}', '{bad', JSON.stringify({ version: 99 })]) expect(() => parsePersistedAppState(rawValue)).toThrow(AppStatePersistenceError);
  });

  it('imports legacy credentials and initializes current, legacy, and failed stores', async () => {
    const settingsRaw = JSON.stringify({ version: 13, bridgeUrl: 'http://127.0.0.1:3001', bridgeToken: 'token', defaultStartCwd: '/workspace' });
    expect(importLegacyAppState({ settingsRaw, bridgeProfilesRaw: null }).bridgeProfiles.profiles).toHaveLength(1);
    const current = withProfile();
    const currentStore = new AppStateStore(persistence({ readCurrent: jest.fn().mockResolvedValue(serializeAppState(current)) }));
    const listener = jest.fn();
    currentStore.subscribe(listener);
    await currentStore.initialize();
    expect(listener).toHaveBeenCalled();
    const legacyPersistence = persistence();
    await new AppStateStore(legacyPersistence).initialize();
    expect(legacyPersistence.writeCurrent).toHaveBeenCalled();
    for (const adapter of [persistence({ readCurrent: jest.fn().mockRejectedValue(new Error('read')) }), persistence({ readLegacy: jest.fn().mockRejectedValue(new Error('legacy')) })]) {
      const store = new AppStateStore(adapter);
      await store.initialize();
      expect(store.getSnapshot().persistenceError).toBeInstanceOf(AppStatePersistenceError);
    }
  });

  it('persists ordinary actions, retries failures, and rejects durable failures', async () => {
    const adapter = persistence();
    const store = new AppStateStore(adapter);
    expect(() => store.dispatch({ type: 'settings/update', patch: {} })).toThrow('has not loaded');
    await store.initialize();
    store.dispatch({ type: 'settings/update', patch: { showToolCalls: false } });
    await store.flushPersistence();
    expect(store.getSnapshot().data.settings.showToolCalls).toBe(false);
    (adapter.writeCurrent as jest.Mock).mockRejectedValueOnce(new Error('write failed'));
    store.dispatch({ type: 'settings/update', patch: { showToolCalls: true } });
    await expect(store.flushPersistence()).rejects.toBeInstanceOf(AppStatePersistenceError);
    (adapter.writeCurrent as jest.Mock).mockResolvedValue(undefined);
    await store.retryPersistence();
    expect(store.getSnapshot().persistenceError).toBeNull();
    (adapter.writeCurrent as jest.Mock).mockRejectedValueOnce(new Error('durable failed'));
    await expect(store.dispatchDurable({ type: 'profiles/save', draft: profileDraft })).rejects.toBeInstanceOf(AppStatePersistenceError);
  });
});

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
    expect(toolsChanged.settings.approvalMode).toBe('normal');
  });

  it('remembers agent collaboration settings without replacing other agents', () => {
    const state = appStateReducer(createDefaultAppStateData(), {
      type: 'settings/remember-thread',
      agentId: 'opencode',
      collaborationMode: 'plan',
    });

    expect(state.settings.preferredAgentId).toBe('opencode');
    expect(state.settings.agentSettings.opencode).toEqual({ collaborationMode: 'plan' });
    expect(state.settings.agentSettings.codex).toBeUndefined();
  });

  it('keeps push registration identity immutable per profile', () => {
    const withProfile = importLegacyAppState({
      settingsRaw: null,
      bridgeProfilesRaw: JSON.stringify({
        activeProfileId: 'profile-1',
        profiles: [
          {
            id: 'profile-1',
            name: 'One',
            bridgeUrl: 'http://10.0.0.1:8787',
            bridgeToken: 'token',
          },
        ],
      }),
    });
    const registered = appStateReducer(withProfile, {
      type: 'push/ensure-registration',
      profileId: 'profile-1',
      registrationId: 'registration-1',
    });
    const replacement = appStateReducer(registered, {
        type: 'push/ensure-registration',
        profileId: 'profile-1',
        registrationId: 'registration-2',
      });
    expect(replacement.push.registrations[0]?.registrationId).toBe('registration-1');
  });

  it('drops a registration when its profile bridge identity changes', () => {
    const withProfile = importLegacyAppState({
      settingsRaw: null,
      bridgeProfilesRaw: JSON.stringify({
        activeProfileId: 'profile-1',
        profiles: [
          {
            id: 'profile-1',
            name: 'One',
            bridgeUrl: 'http://10.0.0.1:8787',
            bridgeToken: 'token-1',
          },
        ],
      }),
    });
    const registered = appStateReducer(withProfile, {
      type: 'push/ensure-registration',
      profileId: 'profile-1',
      registrationId: 'registration-1',
    });
    const edited = appStateReducer(registered, {
      type: 'profiles/save',
      draft: {
        id: 'profile-1',
        bridgeUrl: 'http://10.0.0.2:8787',
        bridgeToken: 'token-2',
      },
    });
    expect(edited.push.registrations).toEqual([]);
  });

  it('supports profile rename, switch, removal, and clearing', () => {
    let state = appStateReducer(createDefaultAppStateData(), {
      type: 'profiles/save',
      draft: { bridgeUrl: 'http://one', bridgeToken: 'token' },
    });
    const profileId = state.bridgeProfiles.profiles[0]!.id;
    state = appStateReducer(state, { type: 'profiles/rename', profileId, name: 'Renamed' });
    expect(state.bridgeProfiles.profiles[0]?.name).toBe('Renamed');
    state = appStateReducer(state, { type: 'profiles/switch', profileId });
    expect(state.bridgeProfiles.activeProfileId).toBe(profileId);
    expect(() => appStateReducer(state, { type: 'profiles/switch', profileId: 'missing' })).toThrow(
      'no longer exists'
    );
    state = appStateReducer(state, { type: 'profiles/remove', profileId });
    expect(state.bridgeProfiles.profiles).toEqual([]);
    state = appStateReducer(state, { type: 'profiles/clear' });
    expect(state.bridgeProfiles.activeProfileId).toBeNull();
  });

  it('retains registrations when profile identity is unchanged', () => {
    let state = appStateReducer(createDefaultAppStateData(), {
      type: 'profiles/save',
      draft: { bridgeUrl: 'http://one', bridgeToken: 'token' },
    });
    const profileId = state.bridgeProfiles.profiles[0]!.id;
    state = appStateReducer(state, {
      type: 'push/ensure-registration', profileId, registrationId: 'registration',
    });
    const edited = appStateReducer(state, {
      type: 'profiles/save',
      draft: { id: profileId, name: 'New name', bridgeUrl: 'http://one/', bridgeToken: 'token' },
    });
    expect(edited.push).toBe(state.push);
  });

  it('normalizes remembered settings for each agent', () => {
    const state = appStateReducer(createDefaultAppStateData(), {
      type: 'settings/remember-thread',
      agentId: ' opencode ',
      collaborationMode: 'ask' as never,
    });
    expect(state.settings.agentSettings.opencode).toEqual({ collaborationMode: 'default' });
    const fallback = appStateReducer(state, {
      type: 'settings/remember-thread',
      agentId: 'codex',
      collaborationMode: 'plan',
    });
    expect(fallback.settings.preferredAgentId).toBe('codex');
    expect(fallback.settings.agentSettings).toEqual({
      opencode: { collaborationMode: 'default' },
      codex: { collaborationMode: 'plan' },
    });
  });

  it('manages push registrations and ignores stale updates', () => {
    let state = appStateReducer(createDefaultAppStateData(), {
      type: 'push/ensure-registration', profileId: 'missing', registrationId: 'registration',
    });
    expect(state).toBe(state);
    state = appStateReducer(state, {
      type: 'profiles/save', draft: { bridgeUrl: 'http://one', bridgeToken: 'token' },
    });
    const profileId = state.bridgeProfiles.profiles[0]!.id;
    expect(() => appStateReducer(state, {
      type: 'push/ensure-registration', profileId, registrationId: ' ',
    })).toThrow('registrationId');
    state = appStateReducer(state, {
      type: 'push/ensure-registration', profileId, registrationId: ' registration ',
    });
    expect(appStateReducer(state, {
      type: 'push/registered', profileId, registrationId: 'stale', token: 'token',
    })).toBe(state);
    expect(appStateReducer(state, {
      type: 'push/registered', profileId: 'missing', registrationId: 'registration', token: 'token',
    })).toBe(state);
    state = appStateReducer(state, {
      type: 'push/registered', profileId, registrationId: 'registration', token: ' push-token ',
    });
    expect(state.push.registrations[0]?.token).toBe('push-token');
    expect(() => appStateReducer(state, {
      type: 'push/registered', profileId, registrationId: 'registration', token: ' ',
    })).toThrow('token');
    state = appStateReducer(state, {
      type: 'push/unregistered', profileId: 'other', registrationId: 'registration',
    });
    expect(state.push.registrations).toHaveLength(1);
    state = appStateReducer(state, {
      type: 'push/unregistered', profileId, registrationId: 'registration',
    });
    expect(state.push.registrations).toEqual([]);
  });

  it('normalizes push preferences and malformed registrations', () => {
    const profileState = appStateReducer(createDefaultAppStateData(), {
      type: 'profiles/save', draft: { bridgeUrl: 'http://one', bridgeToken: 'token' },
    });
    const profileId = profileState.bridgeProfiles.profiles[0]!.id;
    const parsed = parsePersistedAppState(JSON.stringify({
      version: APP_STATE_VERSION,
      settings: null,
      bridgeProfiles: profileState.bridgeProfiles,
      push: {
        optedOut: true,
        events: { turnCompleted: false, approvalRequested: 'yes' },
        registrations: [
          null,
          {},
          { profileId: 'missing', registrationId: 'a' },
          { profileId, registrationId: 'one', token: 1 },
          { profileId, registrationId: 'two', token: 'duplicate-profile' },
          { profileId: 'missing', registrationId: 'one', token: 'duplicate-registration' },
        ],
      },
    }));
    expect(parsed.push).toEqual({
      optedOut: true,
      events: { turnCompleted: false, approvalRequested: true },
      registrations: [{ profileId, registrationId: 'one', token: null }],
    });
    const updated = appStateReducer(parsed, {
      type: 'push/update', patch: { optedOut: false, events: { turnCompleted: true, approvalRequested: false } },
    });
    expect(updated.push.events.approvalRequested).toBe(false);
  });
});

describe('app-state persistence format', () => {
  it('round-trips the current version', () => {
    const raw = serializeAppState(createDefaultAppStateData());
    expect(JSON.parse(raw).version).toBe(APP_STATE_VERSION);
    expect(parsePersistedAppState(raw)).toEqual(createDefaultAppStateData());
  });

  it('migrates version 1 while preserving only an explicit YOLO choice', () => {
    const base = createDefaultAppStateData();
    const explicitYolo = JSON.stringify({
      version: 1,
      settings: { ...base.settings, approvalMode: 'yolo' },
      bridgeProfiles: base.bridgeProfiles,
    });
    const invalidMode = JSON.stringify({
      version: 1,
      settings: { ...base.settings, approvalMode: 'unexpected' },
      bridgeProfiles: base.bridgeProfiles,
    });

    expect(parsePersistedAppState(explicitYolo).settings.approvalMode).toBe('yolo');
    expect(parsePersistedAppState(invalidMode).settings.approvalMode).toBe('normal');
  });

  it('rejects unknown versions without falling back and overwriting them', () => {
    expect(() => parsePersistedAppState('{"version":999}')).toThrow(
      AppStatePersistenceError
    );
  });

  it('rejects malformed JSON, null values, and missing versions with typed details', () => {
    for (const raw of ['{', 'null', '{}']) {
      try {
        parsePersistedAppState(raw);
        throw new Error('expected parse failure');
      } catch (error) {
        expect(error).toMatchObject({ code: 'invalid_data', operation: 'load' });
      }
    }
  });

  it('imports the currently persisted settings and bridge credentials', () => {
    const imported = importLegacyAppState({
      settingsRaw: JSON.stringify({
        version: 13,
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

  it('keeps existing profiles and does not create profiles from partial credentials', () => {
    const existing = importLegacyAppState({
      settingsRaw: JSON.stringify({ version: 12, bridgeUrl: 'http://new', bridgeToken: 'new' }),
      bridgeProfilesRaw: JSON.stringify({
        activeProfileId: 'old',
        profiles: [{ id: 'old', bridgeUrl: 'http://old', bridgeToken: 'old' }],
      }),
    });
    expect(existing.bridgeProfiles.profiles.map((profile) => profile.id)).toEqual(['old']);
    expect(importLegacyAppState({
      settingsRaw: JSON.stringify({ version: 12, bridgeUrl: 'http://new' }),
      bridgeProfilesRaw: null,
    }).bridgeProfiles.profiles).toEqual([]);
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

  it('loads once, publishes to subscribers, and supports unsubscribe', async () => {
    const persistence = createPersistence();
    const store = createAppStateStore(persistence);
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    expect(store.initialize()).toBe(store.initialize());
    await store.initialize();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.dispatch({ type: 'settings/update', patch: { showToolCalls: false } });
    expect(listener).toHaveBeenCalledTimes(1);
    await store.flushPersistence();
    expect(persistence.readCurrent).toHaveBeenCalledTimes(1);
  });

  it('rejects dispatch before initialization', () => {
    const store = createAppStateStore(createPersistence());
    expect(() => store.dispatch({ type: 'settings/update', patch: {} })).toThrow('not loaded');
  });

  it.each([
    ['current read', { readCurrent: jest.fn().mockRejectedValue(new Error('read')) }, 'load'],
    ['legacy read', {
      readCurrent: jest.fn().mockResolvedValue(null),
      readLegacy: jest.fn().mockRejectedValue(new Error('legacy')),
    }, 'import'],
    ['invalid current data', { readCurrent: jest.fn().mockResolvedValue('{') }, 'load'],
  ] as const)('exposes %s failures', async (_name, overrides, operation) => {
    const store = createAppStateStore(createPersistence(overrides));
    await store.initialize();
    expect(store.getSnapshot()).toMatchObject({
      loaded: true,
      persistenceError: { operation },
    });
  });

  it('retries initialization after an initial read failure', async () => {
    const readCurrent = jest.fn()
      .mockRejectedValueOnce(new Error('read'))
      .mockResolvedValueOnce(serializeAppState(createDefaultAppStateData()));
    const store = createAppStateStore(createPersistence({ readCurrent }));
    await store.initialize();
    await store.retryPersistence();
    expect(store.getSnapshot().persistenceError).toBeNull();
    expect(readCurrent).toHaveBeenCalledTimes(2);
  });

  it('publishes imported state when its initial write fails and retries it', async () => {
    const writeCurrent = jest.fn()
      .mockRejectedValueOnce(new Error('disk'))
      .mockResolvedValueOnce(undefined);
    const store = createAppStateStore(createPersistence({
      readCurrent: jest.fn().mockResolvedValue(null),
      writeCurrent,
    }));
    await store.initialize();
    expect(store.getSnapshot().persistenceError).toMatchObject({ operation: 'import' });
    await store.retryPersistence();
    expect(store.getSnapshot().persistenceError).toBeNull();
  });

  it('keeps durable state unchanged when its write fails', async () => {
    const writeCurrent = jest.fn().mockRejectedValue(new Error('disk'));
    const store = createAppStateStore(createPersistence({ writeCurrent }));
    await store.initialize();
    await expect(store.dispatchDurable({
      type: 'settings/update', patch: { showToolCalls: false },
    })).rejects.toMatchObject({ code: 'write_failed', operation: 'write' });
    expect(store.getSnapshot().data.settings.showToolCalls).toBe(true);
  });

  it('initializes automatically for a durable action', async () => {
    const store = createAppStateStore(createPersistence());
    const data = await store.dispatchDurable({
      type: 'settings/update', patch: { appearancePreference: 'dark' },
    });
    expect(data.settings.appearancePreference).toBe('dark');
  });
});
