import {
  AppStatePersistenceError,
  AppStateStore,
  appStateReducer,
  createDefaultAppStateData,
  importLegacyAppState,
  parsePersistedAppState,
  serializeAppState,
  type AppStatePersistenceAdapter,
} from '../appState';

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