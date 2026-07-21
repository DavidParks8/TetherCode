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
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  readAsStringAsync: jest.fn().mockRejectedValue(new Error('missing')),
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('react-native-markdown-display', () => 'Markdown');
jest.mock('../../components/ChatMessage', () => ({
  ChatMessage: ({ message }: { message: { content: string } }) => message.content,
  ToolActivityGroup: () => null,
}));
let approvalBannerProps: Record<string, unknown> | null = null;
jest.mock('../../components/ApprovalBanner', () => ({
  ApprovalBanner: (props: Record<string, unknown>) => {
    approvalBannerProps = props;
    return null;
  },
}));
jest.mock('../../components/LoadingGlyph', () => ({ LoadingGlyph: () => null }));

type Queryable = ReactTestInstance & {
  children: unknown[];
  parent: Queryable | null;
  props: Record<string, unknown> & {
    onChangeText: (value: string) => void;
    onPress: () => void;
  };
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByType(type: unknown): Queryable[];
};

const theme = createAppTheme('dark');
const capabilities: BridgeCapabilities = {
  protocolVersion: 2,
  streamId: 'stream-1',
  preferredAgentId: 'codex',
  activeAgentId: 'codex',
  agents: [
    {
      agentId: 'codex',
      displayName: 'Codex',
      version: '1.0.0',
      provenance: 'test',
      lifecycle: 'ready',
    },
  ],
  supportsByAgent: {
    codex: {
      turnSteer: true,
      planMode: true,
      reviewStart: true,
      goalSlash: true,
      fastMode: true,
      commandOutputDelta: true,
      browserPreview: true,
      genericUiSurface: true,
    },
  },
  agUiEvents: true,
  supports: {
    turnSteer: true,
    planMode: true,
    reviewStart: true,
    goalSlash: true,
    fastMode: true,
    commandOutputDelta: true,
    browserPreview: true,
    genericUiSurface: true,
  },
};
const chat: Chat = {
  id: 'thread-1',
  title: 'Real thread',
  status: 'complete',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  statusUpdatedAt: '2026-07-20T00:00:00.000Z',
  lastMessagePreview: 'Answer',
  cwd: '/workspace',
  agentId: 'codex',
  messages: [
    {
      id: 'message-1',
      role: 'assistant',
      content: 'Rendered answer',
      createdAt: '2026-07-20T00:00:00.000Z',
    },
  ],
};
const emptyQueue = {
  threadId: chat.id,
  items: [],
  pendingSteers: [],
  pendingSteerCount: 0,
  waitingForToolCalls: false,
  steeringInFlight: false,
  lastError: null,
};
let wsEventHandler: ((event: unknown) => void) | null = null;
let wsStatusHandler: ((connected: boolean) => void) | null = null;

