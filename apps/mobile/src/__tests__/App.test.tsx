/* eslint-disable @typescript-eslint/consistent-type-imports, @typescript-eslint/no-require-imports -- Jest factories require hoist-safe module access. */
import { AppState, BackHandler, type AppStateStatus } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppStatePersistenceError, type AppStateSnapshot } from '../appState';

const mockScreenProps: Record<string, Record<string, unknown>> = {};
const mockWsInstances: Array<Record<string, unknown>> = [];
const mockApiInstances: Array<Record<string, unknown>> = [];
const mockStoreListeners = new Set<() => void>();
const mockPushControllers: Array<Record<string, jest.Mock>> = [];
const mockWsStatusListeners: Array<(connected: boolean) => void> = [];
const mockAppStateListeners: Array<(state: AppStateStatus) => void> = [];
const mockNotificationResponseListeners: Array<(event: unknown) => void> = [];
const mockGestures: Array<Record<string, (...args: unknown[]) => unknown>> = [];
const mockLoadChatSnapshotCache = jest.fn().mockResolvedValue(null);
const mockSaveChatSnapshotCache = jest.fn().mockResolvedValue(undefined);
const mockDeleteChatSnapshotCache = jest.fn().mockResolvedValue(undefined);
const mockSyncPushRegistration = jest.fn().mockResolvedValue(undefined);
const mockGetInitialNotificationResponse = jest.fn().mockResolvedValue(null);
const mockIsAutoStoreReviewEligible = jest.fn().mockReturnValue(false);
const mockLoadAutoStoreReviewState = jest.fn().mockResolvedValue({
  accumulatedForegroundMs: 0,
  automaticRequestAt: '2026-07-20T00:00:00.000Z',
});
const mockRequestNativeStoreReview = jest.fn().mockResolvedValue(false);
const mockSaveAutoStoreReviewState = jest.fn().mockResolvedValue(undefined);
const mockStore = {
  initialize: jest.fn().mockResolvedValue(undefined),
  subscribe: jest.fn((listener: () => void) => {
    mockStoreListeners.add(listener);
    return () => mockStoreListeners.delete(listener);
  }),
  getSnapshot: jest.fn(() => mockSnapshot),
  dispatch: jest.fn(),
  dispatchDurable: jest.fn(),
  retryPersistence: jest.fn().mockResolvedValue(undefined),
};

let mockSnapshot: AppStateSnapshot;
let mockFonts: [boolean, Error | null] = [true, null];
let mockBackHandler: (() => boolean | null | undefined) | null = null;
let previousAppState: typeof AppState.currentState;
let mockSpringFinished = true;

