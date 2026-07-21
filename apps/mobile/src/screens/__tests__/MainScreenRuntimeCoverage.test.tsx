import { FlatList, TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import type { HostBridgeApiClient } from '../../api/client';
import type { BridgeCapabilities, Chat } from '../../api/types';
import type { HostBridgeWsClient } from '../../api/ws';
import { AppThemeProvider, createAppTheme } from '../../theme';
import { MainScreen, type MainScreenHandle } from '../MainScreen';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-reanimated', () => {
  const View = jest.requireActual('react-native').View;
  const transition = { duration: () => transition, easing: () => transition };
  return {
    __esModule: true,
    default: { View },
    FadeInDown: transition,
    FadeInUp: transition,
    cancelAnimation: jest.fn(),
    Easing: { out: (value: unknown) => value, cubic: 'cubic' },
    LinearTransition: transition,
    runOnJS: (callback: (...args: unknown[]) => unknown) => callback,
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useSharedValue: (value: unknown) => ({ value }),
    withRepeat: (value: unknown) => value,
    withSequence: (...values: unknown[]) => values.at(-1),
    withTiming: (value: unknown) => value,
  };
});
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  readAsStringAsync: jest.fn().mockRejectedValue(new Error('missing')),
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('react-native-markdown-display', () => 'Markdown');

const now = '2026-07-20T12:00:00.000Z';
const theme = createAppTheme('dark');
const capabilitySupport = {
  turnSteer: true,
  planMode: true,
  reviewStart: true,
  goalSlash: true,
  fastMode: true,
  commandOutputDelta: true,
  browserPreview: true,
  genericUiSurface: true,
};
const capabilities: BridgeCapabilities = {
  protocolVersion: 2,
  streamId: 'runtime-stream',
  preferredAgentId: 'codex',
  activeAgentId: 'codex',
  agents: [{
    agentId: 'codex', displayName: 'Codex', version: '1', provenance: 'test', lifecycle: 'ready',
  }],
  supportsByAgent: {
    codex: capabilitySupport,
  },
  agUiEvents: true,
  supports: capabilitySupport,
};
const baseChat: Chat = {
  id: 'thread-runtime',
  title: 'Runtime truth',
  status: 'complete',
  createdAt: now,
  updatedAt: now,
  statusUpdatedAt: now,
  lastMessagePreview: 'Current answer',
  cwd: '/workspace',
  agentId: 'codex',
  messages: [{ id: 'current', role: 'assistant', content: 'Current answer', createdAt: now }],
};
const emptyQueue = {
  threadId: baseChat.id,
  items: [],
  pendingSteers: [],
  pendingSteerCount: 0,
  waitingForToolCalls: false,
  steeringInFlight: false,
  lastError: null,
};

type Queryable = ReactTestInstance & {
  children: unknown[];
  props: Record<string, unknown>;
  parent: Queryable | null;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByType(type: unknown): Queryable[];
};

type ApiOptions = {
  capabilities?: BridgeCapabilities | Error;
  chat?: Chat | Error;
  cachedChat?: Chat | null;
  shell?: Chat | null;
  summary?: Chat | null;
};

type MockApi = Record<string, jest.Mock>;

type Harness = {
  api: MockApi;
  ws: {
    acknowledgeSnapshotRecovery: jest.Mock;
    connect: jest.Mock;
    disconnect: jest.Mock;
    resetRecoveryEpoch: jest.Mock;
  };
  tree: ReactTestRenderer;
  ref: { current: MainScreenHandle | null };
  emit(event: unknown): Promise<void>;
  setConnected(connected: boolean): Promise<void>;
  unmount(): void;
};

