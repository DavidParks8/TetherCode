import { Switch } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { HostBridgeApiClient } from '../../api/client';
import type { BridgeCapabilities } from '../../api/types';
import type { AppStateAction, AppStateSnapshot, AppStateStore, PushSettingsState } from '../../appState';
import { AppStatePersistenceError, createDefaultAppStateData } from '../../appState';
import type { BridgeProfile } from '../../bridgeProfiles';
import { requestPushRegistration } from '../../pushNotifications';
import { AppThemeProvider, createAppTheme } from '../../theme';
import { SettingsScreen } from '../SettingsScreen';

jest.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => name }));
jest.mock('../../pushNotifications', () => ({ requestPushRegistration: jest.fn() }));

type Queryable = Omit<ReactTestInstance, 'children' | 'findAll' | 'parent' | 'props'> & {
  children: unknown[];
  props: Record<string, unknown>;
  parent: Queryable | null;
  type: unknown;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

type PressCallback = () => void;
type ToggleCallback = (value: boolean) => void;

const theme = createAppTheme('dark');
const requestRegistration = requestPushRegistration as jest.MockedFunction<typeof requestPushRegistration>;
const profiles: BridgeProfile[] = [
  { id: 'profile-1', name: 'Primary', bridgeUrl: 'http://127.0.0.1:3001', bridgeToken: 'one', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'profile-2', name: 'Secondary', bridgeUrl: 'http://127.0.0.1:3002', bridgeToken: 'two', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
];
const capabilities: BridgeCapabilities = {
  protocolVersion: 2,
  streamId: 'stream-1',
  preferredAgentId: 'codex',
  activeAgentId: 'codex',
  agents: [
    {
      agentId: 'codex', displayName: 'Codex', version: '1.2.3', provenance: 'managed',
      lifecycle: 'ready', lastError: null,
    },
    {
      agentId: 'offline', displayName: 'Offline agent', version: '0.1.0', provenance: 'local',
      lifecycle: 'unavailable', lastError: 'secret detail',
    },
  ],
  supportsByAgent: {},
  agUiEvents: true,
  supports: {
    reviewStart: true, turnSteer: true, commandOutputDelta: true, selfUpdate: true,
    browserPreview: true, genericUiSurface: true,
  },
};

function createStore(initial: Partial<PushSettingsState> = {}) {
  const data = createDefaultAppStateData();
  data.push = { ...data.push, ...initial };
  const dispatchDurable = jest.fn(async (action: AppStateAction) => {
    if (action.type === 'push/update') data.push = { ...data.push, ...action.patch };
    if (action.type === 'push/ensure-registration') {
      data.push.registrations.push({ profileId: action.profileId, registrationId: action.registrationId, token: null });
    }
    if (action.type === 'push/registered') {
      const registration = data.push.registrations.find((entry) => entry.profileId === action.profileId);
      if (registration) registration.token = action.token;
    }
    if (action.type === 'push/unregistered') {
      const registration = data.push.registrations.find((entry) => entry.profileId === action.profileId);
      if (registration) registration.token = null;
    }
    return data;
  });
  const snapshot: AppStateSnapshot = { loaded: true, data, persistenceError: null };
  const store = {
    getSnapshot: () => snapshot,
    dispatchDurable,
  } satisfies Pick<AppStateStore, 'dispatchDurable' | 'getSnapshot'>;
  return {
    data,
    dispatchDurable,
    store: store as unknown as AppStateStore,
  };
}

function hasText(root: Queryable, text: string): boolean {
  return root.findAll((node) => node.children.map(String).join('').includes(text)).length > 0;
}

function findPressableByText(root: Queryable, text: string): Queryable {
  const textNode = root.findAll((node) => node.children.map(String).join('') === text)[0];
  let current: Queryable | null = textNode ?? null;
  while (current && typeof current.props.onPress !== 'function') current = current.parent as Queryable | null;
  if (!current) throw new Error(`Missing pressable: ${text}`);
  return current;
}

function findToggle(root: Queryable, label: string): Queryable {
  const labelNode = root.findAll((node) => node.children.map(String).join('') === label)[0];
  let current: Queryable | null = labelNode ?? null;
  while (current) {
    const toggle = current.findAll((node) => node.type === Switch || typeof node.props.onValueChange === 'function')[0];
    if (toggle) return toggle;
    current = current.parent as Queryable | null;
  }
  throw new Error(`Missing toggle: ${label}`);
}

function getPressCallback(node: Queryable): PressCallback {
  const callback = node.props.onPress;
  if (typeof callback !== 'function') throw new Error('Expected onPress callback');
  return callback as PressCallback;
}

function getToggleCallback(node: Queryable): ToggleCallback {
  const callback = node.props.onValueChange;
  if (typeof callback !== 'function') throw new Error('Expected onValueChange callback');
  return callback as ToggleCallback;
}

async function press(node: Queryable): Promise<void> {
  await act(async () => {
    getPressCallback(node)();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function changeToggle(node: Queryable, value: boolean): Promise<void> {
  await act(async () => {
    getToggleCallback(node)(value);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderSettings(options: {
  api?: Record<string, jest.Mock>;
  activeBridgeProfileId?: string | null;
  pushSettings?: PushSettingsState;
  store?: ReturnType<typeof createStore>;
  workspaceChatLimit?: 5 | 10 | 25 | null;
  persistenceError?: AppStatePersistenceError | null;
  connected?: boolean;
  callbacks?: Record<string, jest.Mock>;
} = {}): Promise<{ tree: ReactTestRenderer; api: Record<string, jest.Mock>; store: ReturnType<typeof createStore>; callbacks: Record<string, jest.Mock> }> {
  const api = options.api ?? {
    readBridgeCapabilities: jest.fn().mockResolvedValue(capabilities),
    registerPushDevice: jest.fn().mockResolvedValue(undefined),
    unregisterPushDevice: jest.fn().mockResolvedValue(undefined),
  };
  const store = options.store ?? createStore({
    optedOut: false,
    registrations: [{ profileId: 'profile-1', registrationId: 'registration-1', token: 'old-token' }],
  });
  const callbacks = options.callbacks ?? {};
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
        <AppThemeProvider theme={theme}>
          <SettingsScreen
            api={api as unknown as HostBridgeApiClient}
            ws={{ isConnected: options.connected ?? true } as never}
            activeBridgeProfileId={options.activeBridgeProfileId === undefined ? 'profile-1' : options.activeBridgeProfileId}
            appStateStore={store.store}
            pushSettings={options.pushSettings ?? store.data.push}
            bridgeProfileName="Primary bridge"
            bridgeProfiles={profiles}
            workspaceChatLimit={options.workspaceChatLimit}
            persistenceError={options.persistenceError}
            onApprovalModeChange={callbacks.onApprovalModeChange}
            onShowToolCallsChange={callbacks.onShowToolCallsChange}
            onWorkspaceChatLimitChange={callbacks.onWorkspaceChatLimitChange}
            onEditBridgeProfile={callbacks.onEditBridgeProfile}
            onAddBridgeProfile={callbacks.onAddBridgeProfile}
            onSwitchBridgeProfile={callbacks.onSwitchBridgeProfile}
            onRetryPersistence={callbacks.onRetryPersistence}
            onOpenDrawer={callbacks.onOpenDrawer ?? jest.fn()}
            onDrawerGestureEnabledChange={callbacks.onDrawerGestureEnabledChange}
            onOpenPrivacy={callbacks.onOpenPrivacy ?? jest.fn()}
            onOpenTerms={callbacks.onOpenTerms ?? jest.fn()}
          />
        </AppThemeProvider>
      </SafeAreaProvider>
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!tree) throw new Error('Expected SettingsScreen tree');
  return { tree, api, store, callbacks };
}

describe('Secondary SettingsScreen behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    requestRegistration.mockResolvedValue({ token: 'new-token', platform: 'ios', deviceName: 'Phone' });
  });

  it('renders capabilities and drives settings, profile, legal, retry, and drawer actions', async () => {
    const callbacks = {
      onApprovalModeChange: jest.fn(), onShowToolCallsChange: jest.fn(),
      onWorkspaceChatLimitChange: jest.fn(), onEditBridgeProfile: jest.fn(),
      onAddBridgeProfile: jest.fn(), onSwitchBridgeProfile: jest.fn(),
      onRetryPersistence: jest.fn(), onOpenDrawer: jest.fn(),
      onOpenPrivacy: jest.fn(), onOpenTerms: jest.fn(),
      onDrawerGestureEnabledChange: jest.fn(),
    };
    const persistenceError = new AppStatePersistenceError('write_failed', 'write', 'save failed');
    const { tree } = await renderSettings({ callbacks, workspaceChatLimit: 5, persistenceError });
    const root = tree.root as Queryable;
    expect(hasText(root, 'Codex')).toBe(true);
    expect(hasText(root, 'Preferred · Active · ready · 1.2.3 · managed')).toBe(true);
    expect(hasText(root, 'Agent unavailable (details redacted)')).toBe(true);
    expect(callbacks.onDrawerGestureEnabledChange).toHaveBeenCalledWith(true);

    await changeToggle(findToggle(root, 'Require approvals'), false);
    await changeToggle(findToggle(root, 'Show tool calls'), false);
    await press(findPressableByText(root, 'Chats per workspace'));
    await press(findPressableByText(root, 'Primary bridge'));
    await press(findPressableByText(root, 'Add bridge'));
    await press(findPressableByText(root, 'Secondary'));
    await press(findPressableByText(root, 'Retry'));
    await press(findPressableByText(root, 'Privacy policy'));
    await press(findPressableByText(root, 'Terms of service'));
    const drawer = root.findAll((node) => node.props.accessibilityLabel === 'Open navigation drawer')[0];
    await press(drawer);

    expect(callbacks.onApprovalModeChange).toHaveBeenCalledWith('yolo');
    expect(callbacks.onShowToolCallsChange).toHaveBeenCalledWith(false);
    expect(callbacks.onWorkspaceChatLimitChange).toHaveBeenCalledWith(10);
    expect(callbacks.onEditBridgeProfile).toHaveBeenCalled();
    expect(callbacks.onAddBridgeProfile).toHaveBeenCalled();
    expect(callbacks.onSwitchBridgeProfile).toHaveBeenCalledWith('profile-2');
    expect(callbacks.onRetryPersistence).toHaveBeenCalled();
    expect(callbacks.onOpenPrivacy).toHaveBeenCalled();
    expect(callbacks.onOpenTerms).toHaveBeenCalled();
    expect(callbacks.onOpenDrawer).toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it.each([
    { current: 10 as const, next: 25 },
    { current: 25 as const, next: null },
    { current: null, next: 5 },
  ])('cycles workspace limit $current to $next', async ({ current, next }) => {
    const callbacks = { onWorkspaceChatLimitChange: jest.fn() };
    const { tree } = await renderSettings({ callbacks, workspaceChatLimit: current });
    await press(findPressableByText(tree.root as Queryable, 'Chats per workspace'));
    expect(callbacks.onWorkspaceChatLimitChange).toHaveBeenCalledWith(next);
    act(() => tree.unmount());
  });

  it('persists push enable, disable, and event changes through the real controller', async () => {
    const disabledStore = createStore({
      optedOut: true,
      registrations: [{ profileId: 'profile-1', registrationId: 'registration-1', token: 'old-token' }],
    });
    const enabled = await renderSettings({ store: disabledStore, pushSettings: disabledStore.data.push });
    await changeToggle(findToggle(enabled.tree.root as Queryable, 'Push notifications'), true);
    expect(enabled.api.registerPushDevice).toHaveBeenCalledWith(expect.objectContaining({ token: 'new-token' }));
    expect(disabledStore.dispatchDurable).toHaveBeenCalledWith({ type: 'push/update', patch: { optedOut: false } });
    act(() => enabled.tree.unmount());

    const activeStore = createStore({
      optedOut: false,
      registrations: [{ profileId: 'profile-1', registrationId: 'registration-1', token: 'old-token' }],
    });
    const active = await renderSettings({ store: activeStore, pushSettings: activeStore.data.push });
    const root = active.tree.root as Queryable;
    await changeToggle(findToggle(root, 'Push notifications'), false);
    expect(active.api.unregisterPushDevice).toHaveBeenCalled();
    await changeToggle(findToggle(root, 'Turn completed'), false);
    await changeToggle(findToggle(root, 'Approval requested'), false);
    expect(activeStore.dispatchDurable).toHaveBeenCalledWith(expect.objectContaining({
      type: 'push/update', patch: { events: { turnCompleted: true, approvalRequested: false } },
    }));
    act(() => active.tree.unmount());
  });

  it('shows empty and failed capability states, push errors, and ignores push changes without a profile', async () => {
    const empty = await renderSettings({ api: {
      readBridgeCapabilities: jest.fn().mockResolvedValue({ ...capabilities, agents: [] }),
      registerPushDevice: jest.fn(), unregisterPushDevice: jest.fn(),
    } });
    expect(hasText(empty.tree.root as Queryable, 'No agents reported by this bridge.')).toBe(true);
    act(() => empty.tree.unmount());

    const failed = await renderSettings({ api: {
      readBridgeCapabilities: jest.fn().mockRejectedValue(new Error('bridge offline')),
      registerPushDevice: jest.fn(), unregisterPushDevice: jest.fn(),
    }, connected: false });
    expect(hasText(failed.tree.root as Queryable, 'bridge offline')).toBe(true);
    expect(hasText(failed.tree.root as Queryable, 'Disconnected')).toBe(true);
    act(() => failed.tree.unmount());

    const unknownFailure = await renderSettings({ api: {
      readBridgeCapabilities: jest.fn().mockRejectedValue('offline'),
      registerPushDevice: jest.fn(), unregisterPushDevice: jest.fn(),
    } });
    expect(hasText(unknownFailure.tree.root as Queryable, 'Could not read bridge capabilities.')).toBe(true);
    act(() => unknownFailure.tree.unmount());

    const errorStore = createStore({ optedOut: true });
    errorStore.dispatchDurable.mockRejectedValueOnce('persist failed');
    const pushError = await renderSettings({ store: errorStore, pushSettings: errorStore.data.push });
    await changeToggle(findToggle(pushError.tree.root as Queryable, 'Push notifications'), true);
    expect(hasText(pushError.tree.root as Queryable, 'Could not update notifications.')).toBe(true);
    act(() => pushError.tree.unmount());

    const noProfileStore = createStore();
    const noProfile = await renderSettings({ activeBridgeProfileId: null, store: noProfileStore });
    await changeToggle(findToggle(noProfile.tree.root as Queryable, 'Push notifications'), true);
    await changeToggle(findToggle(noProfile.tree.root as Queryable, 'Turn completed'), false);
    expect(noProfileStore.dispatchDurable).not.toHaveBeenCalled();
    act(() => noProfile.tree.unmount());
  });
});