jest.mock('expo-font', () => ({ useFonts: () => mockFonts }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return {
    ...actual,
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 47, left: 0, right: 0, bottom: 34 },
    },
  };
});
jest.mock('react-native-reanimated', () => {
  const View = require('react-native').View;
  const transition = { duration: () => transition, easing: () => transition };
  return {
    __esModule: true,
    default: { View },
    cancelAnimation: jest.fn(),
    Easing: { out: (value: unknown) => value, cubic: 'cubic' },
    LinearTransition: transition,
    runOnJS: (callback: (...args: unknown[]) => unknown) => callback,
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useSharedValue: (value: unknown) => ({ value }),
    withSpring: (value: unknown, _config: unknown, callback?: (finished: boolean) => void) => {
      callback?.(mockSpringFinished);
      return value;
    },
  };
});
jest.mock('react-native-gesture-handler', () => {
  const View = require('react-native').View;
  const createGesture = () => {
    const callbacks: Record<string, (...args: unknown[]) => unknown> = {};
    const gesture = new Proxy(callbacks, {
      get: (target, property: string) => (...args: unknown[]) => {
        if (property.startsWith('on') && typeof args[0] === 'function') target[property] = args[0] as (...args: unknown[]) => unknown;
        return gesture;
      },
    });
    mockGestures.push(callbacks);
    return gesture;
  };
  return {
    Gesture: { Pan: createGesture, Tap: createGesture },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
    GestureHandlerRootView: View,
  };
});
jest.mock('../appState', () => ({
  AppStatePersistenceError: class extends Error {
    readonly code: 'read_failed' | 'invalid_data' | 'write_failed';
    readonly operation: 'load' | 'import' | 'write';
    readonly cause: unknown;

    constructor(
      code: 'read_failed' | 'invalid_data' | 'write_failed',
      operation: 'load' | 'import' | 'write',
      message: string,
      cause?: unknown
    ) {
      super(message);
      this.name = 'AppStatePersistenceError';
      this.code = code;
      this.operation = operation;
      this.cause = cause;
    }
  },
  createAppStateStore: () => mockStore,
}));
jest.mock('../appStatePersistence', () => ({ createAppStatePersistence: () => ({}) }));
jest.mock('../api/ws', () => ({
  HostBridgeWsClient: class {
    isConnected = true;
    connect = jest.fn();
    disconnect = jest.fn();
    onStatus = jest.fn((listener: (connected: boolean) => void) => {
      mockWsStatusListeners.push(listener);
      return jest.fn();
    });
    mockUrl: string;
    mockOptions: unknown;
    constructor(mockUrl: string, mockOptions: unknown) {
      this.mockUrl = mockUrl;
      this.mockOptions = mockOptions;
      mockWsInstances.push(this as unknown as Record<string, unknown>);
    }
  },
}));
jest.mock('../api/client', () => ({
  HostBridgeApiClient: class {
    primeChats = jest.fn().mockResolvedValue([]);
    peekChatShell = jest.fn().mockReturnValue(null);
    rememberChat = jest.fn();
    mockOptions: unknown;
    constructor(mockOptions: unknown) {
      this.mockOptions = mockOptions;
      mockApiInstances.push(this as unknown as Record<string, unknown>);
    }
  },
}));
jest.mock('../appWebSocketLifecycle', () => ({ bindAppWebSocketLifecycle: jest.fn().mockReturnValue(jest.fn()) }));
jest.mock('../chatSnapshotCache', () => ({
  createEmptyChatSnapshotCache: (profileId: string) => ({ version: 1, profileId, selectedChatId: null, entries: [] }),
  deleteChatSnapshotCache: (...args: unknown[]) => mockDeleteChatSnapshotCache(...args),
  loadChatSnapshotCache: (...args: unknown[]) => mockLoadChatSnapshotCache(...args),
  saveChatSnapshotCache: (...args: unknown[]) => mockSaveChatSnapshotCache(...args),
  updateChatSnapshotCache: (cache: unknown, selectedChatId: string | null, chat: unknown) => ({
    ...(cache as object), selectedChatId, entries: chat ? [{ chat }] : [],
  }),
}));
jest.mock('../pushNotifications', () => ({
  setupNotificationHandler: jest.fn(),
  registerNotificationCategories: jest.fn().mockResolvedValue(undefined),
  addNotificationResponseListener: jest.fn((listener: (event: unknown) => void) => {
    mockNotificationResponseListeners.push(listener);
    return { remove: jest.fn() };
  }),
  getInitialNotificationResponse: (...args: unknown[]) => mockGetInitialNotificationResponse(...args),
}));
jest.mock('../pushController', () => ({
  syncPushRegistration: (...args: unknown[]) => mockSyncPushRegistration(...args),
}));
jest.mock('../pushResponseController', () => ({
  PushResponseController: class {
    handle = jest.fn();
    setProfile = jest.fn();
    dispose = jest.fn();
    navigate: jest.Mock;
    constructor(mockCallback: jest.Mock) {
      this.navigate = mockCallback;
      mockPushControllers.push(this as unknown as Record<string, jest.Mock>);
    }
  },
}));
jest.mock('../storeReview', () => ({
  AUTO_STORE_REVIEW_THRESHOLD_MS: 600_000,
  createDefaultAutoStoreReviewState: () => ({ accumulatedForegroundMs: 0, automaticRequestAt: null }),
  isAutoStoreReviewEligible: (...args: unknown[]) => mockIsAutoStoreReviewEligible(...args),
  loadAutoStoreReviewState: (...args: unknown[]) => mockLoadAutoStoreReviewState(...args),
  requestNativeStoreReview: (...args: unknown[]) => mockRequestNativeStoreReview(...args),
  saveAutoStoreReviewState: (...args: unknown[]) => mockSaveAutoStoreReviewState(...args),
}));
jest.mock('../config', () => ({
  env: {
    hostBridgeToken: 'env-token',
    legacyHostBridgeUrl: 'http://legacy:3001',
    allowWsQueryTokenAuth: false,
    allowInsecureRemoteBridge: false,
    privacyPolicyUrl: 'https://example.com/privacy',
    termsOfServiceUrl: 'https://example.com/terms',
  },
}));

function mockScreen(name: string, refMethods?: Record<string, jest.Mock>) {
  const React = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const Component = React.forwardRef(function MockScreen(props: Record<string, unknown>, ref) {
    mockScreenProps[name] = props;
    React.useImperativeHandle(ref, () => refMethods ?? {});
    return React.createElement(View, { testID: name });
  });
  return { [name]: Component };
}

const mockStartNewChat = jest.fn();
const mockBrowserBack = jest.fn().mockReturnValue(false);
jest.mock('../screens/MainScreen', () => {
  const React = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  return {
    MainScreen: React.forwardRef(function MockMainScreen(props: Record<string, unknown>, ref) {
      mockScreenProps.MainScreen = props;
      React.useImperativeHandle(ref, () => ({ startNewChat: mockStartNewChat, openChat: jest.fn() }));
      return React.createElement(View, { testID: 'MainScreen' });
    }),
  };
});
jest.mock('../screens/BrowserScreen', () => {
  const React = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  return {
    BrowserScreen: React.forwardRef(function MockBrowserScreen(props: Record<string, unknown>, ref) {
      mockScreenProps.BrowserScreen = props;
      React.useImperativeHandle(ref, () => ({ handleHardwareBackPress: mockBrowserBack }));
      return React.createElement(View, { testID: 'BrowserScreen' });
    }),
  };
});
jest.mock('../screens/GitScreen', () => mockScreen('GitScreen'));
jest.mock('../screens/OnboardingScreen', () => mockScreen('OnboardingScreen'));
jest.mock('../screens/PrivacyScreen', () => mockScreen('PrivacyScreen'));
jest.mock('../screens/SettingsScreen', () => mockScreen('SettingsScreen'));
jest.mock('../screens/TermsScreen', () => mockScreen('TermsScreen'));
jest.mock('../navigation/DrawerContent', () => mockScreen('DrawerContent'));