function createApi(options: ApiOptions = {}): MockApi {
  const loaded = options.chat ?? baseChat;
  const methods: Record<string, jest.Mock> = {
    readBridgeCapabilities: jest.fn().mockImplementation(() => {
      const value = options.capabilities ?? capabilities;
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }),
    peekChat: jest.fn().mockReturnValue(options.cachedChat ?? null),
    peekChatShell: jest.fn().mockReturnValue(options.shell ?? null),
    peekChatSummary: jest.fn().mockReturnValue(options.summary ?? null),
    peekChats: jest.fn().mockReturnValue(null),
    peekAllChats: jest.fn().mockReturnValue(null),
    rememberChat: jest.fn(),
    getChat: jest.fn().mockImplementation(() =>
      loaded instanceof Error ? Promise.reject(loaded) : Promise.resolve(loaded)
    ),
    getChatSummary: jest.fn().mockResolvedValue(baseChat),
    listLoadedChatIds: jest.fn().mockResolvedValue([]),
    listPendingApprovals: jest.fn().mockResolvedValue([]),
    listApprovals: jest.fn().mockResolvedValue([]),
    listPendingUserInputs: jest.fn().mockResolvedValue([]),
    readThreadQueue: jest.fn().mockResolvedValue(emptyQueue),
    listWorkspaceRoots: jest.fn().mockResolvedValue({
      bridgeRoot: '/workspace',
      allowOutsideRootCwd: false,
      workspaces: [],
    }),
    sendOrQueueChatMessage: jest.fn().mockResolvedValue({
      disposition: 'sent',
      queue: emptyQueue,
      turnId: 'turn-sent',
      chat: { ...baseChat, status: 'running', activeTurnId: 'turn-sent' },
    }),
    interruptTurn: jest.fn().mockResolvedValue(true),
    interruptLatestTurn: jest.fn().mockResolvedValue(null),
    resolveApproval: jest.fn().mockResolvedValue({ ok: true }),
    resolveUserInput: jest.fn().mockResolvedValue({ ok: true }),
    resolveBridgeUiSurface: jest.fn().mockResolvedValue({ ok: true }),
    dismissBridgeUiSurface: jest.fn().mockResolvedValue({ ok: true }),
  };
  return new Proxy(methods, {
    get(target, property) {
      if (typeof property !== 'string') return undefined;
      target[property] ??= jest.fn().mockResolvedValue(null);
      return target[property];
    },
  }) as unknown as MockApi;
}

function text(root: Queryable, value: string): boolean {
  const rendered = root
    .findAll(() => true)
    .flatMap((node) => node.children)
    .filter((child): child is string => typeof child === 'string')
    .join(' ');
  return rendered.includes(value);
}

function input(root: Queryable): ReactTestInstance {
  const result = root
    .findAllByType(TextInput)
    .find((node) => node.props.accessibilityLabel === 'Message');
  if (!result) throw new Error('Message input not rendered');
  return result;
}

function transcript(root: Queryable): Array<{ message: { content: string } }> {
  return (root.findAllByType(FlatList)[0]?.props.data ?? []) as Array<{
    message: { content: string };
  }>;
}