function createApi(options: {
  capabilities?: BridgeCapabilities | Error;
  loadedChat?: Chat | Error;
  cachedChat?: Chat | null;
} = {}): HostBridgeApiClient {
  const loadedChat = options.loadedChat ?? chat;
  const methods: Record<string, jest.Mock> = {
    readBridgeCapabilities: jest.fn().mockImplementation(() => {
      const value = options.capabilities ?? capabilities;
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }),
    peekChat: jest.fn().mockReturnValue(options.cachedChat ?? null),
    peekChatShell: jest.fn().mockReturnValue(null),
    peekChatSummary: jest.fn().mockReturnValue(null),
    peekChats: jest.fn().mockReturnValue(null),
    peekAllChats: jest.fn().mockReturnValue(null),
    rememberChat: jest.fn(),
    getChat: jest.fn().mockImplementation(() =>
      loadedChat instanceof Error ? Promise.reject(loadedChat) : Promise.resolve(loadedChat)
    ),
    getChatSummary: jest.fn().mockResolvedValue(chat),
    listPendingApprovals: jest.fn().mockResolvedValue([]),
    listLoadedChatIds: jest.fn().mockResolvedValue([]),
    listPendingUserInputs: jest.fn().mockResolvedValue([]),
    listWorkspaceRoots: jest.fn().mockResolvedValue({
      bridgeRoot: '/workspace',
      allowOutsideRootCwd: false,
      workspaces: [],
    }),
    listFilesystemEntries: jest.fn().mockResolvedValue({
      bridgeRoot: '/workspace',
      path: '/workspace',
      parentPath: null,
      truncated: false,
      entries: [],
    }),
    listApprovals: jest.fn().mockResolvedValue([]),
    readThreadQueue: jest.fn().mockResolvedValue(emptyQueue),
    resolveApproval: jest.fn().mockResolvedValue({ ok: true }),
    resolveUserInput: jest.fn().mockResolvedValue({ ok: true }),
    steerQueuedThreadMessage: jest.fn().mockResolvedValue({ ok: true, queue: emptyQueue }),
    cancelQueuedThreadMessage: jest.fn().mockResolvedValue({ ok: true, queue: emptyQueue }),
    sendOrQueueChatMessage: jest.fn().mockResolvedValue({
      disposition: 'sent',
      queue: emptyQueue,
      turnId: 'turn-2',
      chat: { ...chat, status: 'running', activeTurnId: 'turn-2' },
    }),
    createChatIdempotent: jest.fn().mockResolvedValue({ ...chat, id: 'thread-created', messages: [] }),
    sendChatMessageIdempotent: jest.fn().mockResolvedValue({ ...chat, id: 'thread-created' }),
    interruptTurn: jest.fn().mockResolvedValue(true),
    interruptLatestTurn: jest.fn().mockResolvedValue('turn-1'),
  };
  return new Proxy(methods, {
    get(target, property) {
      if (typeof property !== 'string') return undefined;
      target[property] ??= jest.fn().mockResolvedValue(null);
      return target[property];
    },
  }) as unknown as HostBridgeApiClient;
}

function createWs(connected: boolean): HostBridgeWsClient {
  return {
    isConnected: connected,
    onEvent: jest.fn().mockImplementation((handler) => {
      wsEventHandler = handler;
      return jest.fn();
    }),
    onStatus: jest.fn().mockImplementation((handler) => {
      wsStatusHandler = handler;
      return jest.fn();
    }),
    acknowledgeSnapshotRecovery: jest.fn(),
  } as unknown as HostBridgeWsClient;
}