import App from '../../App';

type Queryable = ReactTestInstance & {
  children: unknown[];
  parent: Queryable | null;
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

const profile = {
  id: 'profile-1',
  name: 'Local bridge',
  bridgeUrl: 'http://127.0.0.1:3001',
  bridgeToken: 'profile-token',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
};

function snapshot(options: {
  loaded?: boolean;
  profiles?: typeof profile[];
  activeProfileId?: string | null;
  persistenceError?: AppStateSnapshot['persistenceError'];
  settings?: Partial<AppStateSnapshot['data']['settings']>;
  registrations?: AppStateSnapshot['data']['push']['registrations'];
} = {}): AppStateSnapshot {
  return {
    loaded: options.loaded ?? true,
    persistenceError: options.persistenceError ?? null,
    data: {
      settings: {
        defaultStartCwd: null,
        preferredAgentId: 'codex',
        agentSettings: {},
        approvalMode: 'normal',
        showToolCalls: true,
        workspaceChatLimit: 5,
        appearancePreference: 'system',
        darkUiPalette: 'classic',
        fontPreference: 'system',
        recentBrowserTargetUrls: [],
        ...options.settings,
      },
      bridgeProfiles: {
        activeProfileId: options.activeProfileId === undefined ? profile.id : options.activeProfileId,
        profiles: options.profiles ?? [profile],
      },
      push: {
        optedOut: false,
        events: { turnCompleted: true, approvalRequested: true },
        registrations: options.registrations ?? [],
      },
    },
  };
}

async function renderApp(): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(<App />);
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!tree) throw new Error('Expected App tree');
  return tree;
}

async function callProp(screen: string, prop: string, ...args: unknown[]): Promise<void> {
  const callback = mockScreenProps[screen]?.[prop];
  if (typeof callback !== 'function') throw new Error(`Missing ${screen}.${prop}`);
  await act(async () => {
    await callback(...args);
    await Promise.resolve();
  });
}