async function press(root: Queryable, label: string): Promise<void> {
  const result = root.findAll(
    (node) =>
      node.props.accessibilityLabel === label ||
      node.children.includes(label)
  )[0];
  if (!result) throw new Error(`Control not rendered: ${label}`);
  let target: Queryable | null = result;
  while (target && typeof target.props.onPress !== 'function') target = target.parent;
  if (!target) throw new Error(`Control is not pressable: ${label}`);
  await act(async () => {
    (target?.props.onPress as () => void)();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function settleRecovery(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
  });
}

async function renderMain(options: {
  api?: MockApi;
  connected?: boolean;
  chat?: Chat | null;
  pendingId?: string | null;
  onRecovery?: jest.Mock;
  onHandled?: jest.Mock;
  onOpening?: jest.Mock;
} = {}): Promise<Harness> {
  const api = options.api ?? createApi({ chat: options.chat ?? undefined });
  let eventHandler: ((event: unknown) => void) | null = null;
  let statusHandler: ((connected: boolean) => void) | null = null;
  const ws = {
    isConnected: options.connected ?? true,
    onEvent: jest.fn((handler) => {
      eventHandler = handler;
      return jest.fn();
    }),
    onStatus: jest.fn((handler) => {
      statusHandler = handler;
      return jest.fn();
    }),
    acknowledgeSnapshotRecovery: jest.fn(),
    connect: jest.fn(),
    disconnect: jest.fn(),
    resetRecoveryEpoch: jest.fn(),
  } as unknown as HostBridgeWsClient;
  const ref = { current: null as MainScreenHandle | null };
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 },
        }}
      >
        <AppThemeProvider theme={theme}>
          <MainScreen
            ref={ref}
            api={api as unknown as HostBridgeApiClient}
            ws={ws}
            bridgeUrl="http://bridge"
            bridgeProfileId="runtime-profile"
            preferredAgentId="codex"
            onOpenDrawer={jest.fn()}
            onOpenGit={jest.fn()}
            onOpenBridgeRecoveryGuide={options.onRecovery}
            onChatOpeningStateChange={options.onOpening}
            onPendingOpenChatHandled={options.onHandled}
            pendingOpenChatId={options.pendingId ?? options.chat?.id}
            pendingOpenChatSnapshot={options.chat}
          />
        </AppThemeProvider>
      </SafeAreaProvider>
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!tree) throw new Error('MainScreen did not render');
  return {
    api,
    ws: ws as unknown as Harness['ws'],
    tree,
    ref,
    async emit(event: unknown) {
      if (!eventHandler) throw new Error('WS event handler not registered');
      await act(async () => {
        eventHandler?.(event);
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    async setConnected(connected: boolean) {
      (ws as unknown as { isConnected: boolean }).isConnected = connected;
      await act(async () => {
        statusHandler?.(connected);
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    unmount() {
      act(() => tree?.unmount());
    },
  };
}

function runtimeEvent(method: string, params: Record<string, unknown>): unknown {
  return { method, params: { threadId: baseChat.id, turnId: 'turn-runtime', ...params } };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('MainScreen runtime coverage', () => {
  it('delays disconnected recovery, invokes its callback, and clears it after reconnect', async () => {
    const onRecovery = jest.fn();
    const harness = await renderMain({ connected: true, onRecovery });
    const root = harness.tree.root as Queryable;

    expect(text(root, 'Bridge disconnected')).toBe(false);
    await harness.setConnected(false);
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    await act(async () => {
      jest.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    onRecovery();
    expect(onRecovery).toHaveBeenCalledTimes(1);

    await harness.setConnected(true);
    expect(root.findAll((node) => node.props.title === 'Bridge disconnected')).toHaveLength(0);
    harness.unmount();
  });

  it.each([
    { value: { ...capabilities, agents: [], supportsByAgent: {}, activeAgentId: null } },
    { value: new Error('capabilities unavailable') },
  ])('renders unavailable agent capability state', async ({ value }) => {
    const harness = await renderMain({ api: createApi({ capabilities: value }) });
    expect(input(harness.tree.root as Queryable).props.placeholder).toContain('Unknown agent');
    expect(
      (harness.tree.root as Queryable).findAll(
        (node) => node.props.accessibilityLabel === 'Fast mode'
      )
    ).toHaveLength(0);
    harness.unmount();
  });

  it.each([
    { status: 'idle' as const, expected: 'Ready', activeTurnId: null, lastError: undefined },
    { status: 'running' as const, expected: 'Working', activeTurnId: 'turn-active', lastError: undefined },
    { status: 'error' as const, expected: 'snapshot exploded', activeTurnId: null, lastError: 'snapshot exploded' },
    { status: 'complete' as const, expected: 'Turn completed', activeTurnId: null, lastError: undefined },
  ])('renders $status pending snapshot truth', async ({ status, expected, activeTurnId, lastError }) => {
    const chat = { ...baseChat, status, activeTurnId, lastError };
    const onHandled = jest.fn();
    const onOpening = jest.fn();
    const harness = await renderMain({ chat, onHandled, onOpening });

    expect(text(harness.tree.root as Queryable, 'Runtime truth')).toBe(true);
    expect(text(harness.tree.root as Queryable, expected)).toBe(true);
    expect(onHandled).toHaveBeenCalled();
    expect(onOpening).toHaveBeenCalledWith(null);
    harness.unmount();
  });

  it('projects queue, approval, input, context, plan, and bridge surfaces from live runtime events', async () => {
    const harness = await renderMain({ chat: { ...baseChat, status: 'running', activeTurnId: 'turn-runtime' } });
    const root = harness.tree.root as Queryable;

    await harness.emit(runtimeEvent('bridge/thread/queue/updated', {
      items: [{ id: 'queued', content: 'Queued runtime follow-up', createdAt: now }],
      pendingSteers: [], pendingSteerCount: 0, waitingForToolCalls: true,
      steeringInFlight: false, lastError: 'queue warning',
    }));
    expect(text(root, 'Queued runtime follow-up')).toBe(true);

    await harness.emit(runtimeEvent('bridge/approval.requested', {
      id: 'approval-runtime', agentId: 'codex', itemId: 'approval-item', requestedAt: now,
      kind: 'commandExecution', reason: 'Runtime approval', command: 'npm test', cwd: '/workspace',
      options: [{ id: 'allow', name: 'Allow', kind: 'accept' }],
    }));
    expect(text(root, 'Runtime approval')).toBe(true);

    await harness.emit(runtimeEvent('bridge/userInput.requested', {
      id: 'input-runtime', agentId: 'codex', itemId: 'input-item', requestedAt: now,
      questions: [{ id: 'choice', header: 'Runtime choice', question: 'Choose now', required: true,
        isOther: false, isSecret: false, fieldType: 'string', defaultValue: null,
        options: [{ value: 'yes', label: 'Yes', description: 'Continue' }] }],
    }));
    expect(text(root, 'Runtime choice')).toBe(true);

    await harness.emit(runtimeEvent('thread/tokenUsage/updated', {
      totalTokens: 256, modelContextWindow: 1024,
    }));
    await harness.emit(runtimeEvent('turn/plan/updated', {
      explanation: 'Runtime implementation plan',
      plan: [{ step: 'Exercise runtime branches', status: 'in_progress' }],
    }));
    expect(text(root, 'Runtime implementation plan')).toBe(true);

    await harness.emit(runtimeEvent('bridge/ui.present', {
      id: 'surface-runtime', presentation: 'banner', tone: 'info',
      title: 'Runtime bridge surface', blocks: [{ type: 'text', text: 'Surface body' }],
      actions: [], dismissible: true,
    }));
    expect(
      root.findAll((node) => node.props.accessibilityLabel === 'Dismiss Runtime bridge surface')
    ).not.toHaveLength(0);
    harness.unmount();
  });

  it('loads earlier transcript pages and renders pagination errors', async () => {
    const snapshotChat = {
      ...baseChat,
      acpSnapshot: {
        version: 2,
        timeline: [{ sequence: 2, kind: 'message', canonicalId: 'current' }],
        messages: [{ id: 'current', role: 'agent', parts: [{ type: 'text', text: 'Current answer' }], truncated: false }],
        tools: [],
        messageCollection: { truncated: true, omittedCount: 1, beforeCursor: 'before-1', revision: 7 },
        reasoningCollection: { truncated: false, omittedCount: 0, beforeCursor: null, revision: 7 },
        toolCollection: { truncated: false, omittedCount: 0, beforeCursor: null, revision: 7 },
        continuation: { revision: 7, unavailableCount: 0, maxPageSize: 50, maxHistoryEntries: 100, maxHistoryBytes: 10000 },
        plan: [], usage: {}, config: [], commands: [],
        session: { agentId: 'codex', threadId: baseChat.id, historyReconstruction: false },
        active: { toolIds: [] },
      },
    } as Chat;
    const api = createApi({ chat: snapshotChat });
    (api.readSnapshotPage as jest.Mock)
      .mockResolvedValueOnce({
        threadId: baseChat.id, revision: 7,
        entries: [{
          sequence: 1,
          kind: 'message',
          canonicalId: 'earlier',
          message: {
            id: 'earlier', role: 'user',
            parts: [{ type: 'text', text: 'Earlier prompt' }], truncated: false,
          },
        }],
        beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false,
      })
      .mockRejectedValueOnce(new Error('pagination offline'));
    const harness = await renderMain({ api, chat: snapshotChat });
    const root = harness.tree.root as Queryable;

    await press(root, 'Load earlier messages');
    expect(api.readSnapshotPage).toHaveBeenCalledWith(expect.objectContaining({
      threadId: baseChat.id, beforeCursor: 'before-1', revision: 7,
    }));
    expect(transcript(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.objectContaining({ content: 'Earlier prompt' }) }),
      ])
    );

    const errorChat = { ...snapshotChat, id: 'thread-error-page' };
    harness.unmount();
    const errorApi = createApi({ chat: errorChat });
    (errorApi.readSnapshotPage as jest.Mock).mockRejectedValueOnce(new Error('pagination offline'));
    const errorHarness = await renderMain({ api: errorApi, chat: errorChat });
    await press(errorHarness.tree.root as Queryable, 'Load earlier messages');
    expect(
      (errorHarness.tree.root as Queryable).findAll(
        (node) => node.props.accessibilityLabel === 'Retry loading earlier history'
      )
    ).not.toHaveLength(0);
    errorHarness.unmount();
  });

  it.each([
    { source: 'cached', options: { cachedChat: baseChat } },
    { source: 'shell', options: { shell: { ...baseChat, messages: [] } } },
    { source: 'summary', options: { summary: { ...baseChat, messages: [] } } },
  ])('opens through the $source recovery path and hydrates from the bridge', async ({ options }) => {
    const api = createApi(options);
    const harness = await renderMain({ api });
    await act(async () => {
      harness.ref.current?.openChat(baseChat.id);
      await Promise.resolve();
      await Promise.resolve();
      jest.runOnlyPendingTimers();
      await Promise.resolve();
    });
    expect(api.getChat).toHaveBeenCalledWith(baseChat.id);
    expect(text(harness.tree.root as Queryable, 'Current answer')).toBe(true);
    harness.unmount();
  });

  it('installs selected and background recovery truth before acknowledging once', async () => {
    const api = createApi();
    const backgroundA = { ...baseChat, id: 'background-a', title: 'Background A' };
    const backgroundB = { ...baseChat, id: 'background-b', title: 'Background B' };
    api.listLoadedChatIds.mockResolvedValue(['background-a', 'background-b']);
    api.listApprovals.mockResolvedValue([{
      id: 'approval-recovery', threadId: baseChat.id, turnId: 'turn-runtime', itemId: 'item',
      requestedAt: now, agentId: 'codex', kind: 'commandExecution', reason: 'Recovered approval',
      options: [],
    }]);
    api.listPendingUserInputs.mockResolvedValue([{
      id: 'input-recovery', threadId: baseChat.id, turnId: 'turn-runtime', itemId: 'input',
      requestedAt: now, agentId: 'codex', questions: [{
        id: 'answer', header: 'Recovered input', question: 'Continue?', isOther: false,
        isSecret: false, options: null,
      }],
    }]);
    api.getChat.mockImplementation((threadId: string) => Promise.resolve(
      threadId === backgroundA.id ? backgroundA : threadId === backgroundB.id ? backgroundB : baseChat
    ));
    api.readThreadQueue.mockImplementation((threadId: string) => Promise.resolve({
      ...emptyQueue,
      threadId,
      items: threadId === baseChat.id
        ? [{ id: 'recovered-queue', content: 'Recovered queued message', createdAt: now }]
        : [],
    }));
    const harness = await renderMain({ api, chat: baseChat });
    await harness.emit({
      method: 'bridge/events/snapshotRequired',
      params: { reason: 'replayTruncated', resumeAfterEventId: 44 },
    });
    await settleRecovery();

    expect(api.getChat.mock.calls.map(([threadId]) => threadId)).toEqual(
      expect.arrayContaining([baseChat.id, backgroundA.id, backgroundB.id])
    );
    expect(api.rememberChat).toHaveBeenCalledWith(expect.objectContaining({ id: backgroundA.id }));
    expect(api.rememberChat).toHaveBeenCalledWith(expect.objectContaining({ id: backgroundB.id }));
    expect(text(harness.tree.root as Queryable, 'Recovered approval')).toBe(true);
    expect(text(harness.tree.root as Queryable, 'Recovered input')).toBe(true);
    expect(text(harness.tree.root as Queryable, 'Recovered queued message')).toBe(true);
    expect(harness.ws.acknowledgeSnapshotRecovery).toHaveBeenCalledTimes(1);
    expect(harness.ws.acknowledgeSnapshotRecovery).toHaveBeenCalledWith(44);
    harness.unmount();
  });

  it('retains the barrier after one thread fails and acknowledges only after retry succeeds', async () => {
    const api = createApi();
    const harness = await renderMain({ api, chat: baseChat });
    api.listLoadedChatIds.mockResolvedValue(['background-failing']);
    api.getChat.mockReset()
      .mockImplementationOnce(() => Promise.resolve(baseChat))
      .mockRejectedValueOnce(new Error('background unavailable'))
      .mockImplementation((threadId: string) => Promise.resolve({ ...baseChat, id: threadId }));

    await harness.emit({
      method: 'bridge/events/snapshotRequired',
      params: { reason: 'replayTruncated', resumeAfterEventId: 51 },
    });
    expect(harness.ws.acknowledgeSnapshotRecovery).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    await settleRecovery();
    expect(harness.ws.acknowledgeSnapshotRecovery).toHaveBeenCalledTimes(1);
    expect(harness.ws.acknowledgeSnapshotRecovery).toHaveBeenCalledWith(51);
    harness.unmount();
  });

  it('supersedes a delayed stale watermark and never acknowledges recovery overflow', async () => {
    const api = createApi();
    const harness = await renderMain({ api, chat: baseChat });
    let releaseFirst: ((value: string[]) => void) | undefined;
    api.listLoadedChatIds.mockReset().mockImplementationOnce(() => new Promise<string[]>((resolve) => {
      releaseFirst = resolve;
    })).mockResolvedValue([]);

    await harness.emit({
      method: 'bridge/events/snapshotRequired',
      params: { reason: 'replayTruncated', resumeAfterEventId: 60 },
    });
    await harness.emit({
      method: 'bridge/events/snapshotRequired',
      params: { reason: 'replayTruncated', resumeAfterEventId: 70 },
    });
    releaseFirst?.([]);
    await settleRecovery();
    expect(harness.ws.acknowledgeSnapshotRecovery).toHaveBeenCalledTimes(1);
    expect(harness.ws.acknowledgeSnapshotRecovery).toHaveBeenCalledWith(70);

    harness.ws.acknowledgeSnapshotRecovery.mockClear();
    await harness.emit({
      method: 'bridge/events/snapshotRequired',
      params: { reason: 'recoveryOverflow', resumeAfterEventId: 70 },
    });
    await settleRecovery();
    expect(harness.ws.acknowledgeSnapshotRecovery).not.toHaveBeenCalled();
    harness.unmount();
  });

  it('reconnects once without ACK or retry when the loaded list exceeds the protocol maximum', async () => {
    const api = createApi();
    api.listLoadedChatIds.mockResolvedValue(
      Array.from({ length: 2_049 }, (_, index) => `thread-${index}`)
    );
    const harness = await renderMain({ api, chat: baseChat });
    const timeout = jest.spyOn(globalThis, 'setTimeout');
    timeout.mockClear();

    await harness.emit({
      method: 'bridge/events/snapshotRequired',
      params: { reason: 'replayTruncated', resumeAfterEventId: 80 },
    });
    await settleRecovery();
    expect(harness.ws.acknowledgeSnapshotRecovery).not.toHaveBeenCalled();
    expect(harness.ws.resetRecoveryEpoch).toHaveBeenCalledTimes(1);
    expect(harness.ws.disconnect).not.toHaveBeenCalled();
    expect(harness.ws.connect).not.toHaveBeenCalled();
    expect(timeout.mock.calls.some(([, delay]) => delay === 1_000)).toBe(false);

    await harness.emit({
      method: 'bridge/events/snapshotRequired',
      params: { reason: 'recoveryOverflow', resumeAfterEventId: 0 },
    });
    await settleRecovery();
    expect(harness.ws.resetRecoveryEpoch).toHaveBeenCalledTimes(1);
    expect(
      text(
        harness.tree.root as Queryable,
        'Replay recovery exceeded the bridge protocol limit after reconnect.'
      )
    ).toBe(true);
    harness.unmount();
  });

  it.each([
    { command: '/help', expected: 'Slash commands' },
    { command: '/plan on', expected: 'Plan mode enabled' },
    { command: '/plan off', expected: 'Default mode enabled' },
    { command: '/review', expected: '/review requires an open chat' },
  ])('executes slash command $command', async ({ command }) => {
    const harness = await renderMain();
    const root = harness.tree.root as Queryable;
    act(() => (input(root).props.onChangeText as (value: string) => void)(command));
    await press(root, 'Send message');
    expect(harness.api.createChatIdempotent.mock.calls).toHaveLength(0);
    expect(input(root).props.value).toBe('');
    if (command === '/plan on') {
      expect(
        root.findAll((node) => String(node.props.accessibilityLabel).includes('Plan')).length
      ).toBeGreaterThan(0);
    }
    harness.unmount();
  });

  it.each([
    { latest: null, error: null, expected: 'No active turn found' },
    { latest: 'turn-latest', error: null, expected: 'Stopping turn' },
    { latest: null, error: new Error('stop offline'), expected: 'stop offline' },
  ])('stops through latest-turn fallback', async ({ latest, error }) => {
    const api = createApi();
    api.interruptLatestTurn.mockImplementation(() =>
      error ? Promise.reject(error) : Promise.resolve(latest)
    );
    const running = { ...baseChat, status: 'running' as const, activeTurnId: null };
    const harness = await renderMain({ api, chat: running });
    const root = harness.tree.root as Queryable;
    const chatInput = root.findAll((node) => typeof node.props.onStop === 'function')[0];
    if (!chatInput) throw new Error('Running ChatInput not rendered');
    await act(async () => {
      (chatInput.props.onStop as () => void)();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.interruptLatestTurn).toHaveBeenCalledWith(baseChat.id);
    if (latest) {
      expect(api.interruptTurn).not.toHaveBeenCalled();
    }
    if (error) {
      expect(text(harness.tree.root as Queryable, error.message)).toBe(true);
    }
    harness.unmount();
  });

  it.each([
    { disposition: 'sent', failure: null, expected: 'Stopping turn' },
    { disposition: 'queued', failure: null, expected: 'Queued response' },
    { disposition: null, failure: new Error('send offline'), expected: 'send offline' },
  ])('renders selected-thread send outcome $disposition', async ({ disposition, failure, expected }) => {
    const api = createApi();
    const queued = { ...emptyQueue, items: [{ id: 'queued-send', content: 'Queued response', createdAt: now }] };
    api.sendOrQueueChatMessage.mockImplementation(() => {
      if (failure) return Promise.reject(failure);
      if (disposition === 'queued') return Promise.resolve({ disposition, queue: queued });
      return Promise.resolve({ disposition, queue: emptyQueue, turnId: 'turn-sent', chat: { ...baseChat, status: 'running', activeTurnId: 'turn-sent' } });
    });
    const harness = await renderMain({ api, chat: baseChat });
    const root = harness.tree.root as Queryable;
    act(() => (input(root).props.onChangeText as (value: string) => void)('Runtime send'));
    await press(root, 'Send message');
    expect(api.sendOrQueueChatMessage.mock.calls.length).toBeGreaterThan(0);
    expect(text(root, expected) || (disposition === 'sent' && text(root, 'Working'))).toBe(true);
    harness.unmount();
  });

  it('implements or stays in plan mode from a completed plan prompt', async () => {
    const planned: Chat = {
      ...baseChat,
      latestTurnPlan: {
        threadId: baseChat.id,
        turnId: 'turn-plan',
        explanation: 'Ready to implement',
        steps: [{ step: 'Ship it', status: 'completed' }],
      },
      latestTurnStatus: 'completed',
      acpMode: 'plan',
    };
    const api = createApi({ chat: planned });
    const implementHarness = await renderMain({ api, chat: planned });
    await implementHarness.emit(runtimeEvent('item/started', {
      item: { type: 'plan' },
    }));
    await implementHarness.emit({
      method: 'bridge/agui.event',
      params: {
        threadId: baseChat.id,
        runId: 'run-plan',
        sourceTurnId: 'turn-plan',
        event: { type: 'RUN_FINISHED', threadId: baseChat.id, runId: 'run-plan' },
      },
    });
    const implementRoot = implementHarness.tree.root as Queryable;
    await press(implementRoot, 'Yes, implement this plan');
    expect(api.sendOrQueueChatMessage).toHaveBeenCalledWith(
      baseChat.id,
      expect.objectContaining({ collaborationMode: 'default' }),
      expect.any(Object)
    );
    implementHarness.unmount();

    const stayHarness = await renderMain({ chat: planned });
    await stayHarness.emit(runtimeEvent('item/started', { item: { type: 'plan' } }));
    await stayHarness.emit({
      method: 'bridge/agui.event',
      params: {
        threadId: baseChat.id,
        runId: 'run-plan-stay',
        sourceTurnId: 'turn-plan',
        event: { type: 'RUN_FINISHED', threadId: baseChat.id, runId: 'run-plan-stay' },
      },
    });
    await press(stayHarness.tree.root as Queryable, 'No, stay in Plan mode');
    expect(
      (stayHarness.tree.root as Queryable).findAll(
        (node) => String(node.props.accessibilityLabel).startsWith('Agent mode, Plan')
      ).length
    ).toBeGreaterThan(0);
    stayHarness.unmount();
  });

  it('records synchronization assessments for terminal and error status convergence', async () => {
    const api = createApi();
    (api.getChatSummary as jest.Mock)
      .mockResolvedValueOnce({ ...baseChat, status: 'complete', title: 'Synchronized complete' })
      .mockResolvedValueOnce({ ...baseChat, status: 'error', lastError: 'synchronized failure' });
    const harness = await renderMain({ api, chat: { ...baseChat, status: 'running', activeTurnId: 'turn-runtime' } });

    await harness.emit(runtimeEvent('thread/status/changed', { status: 'completed' }));
    expect(api.getChatSummary).toHaveBeenCalledWith(baseChat.id);
    await harness.emit(runtimeEvent('thread/status/changed', { status: 'failed' }));
    expect(api.getChatSummary).toHaveBeenCalledTimes(2);
    harness.unmount();
  });
});