async function emitWs(event: unknown): Promise<void> {
  if (!wsEventHandler) throw new Error('Missing WS event handler');
  await act(async () => {
    wsEventHandler?.(event);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function pressLabel(root: Queryable, label: string): Promise<void> {
  const node = root.findAll((candidate) => candidate.props.accessibilityLabel === label)[0];
  if (!node) throw new Error(`Missing label: ${label}`);
  await act(async () => {
    (node.props.onPress as () => void)();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function hasText(root: Queryable, value: string): boolean {
  return root.findAll((node) => node.children.includes(value)).length > 0;
}

function messageInput(root: Queryable): Queryable {
  const input = root
    .findAllByType(TextInput)
    .find((node) => node.props.accessibilityLabel === 'Message');
  if (!input) throw new Error('Missing composer');
  return input;
}

function approvalRequested(id = 'approval-1'): unknown {
  return {
    method: 'bridge/approval.requested',
    params: {
      requestId: id,
      agentId: 'codex',
      kind: 'commandExecution',
      threadId: chat.id,
      turnId: 'turn-1',
      itemId: 'item-1',
      requestedAt: '2026-07-20T00:00:01.000Z',
      reason: 'Needs permission',
      command: 'npm test',
      cwd: '/workspace',
      options: [
        { id: 'allow-once', label: 'Allow once', kind: 'accept' },
        { id: 'decline', label: 'Decline', kind: 'decline' },
      ],
    },
  };
}

function userInputRequested(id = 'input-1'): unknown {
  return {
    method: 'bridge/userInput.requested',
    params: {
      requestId: id,
      agentId: 'codex',
      threadId: chat.id,
      turnId: 'turn-1',
      itemId: 'item-2',
      requestedAt: '2026-07-20T00:00:02.000Z',
      questions: [
        {
          id: 'strategy', header: 'Strategy', question: 'Choose a strategy.', required: true,
          isOther: false, isSecret: false, fieldType: 'string', defaultValue: null,
          options: [{ value: 'atomic', label: 'Atomic', description: 'One transaction.' }],
        },
      ],
    },
  };
}

async function renderMain(options: {
  api?: HostBridgeApiClient;
  connected?: boolean;
  pendingOpenChatId?: string | null;
  pendingOpenChatSnapshot?: Chat | null;
} = {}): Promise<{ tree: ReactTestRenderer; ref: { current: MainScreenHandle | null } }> {
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
            api={options.api ?? createApi()}
            ws={createWs(options.connected ?? true)}
            bridgeUrl="http://bridge"
            bridgeProfileId="profile-1"
            preferredAgentId="codex"
            onOpenDrawer={jest.fn()}
            onOpenGit={jest.fn()}
            pendingOpenChatId={options.pendingOpenChatId}
            pendingOpenChatSnapshot={options.pendingOpenChatSnapshot}
          />
        </AppThemeProvider>
      </SafeAreaProvider>
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!tree) throw new Error('Expected MainScreen tree');
  return { tree, ref };
}

describe('MainScreen shell behavior', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it.each([
    { connected: true },
    { connected: false },
  ])('renders the empty composer and connection recovery state', async ({ connected }) => {
    const { tree } = await renderMain({ connected });
    const root = tree.root as Queryable;

    expect(hasText(root, 'Bridge disconnected')).toBe(false);
    expect(root.findAllByType(TextInput).some((node) => node.props.placeholder === 'Message Codex...')).toBe(true);
    act(() => tree.unmount());
  });

  it('hydrates and renders a pending chat snapshot immediately', async () => {
    const { tree } = await renderMain({
      pendingOpenChatId: chat.id,
      pendingOpenChatSnapshot: chat,
    });
    const root = tree.root as Queryable;

    expect(hasText(root, 'Real thread')).toBe(true);
    expect(root.findAllByType(FlatList)[0]?.props.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.objectContaining({ content: 'Rendered answer' }) }),
      ])
    );
    expect(root.findAllByType(TextInput).some((node) => node.props.placeholder === 'Reply...')).toBe(true);
    act(() => tree.unmount());
  });

  it('loads a selected thread through the imperative shell handle', async () => {
    const api = createApi();
    const { tree, ref } = await renderMain({ api });

    await act(async () => {
      ref.current?.openChat(chat.id);
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(300);
      await Promise.resolve();
    });

    expect((api.getChat as jest.Mock)).toHaveBeenCalledWith(chat.id);
    expect((tree.root as Queryable).findAllByType(FlatList)[0]?.props.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.objectContaining({ content: 'Rendered answer' }) }),
      ])
    );
    act(() => tree.unmount());
  });

  it('surfaces a selected-thread load failure and keeps the new-chat composer available', async () => {
    const api = createApi({ loadedChat: new Error('bridge unavailable') });
    const { tree, ref } = await renderMain({ api });

    await act(async () => {
      ref.current?.openChat(chat.id);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hasText(tree.root as Queryable, 'bridge unavailable')).toBe(true);
    expect(
      (tree.root as Queryable).findAllByType(TextInput).some(
        (node) => node.props.placeholder === 'Message Codex...'
      )
    ).toBe(true);
    act(() => tree.unmount());
  });

  it('resolves approval requests delivered by the live bridge', async () => {
    const api = createApi();
    const { tree } = await renderMain({ api, pendingOpenChatId: chat.id, pendingOpenChatSnapshot: chat });
    await emitWs({
      method: 'bridge/approval.requested',
      params: {
        requestId: 'approval-1',
        agentId: 'codex',
        kind: 'commandExecution',
        threadId: chat.id,
        turnId: 'turn-1',
        itemId: 'item-1',
        title: 'Run tests',
        message: 'Needs permission',
        requestedAt: '2026-07-20T00:00:01.000Z',
        reason: 'Needs permission',
        command: 'npm test',
        cwd: '/workspace',
        options: [
          { id: 'allow-once', label: 'Allow once', kind: 'accept' },
          { id: 'decline', label: 'Decline', kind: 'decline' },
        ],
      },
    });
    expect(approvalBannerProps?.approval).toEqual(expect.objectContaining({ requestId: 'approval-1' }));
    await act(async () => {
      await (approvalBannerProps?.onResolve as (id: string, decision: string) => Promise<void>)(
        'approval-1',
        'allow-once'
      );
    });
    expect(api.resolveApproval).toHaveBeenCalledWith(
      'approval-1',
      'allow-once',
      expect.any(String)
    );
    act(() => tree.unmount());
  });

  it('validates and submits required bridge user input', async () => {
    const api = createApi();
    const { tree } = await renderMain({ api, pendingOpenChatId: chat.id, pendingOpenChatSnapshot: chat });
    const root = tree.root as Queryable;
    await emitWs({
      method: 'bridge/userInput.requested',
      params: {
        requestId: 'input-1',
        agentId: 'codex',
        threadId: chat.id,
        turnId: 'turn-1',
        itemId: 'item-2',
        requestedAt: '2026-07-20T00:00:02.000Z',
        questions: [
          {
            id: 'strategy', header: 'Strategy', question: 'Choose a strategy.', required: true,
            isOther: false, isSecret: false, fieldType: 'string', defaultValue: null,
            options: [{ value: 'atomic', label: 'Atomic', description: 'One transaction.' }],
          },
          {
            id: 'retries', header: 'Retries', question: 'How many retries?', required: true,
            isOther: false, isSecret: false, fieldType: 'integer', defaultValue: null, options: null,
          },
        ],
      },
    });
    await pressLabel(root, 'Atomic');
    const retries = root.findAllByType(TextInput).find((node) => node.props.accessibilityLabel === 'Retries');
    if (!retries) throw new Error('Missing retries input');
    act(() => retries.props.onChangeText('3'));
    const submitText = root.findAll((node) => node.children.includes('Submit answers'))[0];
    let submit = submitText as Queryable | null;
    while (submit && typeof submit.props.onPress !== 'function') submit = submit.parent as Queryable | null;
    await act(async () => {
      (submit?.props.onPress as () => void)();
      await Promise.resolve();
    });
    expect(api.resolveUserInput).toHaveBeenCalledWith('input-1', {
      answers: { strategy: 'atomic', retries: 3 },
    });
    act(() => tree.unmount());
  });

  it('steers and cancels queued messages from queue update events', async () => {
    const api = createApi();
    const { tree } = await renderMain({ api, pendingOpenChatId: chat.id, pendingOpenChatSnapshot: chat });
    const root = tree.root as Queryable;
    await emitWs({
      method: 'bridge/thread/queue/updated',
      params: {
        ...emptyQueue,
        items: [
          { id: 'queued-1', createdAt: '2026-07-20T00:00:03.000Z', content: 'Use the smaller implementation.' },
          { id: 'queued-2', createdAt: '2026-07-20T00:00:04.000Z', content: 'Then run tests.' },
        ],
      },
    });
    expect(hasText(root, 'Use the smaller implementation.')).toBe(true);
    expect(hasText(root, '+1 more queued')).toBe(true);
    await pressLabel(root, 'Steer queued message');
    expect(api.steerQueuedThreadMessage).toHaveBeenCalledWith(chat.id, 'queued-1');
    await emitWs({
      method: 'bridge/thread/queue/updated',
      params: { ...emptyQueue, items: [{ id: 'queued-1', createdAt: '2026-07-20T00:00:03.000Z', content: 'Cancel me.' }] },
    });
    await pressLabel(root, 'Cancel queued message');
    expect(api.cancelQueuedThreadMessage).toHaveBeenCalledWith(chat.id, 'queued-1');
    act(() => tree.unmount());
  });

  it('sends selected-thread messages and interrupts a known running turn', async () => {
    const runningChat = { ...chat, status: 'running' as const, activeTurnId: 'turn-1' };
    const api = createApi({ loadedChat: runningChat, cachedChat: runningChat });
    const { tree } = await renderMain({ api, pendingOpenChatId: chat.id, pendingOpenChatSnapshot: runningChat });
    const root = tree.root as Queryable;
    const message = root.findAllByType(TextInput).find((node) => node.props.accessibilityLabel === 'Message');
    if (!message) throw new Error('Missing composer');
    act(() => message.props.onChangeText('Follow up'));
    await pressLabel(root, 'Send message');
    expect(api.sendOrQueueChatMessage).toHaveBeenCalledWith(
      chat.id,
      expect.objectContaining({ content: 'Follow up', collaborationMode: 'default' }),
      expect.objectContaining({ submissionId: expect.any(String) })
    );
    await pressLabel(root, 'Stop agent');
    expect(api.interruptTurn).toHaveBeenCalledWith(chat.id, 'turn-2');
    act(() => tree.unmount());
  });

  it('creates a new thread and sends its first message with the selected controls', async () => {
    const api = createApi();
    const { tree } = await renderMain({ api });
    const root = tree.root as Queryable;

    await pressLabel(root, 'Fast mode');
    act(() => messageInput(root).props.onChangeText('Build the release checklist'));
    await pressLabel(root, 'Send message');

    expect(api.createChatIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'codex',
        approvalPolicy: 'untrusted',
        serviceTier: 'fast',
      }),
      expect.any(String)
    );
    expect(api.sendChatMessageIdempotent).toHaveBeenCalledWith(
      'thread-created',
      expect.objectContaining({
        content: 'Build the release checklist',
        collaborationMode: 'default',
        serviceTier: 'fast',
      }),
      expect.any(String),
      expect.any(Object)
    );
    expect(hasText(root, 'Real thread')).toBe(true);
    act(() => tree.unmount());
  });

  it.each([
    { stage: 'create', method: 'createChatIdempotent' },
    { stage: 'first send', method: 'sendChatMessageIdempotent' },
  ])('restores the new-thread draft when $stage fails', async ({ method }) => {
    const api = createApi();
    (api[method as keyof HostBridgeApiClient] as jest.Mock).mockRejectedValueOnce(
      new Error(`${method} failed`)
    );
    const { tree } = await renderMain({ api });
    const root = tree.root as Queryable;
    act(() => messageInput(root).props.onChangeText('Keep this draft'));

    await pressLabel(root, 'Send message');

    expect(messageInput(root).props.value).toBe('Keep this draft');
    expect(hasText(root, `${method} failed`)).toBe(true);
    act(() => tree.unmount());
  });

  it.each([
    { label: 'Cancel request', action: 'cancel' },
    { label: 'Decline request', action: 'decline' },
  ])('dismisses user input with the $action disposition', async ({ label, action }) => {
    const api = createApi();
    const { tree } = await renderMain({ api, pendingOpenChatId: chat.id, pendingOpenChatSnapshot: chat });
    const root = tree.root as Queryable;
    await emitWs(userInputRequested(`input-${action}`));

    await pressLabel(root, label);

    expect(api.resolveUserInput).toHaveBeenCalledWith(`input-${action}`, {
      answers: {},
      action,
    });
    expect(hasText(root, 'Clarification needed')).toBe(false);
    act(() => tree.unmount());
  });

  it('dismisses pending input and approval when resolved events arrive', async () => {
    const api = createApi();
    const { tree } = await renderMain({ api, pendingOpenChatId: chat.id, pendingOpenChatSnapshot: chat });
    const root = tree.root as Queryable;
    await emitWs(userInputRequested());
    expect(hasText(root, 'Clarification needed')).toBe(true);
    await emitWs({ method: 'bridge/userInput.resolved', params: { id: 'input-1' } });
    expect(hasText(root, 'Clarification needed')).toBe(false);

    await emitWs(approvalRequested());
    expect(approvalBannerProps?.approval).toEqual(expect.objectContaining({ requestId: 'approval-1' }));
    await emitWs({ method: 'bridge/approval.resolved', params: { id: 'approval-1' } });
    expect(api.resolveApproval).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('reuses the approval resolution id when a failed decision is retried', async () => {
    const api = createApi();
    (api.resolveApproval as jest.Mock)
      .mockRejectedValueOnce(new Error('approval offline'))
      .mockResolvedValueOnce({ ok: true });
    const { tree } = await renderMain({ api, pendingOpenChatId: chat.id, pendingOpenChatSnapshot: chat });
    await emitWs(approvalRequested('approval-retry'));
    const resolve = approvalBannerProps?.onResolve as (
      id: string,
      decision: string
    ) => Promise<void>;

    await expect(resolve('approval-retry', 'allow-once')).rejects.toThrow('approval offline');
    await resolve('approval-retry', 'allow-once');

    expect(api.resolveApproval).toHaveBeenNthCalledWith(
      2,
      'approval-retry',
      'allow-once',
      (api.resolveApproval as jest.Mock).mock.calls[0][2]
    );
    act(() => tree.unmount());
  });

  it('shows a queued send from the returned disposition and restores a failed queued draft', async () => {
    const runningChat = { ...chat, status: 'running' as const, activeTurnId: 'turn-1' };
    const queuedState = {
      ...emptyQueue,
      items: [{ id: 'queued-returned', createdAt: '2026-07-20T00:00:03.000Z', content: 'Queue this' }],
    };
    const api = createApi({ loadedChat: runningChat, cachedChat: runningChat });
    (api.sendOrQueueChatMessage as jest.Mock)
      .mockResolvedValueOnce({ disposition: 'queued', queue: queuedState })
      .mockRejectedValueOnce(new Error('queue unavailable'));
    const { tree } = await renderMain({ api, pendingOpenChatId: chat.id, pendingOpenChatSnapshot: runningChat });
    const root = tree.root as Queryable;
    act(() => messageInput(root).props.onChangeText('Queue this'));

    await pressLabel(root, 'Send message');
    expect(hasText(root, 'Queue this')).toBe(true);
    expect(messageInput(root).props.value).toBe('');

    act(() => messageInput(root).props.onChangeText('Retry this queue'));
    await pressLabel(root, 'Send message');
    expect(messageInput(root).props.value).toBe('Retry this queue');
    expect(hasText(root, 'queue unavailable')).toBe(true);
    act(() => tree.unmount());
  });

  it('converges reconnect, thread rename, and terminal status events', async () => {
    const completedSummary = { ...chat, title: 'Renamed remotely', status: 'complete' as const };
    const api = createApi();
    (api.getChatSummary as jest.Mock).mockResolvedValue(completedSummary);
    const { tree } = await renderMain({
      api,
      connected: false,
      pendingOpenChatId: chat.id,
      pendingOpenChatSnapshot: chat,
    });
    const root = tree.root as Queryable;
    (api.getChat as jest.Mock).mockClear();

    await act(async () => {
      wsStatusHandler?.(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.getChat).not.toHaveBeenCalled();

    await emitWs({
      method: 'thread/name/updated',
      params: { threadId: chat.id, threadName: 'Renamed remotely' },
    });
    expect(hasText(root, 'Renamed remotely')).toBe(true);

    await emitWs({
      method: 'thread/status/changed',
      params: { threadId: chat.id, status: 'completed' },
    });
    expect(api.getChatSummary).toHaveBeenCalledWith(chat.id);
    expect(hasText(root, 'Turn completed')).toBe(true);
    act(() => tree.unmount());
  });
});