async function flushTimers(ms = 0): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function settleEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('App orchestration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSnapshot = snapshot();
    mockFonts = [true, null];
    mockSpringFinished = true;
    mockBackHandler = null;
    mockScreenProps.MainScreen = {};
    mockScreenProps.SettingsScreen = {};
    mockScreenProps.OnboardingScreen = {};
    mockWsInstances.length = 0;
    mockApiInstances.length = 0;
    mockPushControllers.length = 0;
    mockWsStatusListeners.length = 0;
    mockAppStateListeners.length = 0;
    mockNotificationResponseListeners.length = 0;
    mockGestures.length = 0;
    jest.clearAllMocks();
    jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1 });
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, callback) => {
      mockBackHandler = callback;
      return { remove: jest.fn() };
    });
    previousAppState = AppState.currentState;
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active', writable: true });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      mockAppStateListeners.push(listener);
      return {
        remove: jest.fn(() => {
          const listenerIndex = mockAppStateListeners.indexOf(listener);
          if (listenerIndex >= 0) mockAppStateListeners.splice(listenerIndex, 1);
        }),
      };
    });
  });

  afterEach(() => {
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: previousAppState, writable: true });
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('renders font/state loading and persistence recovery branches', async () => {
    mockSnapshot = snapshot({ loaded: false });
    const loading = await renderApp();
    expect((loading.root as Queryable).findAll((node) => node.props.accessibilityLabel === 'Loading TetherCode').length).toBeGreaterThan(0);
    act(() => loading.unmount());

    mockSnapshot = snapshot({
      persistenceError: new AppStatePersistenceError('read_failed', 'load', 'secure storage unavailable'),
    });
    const recovery = await renderApp();
    expect((recovery.root as Queryable).findAll((node) => node.children.includes('secure storage unavailable'))).toHaveLength(1);
    const retryText = (recovery.root as Queryable).findAll((node) => node.children.includes('Retry'))[0];
    let retry = retryText as Queryable | null;
    while (retry && typeof retry.props.onPress !== 'function') retry = retry.parent as Queryable | null;
    await act(async () => (retry?.props.onPress as () => Promise<void>)());
    expect(mockStore.retryPersistence).toHaveBeenCalled();
    act(() => recovery.unmount());
  });

  it('waits for fonts but proceeds with fallback fonts after a font error', async () => {
    mockFonts = [false, null];
    const waiting = await renderApp();
    expect((waiting.root as Queryable).findAll((node) => node.props.accessibilityLabel === 'Loading TetherCode').length).toBeGreaterThan(0);
    act(() => waiting.unmount());

    mockFonts = [false, new Error('font download failed')];
    const fallback = await renderApp();
    expect(mockScreenProps.MainScreen.bridgeProfileId).toBe(profile.id);
    act(() => fallback.unmount());
  });

  it('restores the selected cached chat and persists subsequent context', async () => {
    const cachedChat = {
      id: 'cached', title: 'Cached', status: 'complete', createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z', statusUpdatedAt: '2026-07-20T00:00:00.000Z',
      lastMessagePreview: 'ready', messages: [{ id: 'message-1', role: 'assistant', content: 'ready' }],
    };
    mockLoadChatSnapshotCache.mockResolvedValueOnce({
      version: 1, profileId: profile.id, selectedChatId: cachedChat.id, entries: [{ chat: cachedChat }],
    });
    const tree = await renderApp();
    expect(mockScreenProps.MainScreen.pendingOpenChatId).toBe(cachedChat.id);
    expect(mockScreenProps.MainScreen.pendingOpenChatSnapshot).toEqual(cachedChat);
    expect(mockApiInstances[0].rememberChat).toHaveBeenCalledWith(cachedChat);
    await callProp('MainScreen', 'onPendingOpenChatHandled');
    await callProp('MainScreen', 'onChatContextChange', cachedChat);
    await flushTimers(250);
    expect(mockSaveChatSnapshotCache).toHaveBeenCalledWith(expect.objectContaining({ selectedChatId: cachedChat.id }));
    act(() => tree.unmount());
  });

  it('uses profile and environment tokens in client options', async () => {
    const withProfileToken = await renderApp();
    expect(mockWsInstances[0].mockOptions).toEqual({ authToken: 'profile-token', allowQueryTokenAuth: false });
    expect(mockApiInstances[0].mockOptions).toEqual(expect.objectContaining({ authToken: 'profile-token', bridgeUrl: profile.bridgeUrl }));
    act(() => withProfileToken.unmount());

    mockSnapshot = snapshot({ profiles: [{ ...profile, bridgeToken: null as unknown as string }] });
    const withEnvironmentToken = await renderApp();
    expect(mockWsInstances.at(-1)?.mockOptions).toEqual({ authToken: 'env-token', allowQueryTokenAuth: false });
    expect(mockApiInstances.at(-1)?.mockOptions).toEqual(expect.objectContaining({ authToken: 'env-token' }));
    act(() => withEnvironmentToken.unmount());
  });

  it('dispatches every settings and browser persistence callback', async () => {
    mockSnapshot = snapshot({ settings: { recentBrowserTargetUrls: ['http://recent:5173'] } });
    const tree = await renderApp();
    await callProp('DrawerContent', 'onNavigate', 'Settings');
    const updates: Array<[string, unknown]> = [
      ['onApprovalModeChange', 'plan'],
      ['onShowToolCallsChange', false],
      ['onWorkspaceChatLimitChange', 12],
      ['onAppearancePreferenceChange', 'dark'],
      ['onDarkUiPaletteChange', 'graphite'],
      ['onFontPreferenceChange', 'mono'],
    ];
    for (const [callback, value] of updates) await callProp('SettingsScreen', callback, value);
    await callProp('SettingsScreen', 'onRetryPersistence');
    await callProp('SettingsScreen', 'onDrawerGestureEnabledChange', false);
    await callProp('SettingsScreen', 'onOpenDrawer');
    act(() => expect(mockBackHandler?.()).toBe(true));
    await callProp('DrawerContent', 'onNavigate', 'Browser');
    expect(mockScreenProps.BrowserScreen.recentTargetUrls).toEqual(['http://recent:5173']);
    await callProp('BrowserScreen', 'onRecentTargetUrlsChange', ['http://next:5173']);
    await callProp('BrowserScreen', 'onPendingTargetHandled');
    expect(mockStore.dispatch).toHaveBeenCalledTimes(updates.length + 1);
    expect(mockStore.retryPersistence).toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('continues after write persistence errors and initialization failures', async () => {
    mockSnapshot = snapshot({
      persistenceError: new AppStatePersistenceError('write_failed', 'write', 'write failed'),
    });
    mockStore.initialize.mockRejectedValueOnce(new Error('load failed'));
    const tree = await renderApp();
    expect(mockScreenProps.MainScreen.bridgeProfileId).toBe(profile.id);
    act(() => tree.unmount());
  });

  it('routes no-profile state to initial onboarding and saves normalized credentials', async () => {
    mockSnapshot = snapshot({ profiles: [], activeProfileId: null });
    mockStore.dispatchDurable.mockResolvedValueOnce({ bridgeProfiles: { activeProfileId: profile.id, profiles: [profile] } });
    const tree = await renderApp();
    expect(mockScreenProps.OnboardingScreen.mode).toBe('initial');
    expect(mockScreenProps.OnboardingScreen.initialBridgeUrl).toBe('http://legacy:3001');
    await expect(callProp('OnboardingScreen', 'onSave', { bridgeUrl: ' http://127.0.0.1:3001 ', bridgeToken: ' token ' })).resolves.toBeUndefined();
    expect(mockStore.dispatchDurable).toHaveBeenCalledWith(expect.objectContaining({ type: 'profiles/save' }));
    act(() => tree.unmount());
  });

  it('rejects incomplete onboarding credentials and adds a profile', async () => {
    mockSnapshot = snapshot({ profiles: [], activeProfileId: null });
    const tree = await renderApp();
    await expect(callProp('OnboardingScreen', 'onSave', { bridgeUrl: '', bridgeToken: 'token' })).rejects.toThrow('required');
    await expect(callProp('OnboardingScreen', 'onSave', { bridgeUrl: profile.bridgeUrl, bridgeToken: ' ' })).rejects.toThrow('required');
    mockStore.dispatchDurable.mockResolvedValueOnce({ bridgeProfiles: { activeProfileId: profile.id, profiles: [profile] } });
    await callProp('OnboardingScreen', 'onSave', { bridgeUrl: profile.bridgeUrl, bridgeToken: profile.bridgeToken });
    expect(mockLoadChatSnapshotCache).toHaveBeenCalledWith(profile.id);
    expect(mockScreenProps.OnboardingScreen.onCancel).toBeUndefined();
    act(() => tree.unmount());
  });

  it('adds and edits profiles with changed and unchanged bridge identities', async () => {
    const tree = await renderApp();
    await callProp('DrawerContent', 'onNavigate', 'Settings');
    await callProp('SettingsScreen', 'onAddBridgeProfile');
    expect(mockScreenProps.OnboardingScreen).toEqual(expect.objectContaining({ mode: 'add', initialBridgeUrl: '', initialBridgeToken: '' }));
    mockStore.dispatchDurable.mockResolvedValueOnce({ bridgeProfiles: { activeProfileId: profile.id, profiles: [profile] } });
    await callProp('OnboardingScreen', 'onSave', { bridgeUrl: profile.bridgeUrl, bridgeToken: profile.bridgeToken });

    await callProp('DrawerContent', 'onNavigate', 'Settings');
    await callProp('SettingsScreen', 'onEditBridgeProfile');
    expect(mockScreenProps.OnboardingScreen).toEqual(expect.objectContaining({
      mode: 'edit', initialBridgeUrl: profile.bridgeUrl, initialBridgeToken: profile.bridgeToken,
    }));
    mockStore.dispatchDurable.mockResolvedValueOnce({ bridgeProfiles: { activeProfileId: profile.id, profiles: [profile] } });
    await callProp('OnboardingScreen', 'onSave', { bridgeUrl: 'http://changed:3001', bridgeToken: 'changed-token' });
    expect(mockDeleteChatSnapshotCache).toHaveBeenCalledWith(profile.id);

    await callProp('DrawerContent', 'onNavigate', 'Settings');
    await callProp('SettingsScreen', 'onEditBridgeProfile');
    mockStore.dispatchDurable.mockResolvedValueOnce({ bridgeProfiles: { activeProfileId: profile.id, profiles: [profile] } });
    await callProp('OnboardingScreen', 'onSave', { bridgeUrl: profile.bridgeUrl, bridgeToken: profile.bridgeToken });
    expect(mockLoadChatSnapshotCache).toHaveBeenCalledWith(profile.id);
    act(() => tree.unmount());
  });

  it('switches, renames, deletes, and clears bridge profiles', async () => {
    const secondProfile = { ...profile, id: 'profile-2', name: 'Remote bridge', bridgeUrl: 'https://bridge.example' };
    const switchedChat = {
      id: 'switched', title: 'Switched', status: 'complete', createdAt: profile.createdAt,
      updatedAt: profile.updatedAt, statusUpdatedAt: profile.updatedAt, lastMessagePreview: '', messages: [],
    };
    mockSnapshot = snapshot({ profiles: [profile, secondProfile] });
    const tree = await renderApp();
    await callProp('DrawerContent', 'onNavigate', 'Settings');
    mockLoadChatSnapshotCache.mockResolvedValueOnce({
      version: 1, profileId: secondProfile.id, selectedChatId: switchedChat.id, entries: [{ chat: switchedChat }],
    });
    mockStore.dispatchDurable.mockResolvedValueOnce({ bridgeProfiles: { activeProfileId: secondProfile.id, profiles: [profile, secondProfile] } });
    await callProp('SettingsScreen', 'onSwitchBridgeProfile', secondProfile.id);
    expect(mockStore.dispatchDurable).toHaveBeenCalledWith({ type: 'profiles/switch', profileId: secondProfile.id });
    await callProp('SettingsScreen', 'onRenameBridgeProfile', secondProfile.id, 'Renamed');
    expect(mockStore.dispatchDurable).toHaveBeenCalledWith({ type: 'profiles/rename', profileId: secondProfile.id, name: 'Renamed' });

    mockStore.dispatchDurable.mockResolvedValueOnce({ bridgeProfiles: { activeProfileId: profile.id, profiles: [profile] } });
    await callProp('SettingsScreen', 'onDeleteBridgeProfile', secondProfile.id);
    expect(mockDeleteChatSnapshotCache).toHaveBeenCalledWith(secondProfile.id);
    mockStore.dispatchDurable.mockResolvedValueOnce({ bridgeProfiles: { activeProfileId: null, profiles: [] } });
    await callProp('SettingsScreen', 'onDeleteBridgeProfile', profile.id);
    expect(mockScreenProps.OnboardingScreen.mode).toBe('initial');
    act(() => tree.unmount());

    mockSnapshot = snapshot({ profiles: [profile, secondProfile] });
    const clearTree = await renderApp();
    await callProp('DrawerContent', 'onNavigate', 'Settings');
    mockStore.dispatchDurable.mockResolvedValueOnce({ bridgeProfiles: { activeProfileId: null, profiles: [] } });
    await callProp('SettingsScreen', 'onClearSavedBridges');
    expect(mockDeleteChatSnapshotCache).toHaveBeenCalledWith(profile.id);
    expect(mockDeleteChatSnapshotCache).toHaveBeenCalledWith(secondProfile.id);
    expect(mockScreenProps.OnboardingScreen.mode).toBe('initial');
    act(() => clearTree.unmount());
  });

  it('constructs active clients and routes through all owned screens', async () => {
    const tree = await renderApp();
    expect(mockWsInstances[0]).toEqual(expect.objectContaining({ mockUrl: profile.bridgeUrl }));
    expect(mockScreenProps.MainScreen.bridgeProfileId).toBe(profile.id);
    expect(mockScreenProps.DrawerContent.selectedChatId).toBeNull();
    await callProp('DrawerContent', 'onNewChat');
    expect(mockStartNewChat).toHaveBeenCalled();

    await callProp('MainScreen', 'onOpenLocalPreview', '  http://127.0.0.1:5173  ');
    expect(mockScreenProps.BrowserScreen.pendingTargetUrl).toBe('http://127.0.0.1:5173');
    act(() => expect(mockBackHandler?.()).toBe(true));
    expect(mockScreenProps.MainScreen.bridgeProfileId).toBe(profile.id);

    await callProp('DrawerContent', 'onNavigate', 'Settings');
    expect(mockScreenProps.SettingsScreen.bridgeProfileName).toBe(profile.name);
    await callProp('SettingsScreen', 'onOpenPrivacy');
    expect(mockScreenProps.PrivacyScreen.policyUrl).toContain('privacy');
    act(() => expect(mockBackHandler?.()).toBe(true));
    await callProp('SettingsScreen', 'onOpenTerms');
    expect(mockScreenProps.TermsScreen.termsUrl).toContain('terms');
    act(() => expect(mockBackHandler?.()).toBe(true));
    act(() => tree.unmount());
  });

  it('selects current, empty, and hydrated chats through the drawer', async () => {
    const hydrated = {
      id: 'hydrated', title: 'Hydrated', status: 'complete', createdAt: profile.createdAt,
      updatedAt: profile.updatedAt, statusUpdatedAt: profile.updatedAt, lastMessagePreview: 'hello',
      messages: [{ id: 'm1', role: 'assistant', content: 'hello' }],
    };
    const tree = await renderApp();
    await callProp('MainScreen', 'onChatContextChange', hydrated);
    await callProp('DrawerContent', 'onSelectChat', hydrated.id);
    (mockApiInstances[0].peekChatShell as jest.Mock).mockReturnValueOnce(hydrated);
    await callProp('DrawerContent', 'onSelectChat', hydrated.id);
    await callProp('DrawerContent', 'onSelectChat', 'empty-shell');
    await flushTimers(250);
    expect(mockScreenProps.MainScreen.pendingOpenChatId).toBe('empty-shell');
    await callProp('MainScreen', 'onChatOpeningStateChange', null);
    await callProp('MainScreen', 'onChatContextChange', null);
    await callProp('MainScreen', 'onLastUsedThreadSettingsChange', 'codex', 'plan');
    expect(mockStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'settings/remember-thread' }));
    act(() => tree.unmount());
  });

  it('executes drawer gesture worklets across bounds and velocity decisions', async () => {
    const tree = await renderApp();
    const openGesture = mockGestures[1];
    const visibleGesture = mockGestures[2];
    const tapGesture = mockGestures[3];
    act(() => {
      openGesture.onStart?.();
      openGesture.onUpdate?.({ translationX: 500 });
      openGesture.onUpdate?.({ translationX: -500 });
      openGesture.onUpdate?.({ translationX: 120 });
      openGesture.onEnd?.({ translationX: 120, velocityX: 1000 });
      openGesture.onFinalize?.({ velocityX: 0 });
      visibleGesture.onStart?.();
      visibleGesture.onUpdate?.({ translationX: -500 });
      visibleGesture.onEnd?.({ translationX: -100, velocityX: -1000 });
      visibleGesture.onStart?.();
      visibleGesture.onFinalize?.({ velocityX: 1000 });
      tapGesture.onEnd?.({}, false);
      tapGesture.onEnd?.({}, true);
    });
    expect(mockScreenProps.DrawerContent.active).toBe(false);
    act(() => tree.unmount());
  });

  it('covers rejected and unfinished drawer gesture decisions', async () => {
    mockSpringFinished = false;
    const tree = await renderApp();
    const chatBackGesture = mockGestures[0];
    const openGesture = mockGestures[1];
    const visibleGesture = mockGestures[2];
    act(() => {
      chatBackGesture.onEnd?.({ translationX: 0, velocityX: 0 });
      chatBackGesture.onEnd?.({ translationX: 60, velocityX: 0 });
      openGesture.onStart?.();
      openGesture.onEnd?.({ translationX: 10, velocityX: 0 });
      openGesture.onStart?.();
      openGesture.onFinalize?.({ velocityX: -1000 });
      visibleGesture.onStart?.();
      visibleGesture.onEnd?.({ translationX: 100, velocityX: 1000 });
      visibleGesture.onStart?.();
      visibleGesture.onFinalize?.({ velocityX: -1000 });
    });
    act(() => tree.unmount());
  });

  it('toggles the tablet sidebar and suppresses phone drawer animation', async () => {
    jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 800, height: 1024, scale: 2, fontScale: 1 });
    const tree = await renderApp();
    expect(mockScreenProps.DrawerContent.active).toBe(true);
    await callProp('MainScreen', 'onOpenDrawer');
    await callProp('MainScreen', 'onOpenDrawer');
    act(() => expect(mockBackHandler?.()).toBe(false));
    act(() => tree.unmount());
  });

  it('opens Git, returns to chat, updates settings, and enters recovery onboarding', async () => {
    const tree = await renderApp();
    const chat = {
      id: 'thread-1', title: 'Thread', status: 'complete', createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z', statusUpdatedAt: '2026-07-20T00:00:00.000Z',
      lastMessagePreview: '', messages: [],
    };
    await callProp('MainScreen', 'onOpenGit', chat);
    expect(mockScreenProps.GitScreen.chat).toEqual(chat);
    await act(async () => {
      const callback = mockScreenProps.GitScreen.onBack as () => void;
      callback();
      jest.advanceTimersByTime(250);
      await Promise.resolve();
    });
    expect(mockScreenProps.MainScreen.pendingOpenChatId).toBe(chat.id);
    await callProp('MainScreen', 'onDefaultStartCwdChange', '/workspace');
    expect(mockStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'settings/update' }));
    await callProp('MainScreen', 'onOpenBridgeRecoveryGuide');
    expect(mockScreenProps.OnboardingScreen.mode).toBe('reconnect');
    expect(mockScreenProps.OnboardingScreen.onCancel).toEqual(expect.any(Function));
    await callProp('OnboardingScreen', 'onCancel');
    expect(mockScreenProps.MainScreen.bridgeProfileId).toBe(profile.id);
    act(() => tree.unmount());
  });

  it('handles drawer and hardware back from every routed screen', async () => {
    const tree = await renderApp();
    act(() => expect(mockBackHandler?.()).toBe(false));
    await callProp('MainScreen', 'onOpenDrawer');
    act(() => expect(mockBackHandler?.()).toBe(true));

    await callProp('DrawerContent', 'onNavigate', 'Settings');
    act(() => expect(mockBackHandler?.()).toBe(true));
    expect(mockScreenProps.MainScreen.bridgeProfileId).toBe(profile.id);
    await callProp('DrawerContent', 'onNavigate', 'Privacy');
    act(() => expect(mockBackHandler?.()).toBe(true));
    expect(mockScreenProps.SettingsScreen.bridgeProfileName).toBe(profile.name);
    await callProp('DrawerContent', 'onNavigate', 'Terms');
    act(() => expect(mockBackHandler?.()).toBe(true));

    await callProp('MainScreen', 'onOpenLocalPreview', null);
    mockBrowserBack.mockReturnValueOnce(true);
    act(() => expect(mockBackHandler?.()).toBe(true));
    expect(mockScreenProps.BrowserScreen.api).toBeDefined();
    mockBrowserBack.mockReturnValueOnce(false);
    act(() => expect(mockBackHandler?.()).toBe(true));

    const chat = {
      id: 'git-back', title: 'Git', status: 'complete', createdAt: profile.createdAt,
      updatedAt: profile.updatedAt, statusUpdatedAt: profile.updatedAt, lastMessagePreview: '', messages: [],
    };
    await callProp('MainScreen', 'onOpenGit', chat);
    act(() => expect(mockBackHandler?.()).toBe(true));
    await flushTimers(250);

    await callProp('MainScreen', 'onOpenBridgeRecoveryGuide');
    act(() => expect(mockBackHandler?.()).toBe(true));
    act(() => tree.unmount());

    mockSnapshot = snapshot({ profiles: [], activeProfileId: null });
    const initial = await renderApp();
    act(() => expect(mockBackHandler?.()).toBe(false));
    act(() => initial.unmount());
  });

  it('routes push responses, profile registration, websocket status, and app lifecycle', async () => {
    mockSnapshot = snapshot({
      registrations: [{ profileId: profile.id, registrationId: 'registration-1', token: null }],
    });
    const now = new Date('2026-07-20T12:00:00.000Z');
    jest.setSystemTime(now);
    const tree = await renderApp();
    expect(mockPushControllers[0].setProfile).toHaveBeenCalledWith(expect.objectContaining({
      profileId: profile.id, registrationId: 'registration-1',
    }));
    expect(mockSyncPushRegistration).toHaveBeenCalledWith(expect.anything(), mockStore, profile.id);
    await act(async () => {
      mockWsStatusListeners.forEach((listener) => listener(false));
      mockWsStatusListeners.forEach((listener) => listener(true));
      await Promise.resolve();
    });
    await flushTimers();
    expect((mockApiInstances[0].primeChats as jest.Mock)).toHaveBeenCalled();
    await act(async () => {
      mockPushControllers[0].navigate({ target: { threadId: 'push-thread' } });
      await Promise.resolve();
    });
    expect(mockScreenProps.MainScreen.pendingOpenChatId).toBe('push-thread');
    await act(async () => {
      mockNotificationResponseListeners[0]({ notification: 'tap' });
      jest.setSystemTime(new Date(now.getTime() + 1000));
      mockAppStateListeners[0]('background');
      jest.setSystemTime(new Date(now.getTime() + 2000));
      mockAppStateListeners[0]('active');
      await Promise.resolve();
    });
    expect(mockPushControllers[0].handle).toHaveBeenCalledWith({ notification: 'tap' });
    expect(mockSaveAutoStoreReviewState).toHaveBeenCalled();
    act(() => tree.unmount());
    expect(mockPushControllers[0].dispose).toHaveBeenCalled();
  });

  it('handles push retries, prefetch failures, and notifications without threads', async () => {
    mockSyncPushRegistration.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
    const tree = await renderApp();
    (mockApiInstances[0].primeChats as jest.Mock).mockRejectedValueOnce(new Error('prefetch failed'));
    await act(async () => {
      mockPushControllers[0].navigate({ target: {} });
      mockWsStatusListeners.forEach((listener) => listener(false));
      mockWsStatusListeners.forEach((listener) => listener(true));
      await Promise.resolve();
    });
    await flushTimers(1000);
    expect(mockPushControllers[0].setProfile).toHaveBeenCalledWith(null);
    expect(mockSyncPushRegistration.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockScreenProps.MainScreen.pendingOpenChatId).toBeNull();
    act(() => tree.unmount());
  });

  it('absorbs best-effort persistence failures', async () => {
    mockSaveAutoStoreReviewState.mockRejectedValueOnce(new Error('storage full'));
    const tree = await renderApp();
    jest.setSystemTime(new Date(Date.now() + 1000));
    await act(async () => {
      mockAppStateListeners[0]('background');
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => tree.unmount());
  });

  it('covers empty cache selections and active-profile replacement', async () => {
    const secondProfile = { ...profile, id: 'profile-2', name: 'Second' };
    mockSnapshot = snapshot({ profiles: [profile, secondProfile] });
    const tree = await renderApp();
    await callProp('DrawerContent', 'onNavigate', 'Settings');
    mockLoadChatSnapshotCache.mockResolvedValueOnce({
      version: 1, profileId: secondProfile.id, selectedChatId: 'missing', entries: [],
    });
    mockStore.dispatchDurable.mockResolvedValueOnce({ bridgeProfiles: { activeProfileId: secondProfile.id, profiles: [profile, secondProfile] } });
    await callProp('SettingsScreen', 'onSwitchBridgeProfile', secondProfile.id);
    mockLoadChatSnapshotCache.mockResolvedValueOnce(null);
    mockStore.dispatchDurable.mockResolvedValueOnce({ bridgeProfiles: { activeProfileId: secondProfile.id, profiles: [secondProfile] } });
    await callProp('SettingsScreen', 'onDeleteBridgeProfile', profile.id);
    expect(mockScreenProps.SettingsScreen.bridgeProfiles).toHaveLength(2);
    act(() => tree.unmount());
  });

  it('handles initial push responses and automatic review success, decline, and failure', async () => {
    mockGetInitialNotificationResponse.mockResolvedValueOnce({ notification: 'cold-start' });
    mockLoadAutoStoreReviewState.mockResolvedValueOnce({ accumulatedForegroundMs: 600_000, automaticRequestAt: null });
    mockIsAutoStoreReviewEligible.mockReturnValue(true);
    mockRequestNativeStoreReview.mockResolvedValueOnce(true);
    const success = await renderApp();
    await settleEffects();
    await flushTimers(600_000);
    await settleEffects();
    expect(mockPushControllers[0].handle).toHaveBeenCalledWith({ notification: 'cold-start' });
    expect(mockRequestNativeStoreReview).toHaveBeenCalled();
    expect(mockSaveAutoStoreReviewState).toHaveBeenCalledWith(expect.objectContaining({ automaticRequestAt: expect.any(String) }));
    act(() => success.unmount());

    mockLoadAutoStoreReviewState.mockResolvedValueOnce({ accumulatedForegroundMs: 600_000, automaticRequestAt: null });
    mockRequestNativeStoreReview.mockResolvedValueOnce(false);
    const declined = await renderApp();
    await settleEffects();
    await flushTimers(600_000);
    await settleEffects();
    expect(mockRequestNativeStoreReview).toHaveBeenCalledTimes(2);
    act(() => declined.unmount());

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockLoadAutoStoreReviewState.mockResolvedValueOnce({ accumulatedForegroundMs: 600_000, automaticRequestAt: null });
    mockRequestNativeStoreReview.mockRejectedValueOnce('native failure');
    const failed = await renderApp();
    await settleEffects();
    await flushTimers(600_000);
    await settleEffects();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('native failure'));
    act(() => failed.unmount());
  });
});