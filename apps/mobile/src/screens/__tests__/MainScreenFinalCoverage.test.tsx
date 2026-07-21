import { AppState, Pressable, TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { HostBridgeApiClient } from '../../api/client';
import type { BridgeCapabilities, Chat, ChatSummary } from '../../api/types';
import type { HostBridgeWsClient } from '../../api/ws';
import { AppThemeProvider, createAppTheme } from '../../theme';
import { MainScreen, type MainScreenHandle } from '../MainScreen';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  readAsStringAsync: jest.fn().mockRejectedValue(new Error('missing')),
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('react-native-markdown-display', () => 'Markdown');
jest.mock('../../components/ChatMessage', () => ({
  ChatMessage: ({ message }: { message: { content: string } }) => message.content,
  ToolActivityGroup: ({ events }: { events: unknown[] }) => `activities:${String(events.length)}`,
}));
jest.mock('../../components/LoadingGlyph', () => ({ LoadingGlyph: () => null }));
jest.mock('../../components/ApprovalBanner', () => ({ ApprovalBanner: () => null }));

let bridgeModalProps: Record<string, unknown> | null = null;
jest.mock('../../components/BridgeUiSurface', () => ({
  BridgeUiBanner: () => null,
  BridgeUiWorkflowCard: () => null,
  BridgeUiModal: (props: Record<string, unknown>) => {
    bridgeModalProps = props;
    return 'bridge modal';
  },
}));

type Queryable = ReactTestInstance & {
  children: unknown[];
  parent: Queryable | null;
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByType(type: unknown): Queryable[];
};

type TextInputNode = Queryable & {
  props: Queryable['props'] & {
    accessibilityLabel?: string;
    onChangeText(value: string): void;
    value?: unknown;
  };
};

type MockApi = Record<string, jest.Mock>;

type Harness = {
  api: MockApi;
  tree: ReactTestRenderer;
  root: Queryable;
  ref: { current: MainScreenHandle | null };
  ws: HostBridgeWsClient;
  emit(event: unknown): Promise<void>;
  status(connected: boolean): Promise<void>;
  unmount(): void;
};

const now = '2026-07-20T12:00:00.000Z';
const theme = createAppTheme('dark');
const threadId = 'thread-final';
const otherThreadId = 'thread-background';
const support = {
  turnSteer: true,
  planMode: true,
  reviewStart: true,
  goalSlash: true,
  fastMode: true,
  commandOutputDelta: true,
  selfUpdate: true,
  browserPreview: true,
  genericUiSurface: true,
};
const capabilities: BridgeCapabilities = {
  protocolVersion: 2,
  streamId: 'final-stream',
  preferredAgentId: 'codex',
  activeAgentId: 'codex',
  agents: [
    { agentId: 'codex', displayName: 'Codex', version: '1', provenance: 'test', lifecycle: 'ready' },
    { agentId: 'claude', displayName: 'Claude', version: '2', provenance: 'test', lifecycle: 'ready' },
  ],
  supportsByAgent: { codex: support, claude: support },
  supports: support,
  agUiEvents: true,
};
const baseChat: Chat = {
  id: threadId,
  title: 'Final coverage thread',
  status: 'complete',
  createdAt: now,
  updatedAt: now,
  statusUpdatedAt: now,
  lastMessagePreview: 'Existing answer',
  cwd: '/workspace',
  agentId: 'codex',
  messages: [{ id: 'answer', role: 'assistant', content: 'Existing answer', createdAt: now }],
};
const emptyQueue = {
  threadId,
  items: [],
  pendingSteers: [],
  pendingSteerCount: 0,
  waitingForToolCalls: false,
  steeringInFlight: false,
  lastError: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createApi(overrides: Record<string, unknown> = {}): MockApi {
  const methods: MockApi = {
    readBridgeCapabilities: jest.fn().mockResolvedValue(capabilities),
    peekChat: jest.fn().mockReturnValue(null),
    peekChatShell: jest.fn().mockReturnValue(null),
    peekChatSummary: jest.fn().mockReturnValue(null),
    peekChats: jest.fn().mockReturnValue(null),
    peekAllChats: jest.fn().mockReturnValue(null),
    rememberChat: jest.fn(),
    getChat: jest.fn().mockResolvedValue(baseChat),
    getChatSummary: jest.fn().mockResolvedValue(baseChat),
    listPendingApprovals: jest.fn().mockResolvedValue([]),
    listApprovals: jest.fn().mockResolvedValue([]),
    listPendingUserInputs: jest.fn().mockResolvedValue([]),
    readThreadQueue: jest.fn().mockResolvedValue(emptyQueue),
    listWorkspaceRoots: jest.fn().mockResolvedValue({
      bridgeRoot: '/workspace', allowOutsideRootCwd: false, workspaces: [],
    }),
    listFilesystemEntries: jest.fn().mockResolvedValue({
      bridgeRoot: '/workspace', path: '/workspace', parentPath: null, truncated: false, entries: [],
    }),
    listLoadedChatIds: jest.fn().mockResolvedValue([]),
    getChatSummaries: jest.fn().mockResolvedValue([]),
    createChatIdempotent: jest.fn().mockResolvedValue({ ...baseChat, id: 'created-final', messages: [] }),
    sendChatMessageIdempotent: jest.fn().mockResolvedValue({ ...baseChat, id: 'created-final' }),
    sendOrQueueChatMessage: jest.fn().mockResolvedValue({
      disposition: 'sent', queue: emptyQueue, turnId: 'turn-final',
      chat: { ...baseChat, status: 'running', activeTurnId: 'turn-final' },
    }),
    steerQueuedThreadMessage: jest.fn().mockResolvedValue({ ok: true, queue: emptyQueue }),
    cancelQueuedThreadMessage: jest.fn().mockResolvedValue({ ok: true, queue: emptyQueue }),
    interruptTurn: jest.fn().mockResolvedValue(true),
    interruptLatestTurn: jest.fn().mockResolvedValue(null),
    ...Object.fromEntries(Object.entries(overrides).map(([key, value]) => [
      key,
      jest.isMockFunction(value) ? value : jest.fn().mockResolvedValue(value),
    ])),
  };
  return new Proxy(methods, {
    get(target, property) {
      if (typeof property !== 'string') return undefined;
      target[property] ??= jest.fn().mockResolvedValue(null);
      return target[property];
    },
  });
}

async function renderMain(options: {
  api?: MockApi;
  chat?: Chat | null;
  connected?: boolean;
  defaultStartCwd?: string | null;
  onOpenGit?: jest.Mock;
  onRecovery?: jest.Mock;
} = {}): Promise<Harness> {
  const api = options.api ?? createApi();
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
  } as unknown as HostBridgeWsClient;
  const ref = { current: null as MainScreenHandle | null };
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(
      <SafeAreaProvider initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}>
        <AppThemeProvider theme={theme}>
          <MainScreen
            ref={ref}
            api={api as unknown as HostBridgeApiClient}
            ws={ws}
            bridgeUrl="https://bridge.test"
            bridgeProfileId="profile-final"
            preferredAgentId="codex"
            defaultStartCwd={options.defaultStartCwd}
            pendingOpenChatId={options.chat?.id}
            pendingOpenChatSnapshot={options.chat}
            onOpenDrawer={jest.fn()}
            onOpenGit={options.onOpenGit ?? jest.fn()}
            onOpenBridgeRecoveryGuide={options.onRecovery}
          />
        </AppThemeProvider>
      </SafeAreaProvider>
    );
    await flush();
  });
  if (!tree) throw new Error('MainScreen did not render');
  return {
    api,
    tree,
    root: tree.root as Queryable,
    ref,
    ws,
    async emit(event) {
      if (!eventHandler) throw new Error('WebSocket event handler missing');
      await act(async () => {
        eventHandler?.(event);
        await flush();
      });
    },
    async status(connected) {
      (ws as unknown as { isConnected: boolean }).isConnected = connected;
      await act(async () => {
        statusHandler?.(connected);
        await flush();
      });
    },
    unmount() {
      act(() => tree?.unmount());
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function input(root: Queryable): TextInputNode {
  const result = root.findAllByType(TextInput).find((node) => node.props.accessibilityLabel === 'Message');
  if (!result) throw new Error('Message input missing');
  return result as TextInputNode;
}

function hasText(root: Queryable, value: string): boolean {
  return root.findAll((node) => node.children.includes(value)).length > 0;
}

function labeled(root: Queryable, label: string): Queryable {
  const result = root.findAll((node) => node.props.accessibilityLabel === label)[0];
  if (!result) throw new Error(`Missing label: ${label}`);
  return result;
}

function labeledPrefix(root: Queryable, prefix: string): Queryable {
  const result = root.findAll((node) =>
    String(node.props.accessibilityLabel ?? '').startsWith(prefix)
  )[0];
  if (!result) throw new Error(`Missing label prefix: ${prefix}`);
  return result;
}

async function press(node: Queryable): Promise<void> {
  let target: Queryable | null = node;
  while (target && typeof target.props.onPress !== 'function') target = target.parent;
  if (!target) throw new Error('Press target missing');
  await act(async () => {
    (target?.props.onPress as () => void)();
    await flush();
  });
}

async function submit(root: Queryable, value: string): Promise<void> {
  await act(async () => {
    input(root).props.onChangeText(value);
    await flush();
  });
  await press(labeled(root, 'Send message'));
}

function agUi(event: Record<string, unknown>, target = threadId, runId = 'run-final') {
  return {
    method: 'bridge/agui.event',
    params: { threadId: target, runId, sourceTurnId: 'turn-final', event },
  };
}

function exercisePressedStyles(root: Queryable): void {
  for (const node of root.findAllByType(Pressable)) {
    if (typeof node.props.style === 'function') {
      node.props.style({ pressed: false });
      node.props.style({ pressed: true });
    }
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  bridgeModalProps = null;
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('MainScreen final branch coverage', () => {
  it('executes slash command fallbacks, arguments, labels, status, review, diff, and suggestions', async () => {
    const onOpenGit = jest.fn();
    const harness = await renderMain({ chat: baseChat, onOpenGit });

    await submit(harness.root, '/help');
    await submit(harness.root, '/status');
    await submit(harness.root, '/model');
    await submit(harness.root, '/review');
    await submit(harness.root, '/diff');
    expect(onOpenGit).toHaveBeenCalledWith(expect.objectContaining({ id: threadId }));

    await submit(harness.root, '/plan');
    await submit(harness.root, '/plan off');
    await submit(harness.root, '/plan enabled');
    await submit(harness.root, '/plan default');
    await submit(harness.root, '/agent');
    expect(hasText(harness.root, 'No spawned agent threads for this chat yet.')).toBe(true);

    await act(async () => {
      input(harness.root).props.onChangeText('/');
      await flush();
    });
    exercisePressedStyles(harness.root);
    const suggestion = harness.root.findAll((node) =>
      typeof node.props.onPress === 'function' && node.children.some((child) => child === '/plan <prompt>')
    )[0];
    if (suggestion) await press(suggestion);

    await submit(harness.root, '/new');
    harness.unmount();

    const unavailable = createApi({
      readBridgeCapabilities: Promise.resolve({
        ...capabilities,
        supports: { ...support, planMode: false, reviewStart: false, goalSlash: false },
        supportsByAgent: { codex: { ...support, planMode: false, reviewStart: false, goalSlash: false } },
      }),
    });
    const second = await renderMain({ api: unavailable, chat: baseChat });
    await submit(second.root, '/plan improve this');
    await submit(second.root, '/goal ship it');
    await submit(second.root, '/review');
    await submit(second.root, '/compact');
    await submit(second.root, '/definitely-unknown');
    second.unmount();
  });

  it('covers new-thread plan create/send outcomes and ordinary create status variants', async () => {
    for (const status of ['complete', 'error', 'running'] as const) {
      const result = {
        ...baseChat,
        id: `created-${status}`,
        status,
        lastError: status === 'error' ? 'creation failed remotely' : undefined,
        latestTurnPlan: status === 'complete' ? {
          threadId: `created-${status}`,
          turnId: 'turn-plan',
          explanation: 'Generated plan',
          steps: [{ step: 'Implement', status: 'pending' as const }],
        } : undefined,
      };
      const api = createApi({
        createChatIdempotent: Promise.resolve({ ...result, messages: [] }),
        sendChatMessageIdempotent: Promise.resolve(result),
      });
      const harness = await renderMain({ api });
      await submit(harness.root, status === 'complete' ? '/plan design it' : `create ${status}`);
      expect(api.createChatIdempotent).toHaveBeenCalled();
      harness.unmount();
    }

    for (const failingMethod of ['createChatIdempotent', 'sendChatMessageIdempotent']) {
      const api = createApi();
      api[failingMethod].mockRejectedValueOnce(new Error(`${failingMethod} final failure`));
      const harness = await renderMain({ api });
      await submit(harness.root, '/plan preserve this plan prompt');
      expect(api[failingMethod]).toHaveBeenCalled();
      harness.unmount();
    }
  });

  it('covers selected send sent, queued, error, goal, navigation-away, and optimistic fallbacks', async () => {
    const running = { ...baseChat, status: 'running' as const, activeTurnId: 'turn-running' };
    const api = createApi();
    const harness = await renderMain({ api, chat: running });

    api.sendOrQueueChatMessage.mockResolvedValueOnce({
      disposition: 'queued',
      queue: { ...emptyQueue, items: [{ id: 'queued-result', content: 'queued result', createdAt: now }] },
    });
    await submit(harness.root, 'queued result');

    api.sendOrQueueChatMessage.mockResolvedValueOnce({
      disposition: 'sent', queue: emptyQueue, turnId: 'turn-complete',
      chat: { ...baseChat, status: 'complete', latestTurnPlan: {
        threadId, turnId: 'turn-complete', explanation: 'Ready to implement',
        steps: [{ step: 'Code it', status: 'pending' }],
      } },
    });
    await submit(harness.root, 'complete result');

    api.sendOrQueueChatMessage.mockResolvedValueOnce({
      disposition: 'sent', queue: emptyQueue, turnId: 'turn-error',
      chat: { ...baseChat, status: 'error', lastError: 'provider rejected turn' },
    });
    await submit(harness.root, '/goal deliver release');

    api.sendOrQueueChatMessage.mockRejectedValueOnce(new Error('send final failure'));
    await submit(harness.root, '/goal restore release');
    expect(input(harness.root).props.value).toBe('/goal restore release');

    const pending = deferred<unknown>();
    api.sendOrQueueChatMessage.mockReturnValueOnce(pending.promise);
    await act(async () => {
      input(harness.root).props.onChangeText('resolve after navigation');
      (labeled(harness.root, 'Send message').props.onPress as () => void)();
      await flush();
      harness.ref.current?.startNewChat();
      pending.resolve({
        disposition: 'sent', queue: emptyQueue, turnId: 'turn-away',
        chat: { ...baseChat, status: 'complete' },
      });
      await flush();
    });
    harness.unmount();
  });

  it('supersedes open-chat loads, cached revalidation, stale queue reads, and delayed opening', async () => {
    const first = deferred<Chat>();
    const second = deferred<Chat>();
    const queueFirst = deferred<typeof emptyQueue>();
    const api = createApi();
    api.getChat.mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    api.readThreadQueue.mockReset().mockReturnValueOnce(queueFirst.promise).mockResolvedValue(emptyQueue);
    const harness = await renderMain({ api });

    await act(async () => {
      harness.ref.current?.openChat('thread-one');
      harness.ref.current?.openChat('thread-two');
      second.resolve({ ...baseChat, id: 'thread-two', title: 'Second wins' });
      await flush();
      first.resolve({ ...baseChat, id: 'thread-one', title: 'First is stale' });
      queueFirst.resolve({ ...emptyQueue, threadId: 'thread-one' });
      jest.advanceTimersByTime(400);
      await flush();
    });
    expect(hasText(harness.root, 'Second wins')).toBe(true);

    api.peekChat.mockReturnValue({ ...baseChat, id: 'cached-thread', title: 'Cached immediately' });
    api.getChat.mockRejectedValueOnce(new Error('revalidation failed'));
    await act(async () => {
      harness.ref.current?.openChat('cached-thread');
      await flush();
    });
    expect(hasText(harness.root, 'Cached immediately')).toBe(true);
    harness.unmount();
  });

  it('projects dense current, off-thread, malformed, cancellation, and snapshot event branches', async () => {
    const running = { ...baseChat, status: 'running' as const, activeTurnId: 'turn-final' };
    const harness = await renderMain({ chat: running });
    await harness.emit(agUi({ type: 'RUN_STARTED', threadId, runId: 'run-final' }));
    await press(labeled(harness.root, 'Stop agent'));
    await harness.emit(agUi({ type: 'RUN_ERROR', code: 'cancelled', message: 'cancelled' }));
    const currentEvents = [
      { method: 'thread/tokenUsage/updated', params: { thread_id: threadId, total_tokens: 10, model_context_window: 100 } },
      { method: 'item/started', params: { thread_id: threadId, turn_id: 'turn-plan', item: { type: 'plan' } } },
      { method: 'item/started', params: { threadId, item: { type: 'reasoning' } } },
      { method: 'item/started', params: { threadId, item: { type: 'toolCall', name: '' } } },
      { method: 'item/plan/delta', params: { threadId, delta: '' } },
      { method: 'item/plan/delta', params: { threadId, turnId: 'turn-plan', delta: '1. First\n2. Second' } },
      { method: 'item/reasoning/summaryPartAdded', params: { threadId, itemId: 'reason', summaryIndex: 0 } },
      { method: 'item/reasoning/summaryPartAdded', params: { threadId, itemId: 'reason', summaryIndex: 0 } },
      { method: 'item/reasoning/summaryTextDelta', params: { threadId, itemId: 'reason', summaryIndex: 0, delta: '' } },
      { method: 'item/reasoning/summaryTextDelta', params: { threadId, itemId: 'reason', summaryIndex: 0, delta: 'plain detail without heading' } },
      { method: 'item/reasoning/summaryTextDelta', params: { threadId, itemId: 'reason', summaryIndex: 0, delta: ' **Named heading**' } },
      { method: 'item/reasoning/textDelta', params: { threadId, delta: '' } },
      { method: 'item/reasoning/textDelta', params: { threadId, delta: 'deep detail' } },
      { method: 'item/commandExecution/outputDelta', params: { threadId } },
      { method: 'item/commandExecution/terminalInteraction', params: { threadId } },
      { method: 'item/mcpToolCall/progress', params: { threadId } },
      { method: 'turn/plan/updated', params: { explanation: 'Implicit current plan', plan: [] } },
      { method: 'turn/plan/updated', params: { threadId, turnId: 'turn-plan', explanation: '', plan: [{ step: 'Active', status: 'in_progress' }] } },
      { method: 'turn/diff/updated', params: { threadId } },
      { method: 'item/completed', params: { threadId, item: { type: 'commandExecution', status: 'error', command: '' } } },
      { method: 'item/completed', params: { threadId, item: { type: 'toolCall', name: '' } } },
    ];
    for (const event of currentEvents) await harness.emit(event);

    const offThreadEvents = [
      { method: 'item/started', params: { threadId: otherThreadId, item: { type: 'commandExecution', command: '' } } },
      { method: 'item/started', params: { threadId: otherThreadId, item: { type: 'fileChange', path: '' } } },
      { method: 'item/started', params: { threadId: otherThreadId, item: { type: 'mcpToolCall', server: '', tool: '' } } },
      { method: 'item/started', params: { threadId: otherThreadId, item: { type: 'plan' } } },
      { method: 'item/started', params: { threadId: otherThreadId, item: { type: 'reasoning' } } },
      { method: 'item/plan/delta', params: { threadId: otherThreadId } },
      { method: 'item/reasoning/summaryPartAdded', params: { threadId: otherThreadId } },
      { method: 'item/reasoning/summaryTextDelta', params: { threadId: otherThreadId, delta: 'background detail' } },
      { method: 'item/reasoning/summaryTextDelta', params: { threadId: otherThreadId, delta: '**Background heading**' } },
      { method: 'item/reasoning/textDelta', params: { threadId: otherThreadId } },
      { method: 'item/commandExecution/outputDelta', params: { threadId: otherThreadId } },
      { method: 'item/commandExecution/terminalInteraction', params: { threadId: otherThreadId } },
      { method: 'item/mcpToolCall/progress', params: { threadId: otherThreadId } },
      { method: 'turn/plan/updated', params: { threadId: otherThreadId, plan: [{ step: 'Background', status: 'pending' }] } },
      { method: 'turn/diff/updated', params: { threadId: otherThreadId } },
      { method: 'item/completed', params: { threadId: otherThreadId, item: { type: 'commandExecution', status: 'failed' } } },
      { method: 'item/completed', params: { threadId: otherThreadId, item: { type: 'commandExecution', status: 'completed' } } },
      { method: 'item/completed', params: { threadId: otherThreadId, item: { type: 'mcpToolCall', server: '', tool: '' } } },
    ];
    for (const event of offThreadEvents) await harness.emit(event);

    await harness.emit(agUi({ type: 'RUN_ERROR', code: 'provider_error', message: 'background failed' }, otherThreadId));
    await harness.emit({ method: 'bridge/events/snapshotRequired', params: { resumeAfterEventId: 77 } });
    await act(async () => {
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });
    expect(harness.ws.acknowledgeSnapshotRecovery).toHaveBeenCalledWith(77);
    harness.unmount();

    const noThread = await renderMain();
    await noThread.emit({ method: 'bridge/events/snapshotRequired', params: { resumeAfterEventId: 88 } });
    await act(async () => {
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });
    expect(noThread.ws.acknowledgeSnapshotRecovery).toHaveBeenCalledWith(88);
    noThread.unmount();
  });

  it('renders workflow plan, approval, execution, collapsed, progress, and action branches', async () => {
    const plan = {
      threadId,
      turnId: 'turn-plan-card',
      explanation: '## Release plan',
      steps: [
        { step: 'Completed task', status: 'completed' as const },
        { step: 'Active task', status: 'inProgress' as const },
        { step: 'Pending task', status: 'pending' as const },
      ],
    };
    const plannedChat: Chat = {
      ...baseChat,
      status: 'running',
      latestPlan: plan,
      latestTurnPlan: plan,
      latestTurnStatus: 'in_progress',
    };
    const api = createApi({
      getChat: Promise.resolve({ ...plannedChat, status: 'complete', latestTurnStatus: 'completed' }),
    });
    const harness = await renderMain({ api, chat: plannedChat });
    await harness.emit({
      method: 'turn/plan/updated',
      params: {
        threadId,
        turnId: plan.turnId,
        explanation: plan.explanation,
        plan: plan.steps.map((step) => ({
          step: step.step,
          status: step.status === 'inProgress' ? 'in_progress' : step.status,
        })),
      },
    });
    exercisePressedStyles(harness.root);
    const planHeader = harness.root.findAll((node) =>
      String(node.props.accessibilityLabel ?? '').startsWith('Plan,')
    )[0];
    if (planHeader) {
      await press(planHeader);
      await press(planHeader);
    }

    await harness.emit(agUi({ type: 'RUN_FINISHED', threadId, runId: 'run-final' }));
    exercisePressedStyles(harness.root);
    const stay = harness.root.findAll((node) => node.children.includes('Keep planning'))[0];
    if (stay) await press(stay);

    await harness.emit({ method: 'item/started', params: { threadId, item: { type: 'commandExecution', command: 'npm test' } } });
    exercisePressedStyles(harness.root);
    harness.unmount();

    const emptyPlan = await renderMain({ chat: { ...baseChat, status: 'running' } });
    await emptyPlan.emit({ method: 'turn/plan/updated', params: { threadId, turnId: 'empty-plan', explanation: '', plan: [] } });
    exercisePressedStyles(emptyPlan.root);
    emptyPlan.unmount();
  });

  it('renders agent rows, selection labels, queued states, disabled reasons, and action failures', async () => {
    const childRows: ChatSummary[] = [
      {
        ...baseChat,
        id: 'agent-running',
        title: '',
        status: 'running',
        parentThreadId: threadId,
        subAgentDepth: 1,
        agentNickname: 'Worker',
        agentRole: 'implementation',
        lastMessagePreview: '',
      },
      {
        ...baseChat,
        id: 'agent-error',
        title: 'Review work',
        status: 'error',
        parentThreadId: threadId,
        subAgentDepth: 1,
        lastError: 'Agent failed',
      },
    ];
    const api = createApi({
      listLoadedChatIds: Promise.resolve(childRows.map((row) => row.id)),
      getChatSummaries: Promise.resolve(childRows),
    });
    api.steerQueuedThreadMessage.mockRejectedValueOnce(new Error('steer failed'));
    api.cancelQueuedThreadMessage.mockRejectedValueOnce(new Error('cancel failed'));
    const harness = await renderMain({ api, chat: { ...baseChat, status: 'running', activeTurnId: 'active' } });

    await harness.emit({ method: 'thread/started', params: { threadId: 'agent-running', parentThreadId: threadId } });
    await act(async () => {
      jest.advanceTimersByTime(300);
      await flush();
    });
    exercisePressedStyles(harness.root);
    const agentHeader = harness.root.findAll((node) =>
      String(node.props.accessibilityLabel ?? '').startsWith('Agents,')
    )[0];
    if (agentHeader) {
      await press(agentHeader);
      await press(agentHeader);
    }

    await harness.emit({
      method: 'bridge/thread/queue/updated',
      params: {
        ...emptyQueue,
        items: [
          { id: 'queue-one', content: 'First queued message', createdAt: now },
          { id: 'queue-two', content: 'Second queued message', createdAt: now },
        ],
        waitingForToolCalls: true,
      },
    });
    expect(hasText(harness.root, '+1 more queued')).toBe(true);
    exercisePressedStyles(harness.root);
    await press(labeled(harness.root, 'Steer queued message'));
    await press(labeled(harness.root, 'Cancel queued message'));

    await harness.emit({
      method: 'bridge/thread/queue/updated',
      params: {
        ...emptyQueue,
        items: [{ id: 'queue-pending', content: 'Pending steer', createdAt: now }],
        pendingSteers: [{ id: 'pending-steer', queueItemId: 'queue-pending' }],
        pendingSteerCount: 1,
        steeringInFlight: true,
      },
    });
    exercisePressedStyles(harness.root);

    await harness.emit({
      method: 'bridge/approval.requested',
      params: {
        id: 'approval-disable', agentId: 'codex', threadId, itemId: 'item', requestedAt: now,
        kind: 'commandExecution', options: [],
      },
    });
    exercisePressedStyles(harness.root);
    harness.unmount();
  });

  it('covers disconnect recovery, status summary truth, switching away, and pressed recovery controls', async () => {
    const onRecovery = jest.fn();
    const api = createApi();
    api.getChatSummary
      .mockResolvedValueOnce({ ...baseChat, status: 'running', activeTurnId: 'summary-turn' })
      .mockResolvedValueOnce({ ...baseChat, status: 'error', lastError: 'summary error' })
      .mockResolvedValueOnce({ ...baseChat, status: 'idle' });
    const harness = await renderMain({ api, chat: baseChat, onRecovery });

    await harness.emit({ method: 'thread/status/changed', params: { threadId, status: 'running' } });
    await harness.emit({ method: 'thread/status/changed', params: { threadId, status: 'failed' } });
    await harness.emit({ method: 'thread/status/changed', params: { threadId, status: 'mystery' } });
    await harness.emit({ method: 'thread/status/changed', params: { threadId: otherThreadId, status: 'running' } });
    await harness.emit({ method: 'thread/status/changed', params: { threadId: otherThreadId, status: 'complete' } });

    await harness.status(false);
    await harness.emit({ method: 'bridge/connection/state', params: { status: 'disconnected' } });
    await act(async () => {
      jest.advanceTimersByTime(10_000);
      await flush();
    });
    exercisePressedStyles(harness.root);
    const guide = harness.root.findAll((node) => node.children.includes('How to start bridge'))[0];
    if (guide) await press(guide);
    await harness.status(true);
    harness.unmount();
  });

  it('revalidates changed plans, messages, sub-agent metadata, summaries, and transcript preservation', async () => {
    const plan = {
      threadId,
      turnId: 'turn-equality',
      explanation: 'Equality plan',
      steps: [{ step: 'First step', status: 'pending' as const }],
    };
    const meta = {
      tool: 'spawn_agent',
      prompt: 'Inspect equality',
      senderThreadId: threadId,
      receiverThreadIds: ['child-one'],
      agentStatus: 'running' as const,
    };
    const message = {
      id: 'equality-message',
      role: 'assistant' as const,
      content: 'Equality answer',
      createdAt: now,
      systemKind: 'subAgent' as const,
      subAgentMeta: meta,
    };
    const snapshots: Chat[] = [
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [message] },
      { ...baseChat, latestPlan: { ...plan, threadId: 'different-thread' }, latestTurnPlan: plan, messages: [message] },
      { ...baseChat, latestPlan: { ...plan, turnId: 'different-turn' }, latestTurnPlan: plan, messages: [message] },
      { ...baseChat, latestPlan: { ...plan, explanation: 'Different explanation' }, latestTurnPlan: plan, messages: [message] },
      { ...baseChat, latestPlan: { ...plan, steps: [...plan.steps, { step: 'Second', status: 'completed' }] }, latestTurnPlan: plan, messages: [message] },
      { ...baseChat, latestPlan: { ...plan, steps: [{ ...plan.steps[0], step: 'Changed step' }] }, latestTurnPlan: plan, messages: [message] },
      { ...baseChat, latestPlan: { ...plan, steps: [{ ...plan.steps[0], status: 'completed' }] }, latestTurnPlan: plan, messages: [message] },
      { ...baseChat, latestPlan: null, latestTurnPlan: plan, messages: [message] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: null, messages: [message] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, id: 'different-id' }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, role: 'user' }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, content: 'Different content' }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, createdAt: `${now}-later` }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, systemKind: undefined }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, subAgentMeta: undefined }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, subAgentMeta: { ...meta, tool: 'other' } }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, subAgentMeta: { ...meta, prompt: 'Other prompt' } }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, subAgentMeta: { ...meta, senderThreadId: 'other' } }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, subAgentMeta: { ...meta, agentStatus: 'complete' } }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, subAgentMeta: { ...meta, receiverThreadIds: [] } }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, subAgentMeta: { ...meta, receiverThreadIds: ['child-two'] } }] },
      { ...baseChat, status: 'running', messages: [
        { id: 'recent-user', role: 'user', content: 'Do not lose this', createdAt: new Date().toISOString() },
        message,
      ] },
      { ...baseChat, status: 'running', messages: [message] },
    ];
    const api = createApi();
    api.getChat.mockReset();
    for (const snapshot of snapshots) api.getChat.mockResolvedValueOnce(snapshot);
    const harness = await renderMain({ api, chat: snapshots[0] });

    for (let index = 1; index < snapshots.length; index += 1) {
      await act(async () => {
        harness.ref.current?.openChat(threadId);
        await flush();
      });
    }
    expect(api.getChat).toHaveBeenCalled();
    harness.unmount();
  });

  it('renders mixed user-input fields, presets, secret, other, validation, pressed, and resolving states', async () => {
    const api = createApi();
    const pendingResolution = deferred<{ ok: boolean }>();
    api.resolveUserInput.mockReturnValueOnce(pendingResolution.promise);
    const harness = await renderMain({ api, chat: baseChat });
    await harness.emit({
      method: 'bridge/userInput.requested',
      params: {
        id: 'input-final', agentId: 'codex', threadId, turnId: 'turn-input', itemId: 'input-item', requestedAt: now,
        questions: [
          {
            id: 'choice', header: 'Choice', question: 'Pick one', required: true,
            isOther: true, isSecret: false, fieldType: 'string', defaultValue: null,
            options: [
              { value: 'alpha', label: 'Alpha', description: '' },
              { value: 'beta', label: 'Beta', description: 'Second option' },
            ],
          },
          {
            id: 'secret', header: 'Secret', question: 'Secret value', required: false,
            isOther: false, isSecret: true, fieldType: 'string', defaultValue: null, options: null,
          },
          {
            id: 'amount', header: 'Amount', question: 'Decimal amount', required: false,
            isOther: false, isSecret: false, fieldType: 'number', defaultValue: null, options: null,
          },
          {
            id: 'count', header: 'Count', question: 'Integer count', required: false,
            isOther: false, isSecret: false, fieldType: 'integer', defaultValue: null, options: null,
          },
        ],
      },
    });
    exercisePressedStyles(harness.root);
    await press(labeled(harness.root, 'Alpha'));
    const fields = harness.root.findAllByType(TextInput) as TextInputNode[];
    await act(async () => {
      fields.find((node) => node.props.accessibilityLabel === 'Secret')?.props.onChangeText('token');
      fields.find((node) => node.props.accessibilityLabel === 'Amount')?.props.onChangeText('1.5');
      fields.find((node) => node.props.accessibilityLabel === 'Count')?.props.onChangeText('2');
      await flush();
    });
    const submitAnswers = harness.root.findAll((node) => node.children.includes('Submit answers'))[0];
    if (submitAnswers) {
      await press(submitAnswers);
      const resolvingSubmit = harness.root.findAll((node) => node.children.includes('Submitting…'))[0];
      if (resolvingSubmit) await press(resolvingSubmit);
      await act(async () => {
        pendingResolution.resolve({ ok: true });
        await flush();
      });
    }
    exercisePressedStyles(harness.root);
    harness.unmount();
  });

  it('implements and dismisses a completed plan prompt and exercises compose selection controls', async () => {
    const completedPlan = {
      threadId,
      turnId: 'turn-completed-plan',
      explanation: 'Ready for implementation',
      steps: [{ step: 'Ship implementation', status: 'completed' as const }],
    };
    const planned: Chat = {
      ...baseChat,
      latestTurnPlan: completedPlan,
      latestTurnStatus: 'completed',
      acpMode: 'plan',
    };
    const api = createApi();
    const implement = await renderMain({ api, chat: planned });
    await implement.emit({ method: 'item/started', params: { threadId, turnId: completedPlan.turnId, item: { type: 'plan' } } });
    await implement.emit(agUi({ type: 'RUN_FINISHED', threadId, runId: 'run-plan' }, threadId, 'run-plan'));
    exercisePressedStyles(implement.root);
    const yes = implement.root.findAll((node) => node.children.includes('Yes, implement this plan'))[0];
    if (yes) await press(yes);
    implement.unmount();

    const stay = await renderMain({ chat: planned });
    await stay.emit({ method: 'item/started', params: { threadId, turnId: completedPlan.turnId, item: { type: 'plan' } } });
    await stay.emit(agUi({ type: 'RUN_FINISHED', threadId, runId: 'run-plan-stay' }, threadId, 'run-plan-stay'));
    exercisePressedStyles(stay.root);
    const no = stay.root.findAll((node) => node.children.includes('No, stay in Plan mode'))[0];
    if (no) await press(no);
    stay.unmount();

    const compose = await renderMain();
    exercisePressedStyles(compose.root);
    await press(labeled(compose.root, 'Agent, Codex'));
    await press(labeled(compose.root, 'Claude'));
    await press(labeledPrefix(compose.root, 'Agent mode, Default'));
    await press(labeled(compose.root, 'Plan mode'));
    await press(labeled(compose.root, 'Fast mode'));
    const suggestion = compose.root.findAll((node) =>
      String(node.props.accessibilityLabel ?? '').startsWith('Use suggestion:')
    )[0];
    if (suggestion) await press(suggestion);
    compose.unmount();
  });

  it('renders modal bridge UI and handles missing turn, retained actions, dismissals, and failures', async () => {
    const api = createApi();
    api.resolveBridgeUiSurface.mockRejectedValueOnce(new Error('action failed'));
    api.dismissBridgeUiSurface.mockRejectedValueOnce(new Error('dismiss failed'));
    const harness = await renderMain({ api, chat: baseChat });
    const surface = {
      id: 'modal-final',
      threadId,
      presentation: 'modal',
      title: 'Final modal',
      bodyMarkdown: 'Modal body',
      blocks: [],
      actions: [{ id: 'retain', label: 'Retain', dismissesSurface: false }],
      dismissible: true,
    };
    await harness.emit({ method: 'bridge/ui.present', params: surface });
    expect(bridgeModalProps).not.toBeNull();
    await act(async () => {
      await (bridgeModalProps?.onAction as (
        nextSurface: typeof surface,
        action: typeof surface.actions[number]
      ) => Promise<void>)(surface, surface.actions[0]);
      await flush();
    });
    await act(async () => {
      await (bridgeModalProps?.onDismiss as (nextSurface: typeof surface) => Promise<void>)(surface);
      await flush();
    });
    expect(api.resolveBridgeUiSurface).toHaveBeenCalledWith('modal-final', {
      threadId,
      turnId: null,
      actionId: 'retain',
    });
    expect(api.dismissBridgeUiSurface).toHaveBeenCalledWith('modal-final', threadId);

    api.resolveBridgeUiSurface.mockResolvedValueOnce({ ok: true });
    const dismissingSurface = {
      ...surface,
      id: 'modal-success',
      turnId: 'turn-modal-success',
      actions: [{ id: 'dismiss', label: 'Dismiss' }],
    };
    await harness.emit({ method: 'bridge/ui.present', params: dismissingSurface });
    await act(async () => {
      await (bridgeModalProps?.onAction as (
        nextSurface: typeof dismissingSurface,
        action: typeof dismissingSurface.actions[number]
      ) => Promise<void>)(dismissingSurface, dismissingSurface.actions[0]);
      await flush();
    });
    expect(api.resolveBridgeUiSurface).toHaveBeenLastCalledWith('modal-success', {
      threadId,
      turnId: 'turn-modal-success',
      actionId: 'dismiss',
    });
    harness.unmount();
  });
});