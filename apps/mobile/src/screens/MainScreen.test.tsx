import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { AppState, FlatList, Pressable, TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { HostBridgeApiClient } from '../api/client';
import { createActivityMessage, SUBAGENT_ACTIVITY_TYPE } from '../api/messages';
import type {
  BridgeCapabilities,
  BridgeUiAction,
  BridgeUiSurface,
  Chat,
  ChatSummary,
} from '../api/types';
import type { HostBridgeWsClient } from '../api/ws';
import { ChatMessage } from '../components/ChatMessage';
import { AppThemeProvider, createAppTheme } from '../theme';
import { MainScreen, type MainScreenHandle } from './MainScreen';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: Object.assign(() => null, { glyphMap: {} }),
}));
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
  getInfoAsync: jest.fn(),
}));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));
jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  ImageManipulator: {
    manipulate: jest.fn(() => ({
      resize: jest.fn(),
      renderAsync: jest.fn().mockResolvedValue({
        saveAsync: jest.fn().mockResolvedValue({ uri: 'file:///prepared.jpg' }),
      }),
    })),
  },
}));
jest.mock('react-native-markdown-display', () => 'Markdown');
jest.mock('../components/ChatMessage', () => ({
  ChatMessage: ({ message }: { message: { content: string | { text?: unknown } } }) =>
    typeof message.content === 'string'
      ? message.content
      : typeof message.content.text === 'string'
        ? message.content.text
        : '',
  ToolActivityGroup: ({ events }: { events?: unknown[] }) =>
    `activities:${String((events ?? []).length)}`,
}));

let approvalBannerProps: Record<string, unknown> | null = null;
let mockApprovalProps: Record<string, unknown> | null = null;
jest.mock('../components/ApprovalBanner', () => ({
  ApprovalBanner: (props: Record<string, unknown>) => {
    approvalBannerProps = props;
    mockApprovalProps = props;
    const approval = props.approval as { reason?: unknown; message?: unknown; title?: unknown } | undefined;
    return (
      (typeof approval?.reason === 'string' && approval.reason) ||
      (typeof approval?.message === 'string' && approval.message) ||
      (typeof approval?.title === 'string' && approval.title) ||
      null
    );
  },
}));

jest.mock('../components/LoadingGlyph', () => ({ LoadingGlyph: () => null }));

let mockBridgeUiProps: {
  surface: BridgeUiSurface;
  onAction: (surface: BridgeUiSurface, action: BridgeUiAction) => void;
  onDismiss: (surface: BridgeUiSurface) => void;
}[] = [];
let bridgeModalProps: Record<string, unknown> | null = null;
jest.mock('../components/BridgeUiSurface', () => ({
  BridgeUiBanner: (props: {
    surface: BridgeUiSurface;
    onAction: (surface: BridgeUiSurface, action: BridgeUiAction) => void;
    onDismiss: (surface: BridgeUiSurface) => void;
  }) => {
    mockBridgeUiProps.push(props);
    return props.surface.title;
  },
  BridgeUiModal: (props: {
    surface: BridgeUiSurface;
    onAction: (surface: BridgeUiSurface, action: BridgeUiAction) => void;
    onDismiss: (surface: BridgeUiSurface) => void;
  }) => {
    mockBridgeUiProps.push(props);
    bridgeModalProps = props as unknown as Record<string, unknown>;
    return props.surface.title;
  },
  BridgeUiWorkflowCard: (props: {
    surface: BridgeUiSurface;
    onAction: (surface: BridgeUiSurface, action: BridgeUiAction) => void;
    onDismiss: (surface: BridgeUiSurface) => void;
  }) => {
    mockBridgeUiProps.push(props);
    return props.surface.title;
  },
}));

(() => {
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

function textCount(root: Queryable, value: string): number {
  return root.findAll((node) => node.children.includes(value)).length;
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
            bridgeUrl="https://bridge.test"
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

  it('shows the first new-chat message immediately and reconciles the server echo once', async () => {
    let resolveCreate!: (chat: Chat) => void;
    const createPending = new Promise<Chat>((resolve) => {
      resolveCreate = resolve;
    });
    const serverUserMessage = {
      id: 'server-user',
      role: 'user' as const,
      content: 'Immediate hello',
      createdAt: '2026-07-20T00:00:01.000Z',
    };
    const created = {
      ...chat,
      id: 'thread-created',
      title: 'Real thread',
      messages: [serverUserMessage],
    };
    const api = createApi();
    api.createChatIdempotent = jest.fn().mockReturnValue(createPending);
    api.sendChatMessageIdempotent = jest.fn().mockResolvedValue(created);
    const { tree } = await renderMain({ api });
    const root = tree.root as Queryable;

    act(() => messageInput(root).props.onChangeText('Immediate hello'));
    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = (root.findAll((candidate) => candidate.props.accessibilityLabel === 'Send message')[0]
        ?.props.onPress as (() => Promise<void>))();
      await Promise.resolve();
    });

    expect(hasText(root, 'Immediate hello')).toBe(true);
    expect(textCount(root, 'Immediate hello')).toBe(1);

    await act(async () => {
      resolveCreate(created);
      await sendPromise;
    });

    expect(textCount(root, 'Immediate hello')).toBe(1);
    expect(hasText(root, 'Real thread')).toBe(true);
    act(() => tree.unmount());
  });

  it.each([
    { stage: 'create', method: 'createChatIdempotent' },
    { stage: 'first send', method: 'sendChatMessageIdempotent' },
  ])('restores the new-thread draft when $stage fails', async ({ stage, method }) => {
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
    if (stage === 'create') {
      expect(textCount(root, 'Keep this draft')).toBe(0);
    }
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

})();

(() => {
type Queryable = ReactTestInstance & {
  children: unknown[];
  props: Record<string, unknown> & {
    onChangeText: (value: string) => void;
    onOpenLocalPreview: (url: string) => void;
    onPress: () => void;
    onSubmitEditing: () => void;
    message: { id: string };
  };
  parent: Queryable | null;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByType(type: unknown): Queryable[];
};

const theme = createAppTheme('dark');
const rootChat: Chat = {
  id: 'thread-root',
  title: 'Root thread',
  status: 'complete',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  statusUpdatedAt: '2026-07-20T00:00:00.000Z',
  lastMessagePreview: 'Preview at http://127.0.0.1:5173',
  cwd: '/workspace',
  agentId: 'codex',
  messages: [
    {
      id: 'message-root',
      role: 'assistant',
      content: 'Preview at http://127.0.0.1:5173',
      createdAt: '2026-07-20T00:00:00.000Z',
    },
  ],
};
const subAgentChat: Chat = {
  ...rootChat,
  id: 'thread-sub',
  title: 'Research dependency options',
  parentThreadId: rootChat.id,
  subAgentDepth: 1,
  agentRole: 'researcher',
  lastMessagePreview: 'Found three options',
  messages: [
    {
      id: 'message-sub',
      role: 'assistant',
      content: 'Sub-agent preview at http://localhost:4173',
      createdAt: '2026-07-20T00:00:01.000Z',
    },
  ],
};
const emptyQueue = {
  threadId: rootChat.id,
  items: [],
  pendingSteers: [],
  pendingSteerCount: 0,
  waitingForToolCalls: false,
  steeringInFlight: false,
  lastError: null,
};

function capabilities(
  agents: BridgeCapabilities['agents'] = [
    {
      agentId: 'codex',
      displayName: 'Codex',
      version: '1.0.0',
      provenance: 'local',
      lifecycle: 'ready',
    },
  ]
): BridgeCapabilities {
  const supports = {
    reviewStart: true,
    planMode: true,
    agentList: true,
    turnSteer: true,
    commandOutputDelta: true,
    fastMode: true,
    browserPreview: true,
    genericUiSurface: true,
  };
  return {
    protocolVersion: 2,
    streamId: 'stream-1',
    preferredAgentId: 'codex',
    activeAgentId: 'codex',
    agents,
    supportsByAgent: Object.fromEntries(agents.map((agent) => [agent.agentId, supports])),
    agUiEvents: true,
    supports,
  };
}

function createApi(options: {
  bridgeCapabilities?: BridgeCapabilities | Error;
  chats?: ChatSummary[];
  filesystem?: Array<{
    bridgeRoot: string;
    path: string;
    parentPath: string | null;
    truncated: boolean;
    entries: Array<{ name: string; path: string; isDirectory: boolean; isGitRepo: boolean }>;
  }>;
} = {}): HostBridgeApiClient {
  const chats = options.chats ?? [];
  const filesystem = options.filesystem ?? [
    {
      bridgeRoot: '/workspace',
      path: '/workspace',
      parentPath: null,
      truncated: false,
      entries: [
        { name: 'mobile', path: '/workspace/mobile', isDirectory: true, isGitRepo: true },
      ],
    },
  ];
  const methods: Record<string, jest.Mock> = {
    readBridgeCapabilities: jest.fn().mockImplementation(() => {
      const result = options.bridgeCapabilities ?? capabilities();
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    }),
    listWorkspaceRoots: jest.fn().mockResolvedValue({
      bridgeRoot: '/workspace',
      allowOutsideRootCwd: false,
      workspaces: [{ path: '/workspace/recent', chatCount: 2 }],
    }),
    listFilesystemEntries: jest.fn()
      .mockImplementation((request: { path?: string | null }) => {
        const response = filesystem.find((entry) => entry.path === (request.path ?? '/workspace'));
        return response
          ? Promise.resolve(response)
          : Promise.reject(new Error(`Cannot browse ${request.path ?? 'default'}`));
      }),
    execTerminal: jest.fn().mockResolvedValue({
      code: 0,
      stdout: 'apps/mobile/src/screens/MainScreen.tsx\nREADME.md\n',
      stderr: '',
    }),
    uploadAttachment: jest.fn().mockResolvedValue({
      path: '/uploads/report.txt',
      kind: 'file',
    }),
    gitClone: jest.fn().mockResolvedValue({ ok: true, cwd: '/workspace/cloned-repo' }),
    listChats: jest.fn().mockResolvedValue(chats),
    listLoadedChatIds: jest.fn().mockResolvedValue([]),
    getChatSummaries: jest.fn().mockResolvedValue([]),
    getChat: jest.fn().mockImplementation((id: string) =>
      Promise.resolve(id === subAgentChat.id ? subAgentChat : rootChat)
    ),
    getChatSummary: jest.fn().mockResolvedValue(rootChat),
    peekChat: jest.fn().mockImplementation((id: string) =>
      id === rootChat.id ? rootChat : null
    ),
    peekChatShell: jest.fn().mockReturnValue(null),
    peekChatSummary: jest.fn().mockReturnValue(null),
    rememberChat: jest.fn(),
    listPendingApprovals: jest.fn().mockResolvedValue([]),
    listApprovals: jest.fn().mockResolvedValue([]),
    readThreadQueue: jest.fn().mockResolvedValue(emptyQueue),
    createChatIdempotent: jest.fn().mockResolvedValue({
      ...rootChat,
      id: 'thread-created',
      messages: [],
    }),
    sendChatMessageIdempotent: jest.fn().mockResolvedValue(rootChat),
    sendOrQueueChatMessage: jest.fn().mockResolvedValue({
      disposition: 'sent',
      queue: emptyQueue,
      turnId: 'turn-1',
      chat: rootChat,
    }),
  };
  return new Proxy(methods, {
    get(target, property) {
      if (typeof property !== 'string') return undefined;
      target[property] ??= jest.fn().mockResolvedValue(null);
      return target[property];
    },
  }) as unknown as HostBridgeApiClient;
}

function createWs(): HostBridgeWsClient {
  return {
    isConnected: true,
    onEvent: jest.fn().mockReturnValue(jest.fn()),
    onStatus: jest.fn().mockReturnValue(jest.fn()),
    acknowledgeSnapshotRecovery: jest.fn(),
  } as unknown as HostBridgeWsClient;
}

async function renderMain(options: {
  api?: HostBridgeApiClient;
  defaultStartCwd?: string | null;
  selectedChat?: Chat | null;
  onDefaultStartCwdChange?: jest.Mock;
  onOpenLocalPreview?: jest.Mock;
} = {}): Promise<{ tree: ReactTestRenderer; api: HostBridgeApiClient }> {
  const api = options.api ?? createApi();
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
            api={api}
            ws={createWs()}
            bridgeUrl="https://bridge.test"
            bridgeProfileId="profile-1"
            preferredAgentId="codex"
            defaultStartCwd={options.defaultStartCwd}
            pendingOpenChatId={options.selectedChat?.id}
            pendingOpenChatSnapshot={options.selectedChat}
            onOpenDrawer={jest.fn()}
            onOpenGit={jest.fn()}
            onDefaultStartCwdChange={options.onDefaultStartCwdChange}
            onOpenLocalPreview={options.onOpenLocalPreview}
          />
        </AppThemeProvider>
      </SafeAreaProvider>
    );
    await flush();
  });
  if (!tree) throw new Error('Expected MainScreen renderer');
  return { tree, api };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function rootOf(tree: ReactTestRenderer): Queryable {
  return tree.root as Queryable;
}

function byLabel(root: Queryable, label: string): Queryable {
  const node = root.findAll((candidate) => candidate.props.accessibilityLabel === label)[0];
  if (!node) throw new Error(`Missing accessibility label: ${label}`);
  return node;
}

function byLabelPrefix(root: Queryable, prefix: string): Queryable {
  const node = root.findAll((candidate) =>
    String(candidate.props.accessibilityLabel ?? '').startsWith(prefix)
  )[0];
  if (!node) throw new Error(`Missing accessibility label prefix: ${prefix}`);
  return node;
}

function textInput(root: Queryable, label: string): Queryable {
  const input = root.findAllByType(TextInput).find((node) => node.props.accessibilityLabel === label);
  if (!input) throw new Error(`Missing input: ${label}`);
  return input;
}

function hasText(root: Queryable, text: string): boolean {
  return root.findAll((node) => node.children.includes(text)).length > 0;
}

function pressForText(root: Queryable, text: string): Queryable {
  const textNode = root.findAll((node) => node.children.includes(text))[0];
  if (!textNode) throw new Error(`Missing text: ${text}`);
  let pressable: Queryable | null = textNode;
  while (pressable && typeof pressable.props.onPress !== 'function') {
    pressable = pressable.parent;
  }
  if (!pressable) throw new Error(`Missing pressable for text: ${text}`);
  return pressable;
}

async function press(node: Queryable): Promise<void> {
  await act(async () => {
    (node.props.onPress as () => void)();
    await flush();
  });
}

async function advance(ms = 250): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await flush();
  });
}

describe('MainScreen controls and modals', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({
      exists: true,
      isDirectory: false,
      size: 1024,
    });
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({ canceled: true, assets: [] });
    (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValue({ canceled: true, assets: [] });
    (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValue({ canceled: true, assets: [] });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('drives ready, multiple, unavailable, mode, default-model, and fast controls', async () => {
    const agents: BridgeCapabilities['agents'] = [
      { agentId: 'codex', displayName: 'Codex', version: '1', provenance: 'local', lifecycle: 'ready' },
      { agentId: 'claude', displayName: 'Claude', version: '2', provenance: 'npm', lifecycle: 'ready' },
      { agentId: 'offline', displayName: 'Offline', version: '3', provenance: 'npm', lifecycle: 'unavailable', lastError: 'missing' },
    ];
    const { tree } = await renderMain({ api: createApi({ bridgeCapabilities: capabilities(agents) }) });
    const root = rootOf(tree);

    await press(byLabel(root, 'Agent, Codex'));
    expect(hasText(root, 'Select agent')).toBe(true);
    expect(root.findAll((node) => node.props.accessibilityLabel === 'Offline')).toHaveLength(0);
    await press(byLabel(root, 'Claude'));
    expect(byLabel(root, 'Agent, Claude')).toBeTruthy();

    await press(byLabelPrefix(root, 'Agent mode, '));
    await press(byLabel(root, 'Plan mode'));
    expect(byLabel(root, 'Agent mode, Plan mode')).toBeTruthy();
    await press(byLabel(root, 'Fast mode'));
    expect(byLabel(root, 'Fast mode').props.accessibilityState).toEqual(
      expect.objectContaining({ checked: true })
    );

    act(() => tree.unmount());

    const failed = await renderMain({ api: createApi({ bridgeCapabilities: new Error('capabilities unavailable') }) });
    expect(byLabelPrefix(rootOf(failed.tree), 'Agent mode, Default')).toBeTruthy();
    expect(rootOf(failed.tree).findAll((node) => node.props.accessibilityLabel === 'Fast mode')).toHaveLength(0);
    act(() => failed.tree.unmount());
  });

  it('uses the most recently persisted model for a new chat', async () => {
    (FileSystem.readAsStringAsync as jest.Mock).mockImplementation((path: string) => {
      if (path.endsWith('chat-model-preferences.json')) {
        return Promise.resolve(JSON.stringify({
          version: 1,
          entries: {
            older: {
              modelId: 'opencode/big-pickle', effort: null, serviceTier: null,
              updatedAt: '2026-07-20T00:00:00.000Z',
            },
            newest: {
              modelId: 'github-copilot/gpt-5.4', effort: 'high', serviceTier: null,
              updatedAt: '2026-07-22T00:00:00.000Z',
            },
          },
        }));
      }
      return Promise.reject(new Error('missing'));
    });
    const api = createApi();
    (api.listModelOptions as jest.Mock).mockResolvedValue([
      { id: 'opencode/big-pickle', displayName: 'Big Pickle', providerName: 'OpenCode Zen', isDefault: true },
      {
        id: 'github-copilot/gpt-5.4', displayName: 'GPT-5.4', providerName: 'GitHub Copilot',
        reasoningEffort: [{ effort: 'high' }],
      },
    ]);

    const { tree } = await renderMain({ api });
    const root = rootOf(tree);
    await act(async () => {
      await flush();
      await flush();
    });

    expect(byLabel(root, 'Model, GitHub Copilot · GPT-5.4')).toBeTruthy();
    expect(byLabel(root, 'Thinking level, High')).toBeTruthy();
    act(() => tree.unmount());
  });

  it('uses advertised ACP model, thinking, and primary mode controls', async () => {
    const configuredChat: Chat = {
      ...rootChat,
      acpConfig: [
        {
          id: 'model', value: 'github-copilot/gpt-5.4', category: 'model',
          options: [
            { value: 'github-copilot/gpt-5.4', name: 'GitHub Copilot/GPT-5.4' },
            { value: 'github-copilot/gpt-5-mini', name: 'GitHub Copilot/GPT-5 Mini' },
          ],
        },
        {
          id: 'effort', value: 'high', category: 'thought_level',
          options: [{ value: 'none', name: 'None' }, { value: 'high', name: 'High' }],
        },
        {
          id: 'mode', value: 'build', category: 'mode',
          options: [
            { value: 'build', name: 'build' },
            { value: 'plan', name: 'plan', description: 'Plan before changes.' },
          ],
        },
      ],
    };
    const api = createApi();
    (api.getChat as jest.Mock).mockResolvedValue(configuredChat);
    (api.peekChat as jest.Mock).mockReturnValue(configuredChat);
    (api.setThreadConfigOption as jest.Mock).mockResolvedValue(configuredChat);
    (api.listModelOptions as jest.Mock).mockResolvedValue([
      {
        id: 'github-copilot/gpt-5.4', displayName: 'GPT-5.4', providerName: 'GitHub Copilot',
        contextWindow: 1_050_000, reasoningEffort: [{ effort: 'none' }, { effort: 'high' }],
      },
      {
        id: 'github-copilot/gpt-5-mini', displayName: 'GPT-5 Mini', providerName: 'GitHub Copilot',
        contextWindow: 264_000, reasoningEffort: [{ effort: 'none' }, { effort: 'high' }],
      },
    ]);
    const { tree } = await renderMain({ api, selectedChat: configuredChat });
    const root = rootOf(tree);

    await press(byLabelPrefix(root, 'Model, '));
    await act(async () => {
      await flush();
      await flush();
    });
    expect(byLabel(root, 'GitHub Copilot · GPT-5.4')).toBeTruthy();
    await press(byLabel(root, 'GitHub Copilot · GPT-5 Mini'));
    expect(api.setThreadConfigOption).toHaveBeenCalledWith(
      configuredChat.id,
      'model',
      'github-copilot/gpt-5-mini'
    );

    await press(byLabelPrefix(root, 'Agent mode, '));
    await press(pressForText(root, 'plan'));
    expect(api.setThreadConfigOption).toHaveBeenCalledWith(configuredChat.id, 'mode', 'plan');

    await press(byLabelPrefix(root, 'Thinking level, '));
    await press(pressForText(root, 'High'));
    expect(api.setThreadConfigOption).toHaveBeenCalledWith(configuredChat.id, 'effort', 'high');

    act(() => tree.unmount());
  });

  it('renames the selected session from the chat header', async () => {
    const api = createApi();
    (api.renameChat as jest.Mock).mockResolvedValue({ ...rootChat, title: 'Manual title' });
    const { tree } = await renderMain({ api, selectedChat: rootChat });
    const root = rootOf(tree);

    await press(byLabel(root, 'Root thread, chat options'));
    expect(hasText(root, 'Rename session')).toBe(true);
    await act(async () => {
      textInput(root, 'Session title').props.onChangeText('Manual title');
      await flush();
    });
    await press(byLabel(root, 'Save session title'));
    expect(api.renameChat).toHaveBeenCalledWith(rootChat.id, 'Manual title');
    expect(hasText(root, 'Manual title')).toBe(true);
    act(() => tree.unmount());
  });

  it('browses, pins, selects, defaults, loads, and reports workspace failures', async () => {
    const onDefaultStartCwdChange = jest.fn();
    let resolveBrowse: ((value: unknown) => void) | undefined;
    const api = createApi();
    (api.listFilesystemEntries as jest.Mock)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveBrowse = resolve; }))
      .mockResolvedValueOnce({
        bridgeRoot: '/workspace',
        path: '/workspace/mobile',
        parentPath: '/workspace',
        truncated: true,
        totalEntries: 12,
        entries: [],
      })
      .mockRejectedValueOnce(new Error('browse denied'));
    const { tree } = await renderMain({ api, defaultStartCwd: '/workspace', onDefaultStartCwdChange });
    const root = rootOf(tree);

    await press(byLabelPrefix(root, 'Workspace, '));
    expect(root.findAll((node) => node.props.accessibilityRole === 'progressbar').length).toBeGreaterThan(0);
    await act(async () => {
      resolveBrowse?.({
        bridgeRoot: '/workspace',
        path: '/workspace',
        parentPath: null,
        truncated: false,
        entries: [{ name: 'mobile', path: '/workspace/mobile', isDirectory: true, isGitRepo: true }],
      });
      await flush();
    });
    await press(byLabel(root, 'Pin workspace'));
    expect(byLabel(root, 'Unpin workspace')).toBeTruthy();
    await press(byLabel(root, 'Open folder mobile'));
    expect(hasText(root, 'Showing 0 of 12 entries.')).toBe(true);
    await press(byLabel(root, 'Go to parent folder'));
    expect(hasText(root, 'browse denied')).toBe(true);
    await press(byLabel(root, 'Use default workspace'));
    expect(onDefaultStartCwdChange).toHaveBeenCalledWith(null);

    act(() => tree.unmount());
  });

  it('validates cloning, chooses a destination, and handles clone error and success', async () => {
    const onDefaultStartCwdChange = jest.fn();
    const api = createApi({
      filesystem: [
        {
          bridgeRoot: '/workspace', path: '/workspace', parentPath: null, truncated: false,
          entries: [{ name: 'destination', path: '/workspace/destination', isDirectory: true, isGitRepo: false }],
        },
        {
          bridgeRoot: '/workspace', path: '/workspace/destination', parentPath: '/workspace', truncated: false, entries: [],
        },
      ],
    });
    (api.gitClone as jest.Mock)
      .mockRejectedValueOnce(new Error('clone transport failed'))
      .mockResolvedValueOnce({
        code: 0,
        stdout: '',
        stderr: '',
        cloned: true,
        cwd: '/workspace/destination/repo',
        url: 'git@github.com:org/repo.git',
      });
    const { tree } = await renderMain({ api, defaultStartCwd: '/workspace', onDefaultStartCwdChange });
    const root = rootOf(tree);

    await press(byLabelPrefix(root, 'Workspace, '));
    await flush();
    await press(byLabel(root, 'Clone Repo'));
    await act(async () => {
      textInput(root, 'Repository URL').props.onChangeText('git@github.com:org/repo.git');
      await flush();
    });
    expect(textInput(root, 'Clone directory name').props.value).toBe('repo');
    await press(byLabelPrefix(root, 'Clone into '));
    await press(byLabel(root, 'Open folder destination'));
    await press(byLabel(root, 'Use destination workspace'));
    expect(hasText(root, 'Git checkout')).toBe(true);

    await press(pressForText(root, 'Clone and use'));
    expect(hasText(root, 'clone transport failed')).toBe(true);
    await advance(1);
    await press(pressForText(root, 'Clone and use'));
    await advance(1);
    expect(api.gitClone).toHaveBeenLastCalledWith({
      url: 'git@github.com:org/repo.git',
      parentPath: '/workspace/destination',
      directoryName: 'repo',
    });
    expect(onDefaultStartCwdChange).toHaveBeenCalledWith('/workspace/destination/repo');

    act(() => tree.unmount());
  });

  it('adds, removes, mentions, sends, uploads, and reports attachment failures', async () => {
    const api = createApi();
    const { tree } = await renderMain({ api, defaultStartCwd: '/workspace' });
    const root = rootOf(tree);
    const composer = textInput(root, 'Message');

    await act(async () => {
      composer.props.onChangeText('Review @MainScreen.tsx');
      await flush();
    });
    await press(byLabel(root, 'Add attachment'));
    await press(byLabel(root, 'Attach from workspace path'));
    await advance();
    await act(async () => {
      textInput(root, 'Workspace file path').props.onChangeText('apps/mobile/src/screens/MainScreen.tsx');
      await flush();
    });
    await act(async () => {
      textInput(root, 'Workspace file path').props.onSubmitEditing();
      await flush();
    });
    await press(byLabel(root, 'Send message'));
    expect(api.createChatIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/workspace' }),
      expect.any(String)
    );
    expect(api.sendChatMessageIdempotent).toHaveBeenCalledWith(
      'thread-created',
      expect.objectContaining({
        mentions: [{ path: '/workspace/apps/mobile/src/screens/MainScreen.tsx', name: 'MainScreen.tsx' }],
      }),
      expect.any(String),
      expect.any(Object)
    );

    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///report.txt', name: 'report.txt', mimeType: 'text/plain', size: 1024 }],
    });
    await press(byLabel(root, 'Add attachment'));
    await press(byLabel(root, 'Pick file from phone'));
    await advance();
    expect(api.uploadAttachment).toHaveBeenCalledWith(expect.objectContaining({
      uri: 'file:///report.txt',
      kind: 'file',
    }));

    (api.uploadAttachment as jest.Mock).mockRejectedValueOnce(new Error('upload failed'));
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///broken.txt', name: 'broken.txt', mimeType: 'text/plain', size: 1024 }],
    });
    await press(byLabel(root, 'Add attachment'));
    await press(byLabel(root, 'Pick file from phone'));
    await advance();
    expect(hasText(root, 'upload failed')).toBe(true);
    await press(byLabel(root, 'retry · broken.txt, remove attachment'));
    expect(root.findAll((node) => node.props.accessibilityLabel === 'retry · broken.txt, remove attachment')).toHaveLength(0);

    act(() => tree.unmount());
  });

  it('forwards browser previews and drives agent thread selector and detail callbacks', async () => {
    const onOpenLocalPreview = jest.fn();
    const chats: ChatSummary[] = [rootChat, subAgentChat];
    const api = createApi({ chats });
    const { tree } = await renderMain({ api, selectedChat: rootChat, onOpenLocalPreview });
    const root = rootOf(tree);
    await advance();

    const rootMessage = root.findAllByType(ChatMessage)[0];
    expect(rootMessage).toBeTruthy();
    act(() => rootMessage.props.onOpenLocalPreview('http://127.0.0.1:5173'));
    expect(onOpenLocalPreview).toHaveBeenCalledWith('http://127.0.0.1:5173');

    await act(async () => {
      await flush();
    });
    await press(byLabel(root, '1 agent'));
    expect(hasText(root, 'Agent threads')).toBe(true);
    await press(byLabel(root, 'Sub-agent 1'));
    expect(api.getChat).toHaveBeenCalledWith(subAgentChat.id, { forceRefresh: true });
    const detailMessage = root.findAllByType(ChatMessage).find((node) => node.props.message.id === 'message-sub');
    expect(detailMessage).toBeTruthy();
    expect(root.findAll((node) => node.props.accessibilityLabel === 'Refresh sub-agent transcript')).toHaveLength(0);
    expect(root.findAll((node) => node.props.accessibilityLabel === 'Open sub-agent as chat')).toHaveLength(0);
    act(() => detailMessage?.props.onOpenLocalPreview('http://localhost:4173'));
    expect(onOpenLocalPreview).toHaveBeenCalledWith('http://localhost:4173');
    await press(byLabel(root, 'Back from sub-agent transcript'));
    await advance(250);

    act(() => tree.unmount());
  });
});

})();

(() => {
type Queryable = ReactTestInstance & {
  children: unknown[];
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByType(type: unknown): Queryable[];
};

const theme = createAppTheme('dark');
const threadId = 'thread-events';
const otherThreadId = 'thread-other';
const capabilities: BridgeCapabilities = {
  protocolVersion: 2,
  streamId: 'events-stream',
  preferredAgentId: 'codex',
  activeAgentId: 'codex',
  agents: [{
    agentId: 'codex',
    displayName: 'Codex',
    version: '1',
    provenance: 'test',
    lifecycle: 'ready',
  }],
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
  id: threadId,
  title: 'Event thread',
  status: 'complete',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  statusUpdatedAt: '2026-07-20T00:00:00.000Z',
  lastMessagePreview: 'Existing answer',
  cwd: '/workspace',
  agentId: 'codex',
  messages: [{
    id: 'existing',
    role: 'assistant',
    content: 'Existing answer',
    createdAt: '2026-07-20T00:00:00.000Z',
  }],
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

let eventHandlers: Array<(event: unknown) => void> = [];
let statusHandlers: Array<(connected: boolean) => void> = [];
let appStateHandler: ((state: string) => void) | null = null;

function createApi(): HostBridgeApiClient {
  const methods: Record<string, jest.Mock> = {
    readBridgeCapabilities: jest.fn().mockResolvedValue(capabilities),
    peekChat: jest.fn().mockReturnValue(chat),
    peekChatShell: jest.fn().mockReturnValue(null),
    peekChatSummary: jest.fn().mockReturnValue(null),
    peekChats: jest.fn().mockReturnValue(null),
    peekAllChats: jest.fn().mockReturnValue(null),
    rememberChat: jest.fn(),
    getChat: jest.fn().mockResolvedValue(chat),
    getChatSummary: jest.fn().mockResolvedValue(chat),
    listPendingApprovals: jest.fn().mockResolvedValue([]),
    listLoadedChatIds: jest.fn().mockResolvedValue([]),
    listPendingUserInputs: jest.fn().mockResolvedValue([]),
    listWorkspaceRoots: jest.fn().mockResolvedValue({
      bridgeRoot: '/workspace', allowOutsideRootCwd: false, workspaces: [],
    }),
    listFilesystemEntries: jest.fn().mockResolvedValue({
      bridgeRoot: '/workspace', path: '/workspace', parentPath: null, truncated: false, entries: [],
    }),
    listApprovals: jest.fn().mockResolvedValue([]),
    readThreadQueue: jest.fn().mockResolvedValue(emptyQueue),
    dismissBridgeUiSurface: jest.fn().mockResolvedValue({ ok: true, id: 'surface', threadId }),
    resolveBridgeUiSurface: jest.fn().mockResolvedValue({ ok: true }),
  };
  return new Proxy(methods, {
    get(target, property) {
      if (typeof property !== 'string') return undefined;
      target[property] ??= jest.fn().mockResolvedValue(null);
      return target[property];
    },
  }) as unknown as HostBridgeApiClient;
}

function createWs(connected = true): HostBridgeWsClient {
  return {
    isConnected: connected,
    onEvent: jest.fn().mockImplementation((handler) => {
      eventHandlers.push(handler);
      return jest.fn();
    }),
    onStatus: jest.fn().mockImplementation((handler) => {
      statusHandlers.push(handler);
      return jest.fn();
    }),
    acknowledgeSnapshotRecovery: jest.fn(),
  } as unknown as HostBridgeWsClient;
}

async function renderMain(options: { api?: HostBridgeApiClient; connected?: boolean } = {}): Promise<{
  tree: ReactTestRenderer;
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
}> {
  const api = options.api ?? createApi();
  const ws = createWs(options.connected);
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(
      <SafeAreaProvider initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}>
        <AppThemeProvider theme={theme}>
          <MainScreen
            api={api}
            ws={ws}
            bridgeUrl="https://bridge.test"
            bridgeProfileId="profile-events"
            preferredAgentId="codex"
            onOpenDrawer={jest.fn()}
            onOpenGit={jest.fn()}
            pendingOpenChatId={threadId}
            pendingOpenChatSnapshot={chat}
          />
        </AppThemeProvider>
      </SafeAreaProvider>
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!tree) throw new Error('MainScreen did not render');
  return { tree, api, ws };
}

async function emit(event: unknown): Promise<void> {
  await act(async () => {
    eventHandlers.forEach((handler) => handler(event));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function agUi(event: Record<string, unknown>, targetThreadId = threadId, runId = 'run-events') {
  return {
    method: 'bridge/agui.event',
    params: { threadId: targetThreadId, runId, sourceTurnId: 'turn-events', event },
  };
}

function hasText(root: Queryable, text: string): boolean {
  return root.findAll((node) => node.children.includes(text)).length > 0;
}

function transcript(tree: ReactTestRenderer): Array<{ message: { content: string } }> {
  return ((tree.root as Queryable).findAllByType(FlatList)[0]?.props.data ?? []) as Array<{
    message: { content: string };
  }>;
}

function surface(id: string, title: string, presentation: 'banner' | 'modal' | 'workflowCard' = 'banner') {
  return {
    id,
    threadId,
    turnId: 'turn-events',
    presentation,
    title,
    bodyMarkdown: 'Provider-owned content',
    blocks: [],
    actions: [{ id: 'continue', label: 'Continue' }],
    dismissible: true,
  };
}

async function unmount(tree: ReactTestRenderer): Promise<void> {
  await act(async () => {
    tree.unmount();
    await Promise.resolve();
  });
}

describe('MainScreen live event handling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    eventHandlers = [];
    statusHandlers = [];
    mockBridgeUiProps = [];
    mockApprovalProps = null;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_, handler) => {
      appStateHandler = handler as (state: string) => void;
      return { remove: jest.fn() };
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('projects AG-UI lifecycle, text, reasoning, and tool events into the live transcript', async () => {
    const { tree, api } = await renderMain();
    const events = [
      agUi({ type: 'RUN_STARTED', threadId, runId: 'run-events' }),
      agUi({ type: 'TEXT_MESSAGE_START', messageId: 'live-answer', role: 'assistant' }),
      agUi({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'live-answer', delta: 'Streaming answer' }),
      agUi({ type: 'TEXT_MESSAGE_END', messageId: 'live-answer' }),
      agUi({ type: 'REASONING_MESSAGE_START', messageId: 'reasoning-live', role: 'assistant' }),
      agUi({ type: 'REASONING_MESSAGE_CONTENT', messageId: 'reasoning-live', delta: 'Checking constraints' }),
      agUi({ type: 'REASONING_MESSAGE_END', messageId: 'reasoning-live' }),
      agUi({ type: 'TOOL_CALL_START', toolCallId: 'tool-live', toolCallName: 'terminal' }),
      agUi({ type: 'TOOL_CALL_ARGS', toolCallId: 'tool-live', delta: '{"command":"npm test"}' }),
      agUi({ type: 'TOOL_CALL_END', toolCallId: 'tool-live' }),
      agUi({ type: 'TOOL_CALL_RESULT', messageId: 'tool-result', toolCallId: 'tool-live', content: 'Tests passed', role: 'tool' }),
    ];
    for (const event of events) await emit(event);

    expect(transcript(tree)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.objectContaining({ content: 'Streaming answer' }) }),
    ]));

    await emit(agUi({ type: 'RUN_FINISHED', threadId, runId: 'run-events' }));
    expect(hasText(tree.root as Queryable, 'Turn completed')).toBe(true);
    expect(api.getChat).toHaveBeenCalledWith(threadId);

    await emit(agUi({ type: 'RUN_ERROR', message: 'Provider failed', code: 'provider_error' }, otherThreadId, 'run-error'));
    await emit(agUi({ type: 'RUN_STARTED', threadId: otherThreadId, runId: 'run-other' }, otherThreadId, 'run-other'));
    await unmount(tree);
  });

  it('covers current and off-thread item, reasoning, plan, diff, and completion variants', async () => {
    const { tree } = await renderMain();
    const currentEvents = [
      { method: 'item/started', params: { threadId, turnId: 'turn-events', item: { type: 'commandExecution', command: 'npm test' } } },
      { method: 'item/started', params: { threadId, item: { type: 'fileChange', path: 'src/a.ts' } } },
      { method: 'item/started', params: { threadId, item: { type: 'mcpToolCall', server: 'docs', tool: 'search' } } },
      { method: 'item/started', params: { threadId, item: { type: 'toolCall', name: 'inspect' } } },
      { method: 'item/started', params: { threadId, turnId: 'turn-plan', item: { type: 'plan' } } },
      { method: 'item/started', params: { threadId, item: { type: 'reasoning' } } },
      { method: 'item/plan/delta', params: { threadId, turnId: 'turn-plan', delta: '1. Inspect\n2. Implement' } },
      { method: 'item/reasoning/summaryPartAdded', params: { threadId, itemId: 'reasoning-1', summaryIndex: 0 } },
      { method: 'item/reasoning/summaryTextDelta', params: { threadId, itemId: 'reasoning-1', summaryIndex: 0, delta: '**Inspecting** current behavior' } },
      { method: 'item/reasoning/summaryTextDelta', params: { threadId, itemId: 'reasoning-1', summaryIndex: 0, delta: ' and tests' } },
      { method: 'item/reasoning/textDelta', params: { threadId, delta: 'Detailed reasoning' } },
      { method: 'item/commandExecution/outputDelta', params: { threadId, itemId: 'command-1', delta: 'PASS' } },
      { method: 'item/commandExecution/terminalInteraction', params: { threadId, itemId: 'command-1', stdin: 'y' } },
      { method: 'item/mcpToolCall/progress', params: { threadId, itemId: 'mcp-1', message: 'Searching' } },
      { method: 'turn/plan/updated', params: { threadId, turnId: 'turn-plan', explanation: 'Execution plan', plan: [{ step: 'Inspect', status: 'completed' }, { step: 'Implement', status: 'inProgress' }] } },
      { method: 'turn/diff/updated', params: { threadId, turnId: 'turn-events', diff: 'diff --git a/a b/a' } },
      { method: 'item/completed', params: { threadId, item: { type: 'commandExecution', status: 'completed', command: 'npm test', exitCode: 0 } } },
      { method: 'item/completed', params: { threadId, item: { type: 'commandExecution', status: 'failed', command: 'npm test', exitCode: 1 } } },
      { method: 'item/completed', params: { threadId, item: { type: 'fileChange', path: 'src/a.ts', status: 'completed' } } },
      { method: 'item/completed', params: { threadId, item: { type: 'mcpToolCall', server: 'docs', tool: 'search', status: 'completed' } } },
      { method: 'item/completed', params: { threadId, item: { type: 'toolCall', name: 'inspect', status: 'completed' } } },
    ];
    const offThreadEvents = currentEvents.map((event) => ({
      ...event,
      params: { ...event.params, threadId: otherThreadId },
    }));
    for (const event of [...currentEvents, ...offThreadEvents]) await emit(event);

    expect(transcript(tree).some(({ message }) => message.content.includes('Detailed reasoning'))).toBe(true);
    await unmount(tree);
  });

  it('covers thread identity, queue, approval, input, and malformed notification branches', async () => {
    const api = createApi();
    const { tree } = await renderMain({ api });
    const identityEvents = [
      { method: 'thread/started', params: { threadId, parentThreadId: threadId } },
      { method: 'thread/started', params: { threadId: otherThreadId, parentThreadId: threadId } },
      { method: 'thread/name/updated', params: { threadId, threadName: 'Renamed by event' } },
      { method: 'thread/name/updated', params: { thread_id: threadId, thread_name: 'Snake case name' } },
    ];
    for (const event of identityEvents) await emit(event);
    expect(hasText(tree.root as Queryable, 'Snake case name')).toBe(true);

    const validEvents = [
      { method: 'thread/name/updated', params: { threadId, threadName: ' ' } },
      { method: 'thread/status/changed', params: { threadId, status: 'running' } },
      { method: 'thread/status/changed', params: { threadId, status: 'completed' } },
      { method: 'thread/status/changed', params: { threadId: otherThreadId, status: 'failed' } },
      { method: 'bridge/thread/queue/updated', params: { ...emptyQueue, items: [{ id: 'queued', createdAt: '2026-07-20T00:00:01.000Z', content: 'Queued event' }] } },
      { method: 'bridge/thread/queue/updated', params: { ...emptyQueue, threadId: otherThreadId } },
      { method: 'bridge/approval.requested', params: { requestId: 'approval-current', agentId: 'codex', kind: 'commandExecution', threadId, turnId: 'turn-events', itemId: 'command-current', title: 'Run tests', message: 'Run tests', requestedAt: '2026-07-20T00:00:02.000Z', command: 'npm test', options: [{ id: 'allow', label: 'Allow', kind: 'accept' }] } },
      { method: 'bridge/approval.requested', params: { requestId: 'approval-other', agentId: 'codex', kind: 'commandExecution', threadId: otherThreadId, turnId: 'turn-other', itemId: 'command-other', title: 'Approve', message: 'Approve', requestedAt: '2026-07-20T00:00:02.000Z', options: [] } },
    ];
    for (const event of validEvents) await emit(event);
    expect(mockApprovalProps?.approval).toEqual(expect.objectContaining({ requestId: 'approval-current' }));

    for (const event of [
      { method: 'bridge/userInput.requested', params: { requestId: 'input-current', agentId: 'codex', threadId, turnId: 'turn-events', itemId: 'input-current', message: 'Continue?', requestedAt: '2026-07-20T00:00:03.000Z', questions: [{ id: 'choice', header: 'Choose', question: 'Continue?', required: true, isOther: false, isSecret: false, fieldType: 'string', defaultValue: null, options: [{ value: 'yes', label: 'Yes' }] }] } },
      { method: 'bridge/userInput.requested', params: { requestId: 'input-other', agentId: 'codex', threadId: otherThreadId, turnId: 'turn-other', itemId: 'input-other', message: 'Why?', requestedAt: '2026-07-20T00:00:03.000Z', questions: [{ id: 'note', header: 'Note', question: 'Why?', required: false, isOther: false, isSecret: false, fieldType: 'string', defaultValue: null, options: null }] } },
    ]) await emit(event);
    const malformed = [
      { method: 'thread/name/updated', params: null },
      { method: 'thread/status/changed', params: {} },
      { method: 'thread/tokenUsage/updated', params: { threadId } },
      { method: 'item/started', params: {} },
      { method: 'item/plan/delta', params: {} },
      { method: 'item/reasoning/summaryPartAdded', params: {} },
      { method: 'item/reasoning/summaryTextDelta', params: {} },
      { method: 'item/reasoning/textDelta', params: {} },
      { method: 'item/commandExecution/outputDelta', params: {} },
      { method: 'item/commandExecution/terminalInteraction', params: {} },
      { method: 'item/mcpToolCall/progress', params: {} },
      { method: 'turn/plan/updated', params: {} },
      { method: 'turn/diff/updated', params: {} },
      { method: 'item/completed', params: {} },
      { method: 'bridge/thread/queue/updated', params: {} },
      { method: 'bridge/approval.requested', params: {} },
      { method: 'bridge/userInput.requested', params: {} },
      { method: 'bridge/userInput.resolved', params: {} },
      { method: 'bridge/approval.resolved', params: {} },
      { method: 'bridge/agui.event', params: {} },
      { method: 'unknown/event', params: {} },
    ];
    expect(hasText(tree.root as Queryable, 'Queued event')).toBe(true);
    expect(api.getChatSummary).toHaveBeenCalledWith(threadId);

    for (const event of [
      { method: 'bridge/userInput.resolved', params: { id: 'input-other' } },
      { method: 'bridge/userInput.resolved', params: { id: 'input-current' } },
      { method: 'bridge/approval.resolved', params: { id: 'approval-other' } },
      { method: 'bridge/approval.resolved', params: { id: 'approval-current' } },
      ...malformed,
    ]) await emit(event);
    await unmount(tree);
  });

  it('presents, updates, acts on, dismisses, and rejects bridge UI surfaces', async () => {
    const api = createApi();
    const { tree } = await renderMain({ api });
    await emit({ method: 'bridge/ui.present', params: surface('surface-1', 'Initial workflow', 'workflowCard') });
    expect(hasText(tree.root as Queryable, 'Initial workflow')).toBe(true);

    await emit({ method: 'bridge/ui.update', params: surface('surface-1', 'Updated workflow', 'workflowCard') });
    const updated = mockBridgeUiProps.find((props) => props.surface.title === 'Updated workflow');
    if (!updated) throw new Error('Updated bridge UI surface was not rendered');
    await act(async () => updated.onAction(updated.surface, updated.surface.actions[0]));
    expect(api.resolveBridgeUiSurface).toHaveBeenCalledWith('surface-1', {
      threadId, turnId: 'turn-events', actionId: 'continue',
    });

    await emit({ method: 'bridge/ui.present', params: surface('surface-2', 'Dismissible banner') });
    const dismissible = mockBridgeUiProps.find((props) => props.surface.id === 'surface-2');
    if (!dismissible) throw new Error('Dismissible bridge UI surface was not rendered');
    await act(async () => dismissible.onDismiss(dismissible.surface));
    expect(api.dismissBridgeUiSurface).toHaveBeenCalledWith('surface-2', threadId);

    await emit({ method: 'bridge/ui.present', params: { id: 'invalid' } });
    await emit({ method: 'bridge/ui.present', params: { ...surface('surface-other', 'Other'), threadId: otherThreadId } });
    await emit({ method: 'bridge/ui.dismiss', params: {} });
    await emit({ method: 'bridge/ui.dismiss', params: { id: 'surface-other' } });
    await emit({ method: 'bridge/ui.dismiss', params: { id: 'surface-1', threadId } });
    expect(hasText(tree.root as Queryable, 'Updated workflow')).toBe(false);
    await unmount(tree);
  });

  it('recovers snapshots and covers reconnect, disconnect, status callbacks, and app state', async () => {
    const api = createApi();
    const { tree, ws } = await renderMain({ api, connected: false });

    await emit({ method: 'bridge/events/snapshotRequired', params: { resumeAfterEventId: 41 } });
    await act(async () => {
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });
    expect(api.listApprovals).toHaveBeenCalled();
    expect(api.listPendingUserInputs).toHaveBeenCalled();
    expect(ws.acknowledgeSnapshotRecovery).toHaveBeenCalledWith(41);

    await act(async () => {
      statusHandlers.forEach((handler) => handler(true));
      statusHandlers.forEach((handler) => handler(false));
      appStateHandler?.('background');
      statusHandlers.forEach((handler) => handler(false));
      appStateHandler?.('active');
      jest.advanceTimersByTime(2_000);
      await Promise.resolve();
    });

    await emit({ method: 'bridge/connection/state', params: { status: 'connected' } });
    await emit({ method: 'bridge/connection/state', params: { status: 'disconnected' } });
    await emit({ method: 'bridge/connection/state', params: { status: 'unknown' } });
    await emit({ method: 'bridge/connection/state', params: null });
    expect(api.getChat).toHaveBeenCalled();
    await unmount(tree);
  });
});

})();

(() => {
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
  chat?: Chat | Error | null;
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
  const loaded = options.chat === undefined ? baseChat : options.chat;
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
      loaded instanceof Error ? Promise.reject(loaded) : Promise.resolve(loaded ?? baseChat)
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
  const api = options.api ?? createApi({ chat: options.chat });
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
            bridgeUrl="https://bridge.test"
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

describe('MainScreen runtime recovery and synchronization', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

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
    expect(input(harness.tree.root as Queryable).props.placeholder).toContain('Agent');
    expect(input(harness.tree.root as Queryable).props.placeholder).not.toContain('Unknown agent');
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
    expect(text(root, 'Runtime bridge surface')).toBe(true);
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

  it('renders /help and its local response in the selected chat', async () => {
    const harness = await renderMain({ chat: baseChat });
    const root = harness.tree.root as Queryable;

    act(() => (input(root).props.onChangeText as (value: string) => void)('/help'));
    await press(root, 'Send message');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const messages = transcript(root).map((entry) => entry.message.content);
    expect(messages).toContain('/help');
    expect(messages.some((message) => message.includes('Supported slash commands:'))).toBe(true);
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

})();

(() => {
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

describe('MainScreen workflows and edge cases', () => {
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
    const message = createActivityMessage(
      'equality-message',
      SUBAGENT_ACTIVITY_TYPE,
      { text: 'Equality answer', subAgent: meta },
      now
    );
    if (message.role !== 'activity') throw new Error('Expected activity message');
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
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ id: message.id, role: 'user', content: 'Equality answer', createdAt: now }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, content: { ...message.content, text: 'Different content' } }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, createdAt: `${now}-later` }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, activityType: 'other' }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, content: { ...message.content, subAgent: undefined } }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, content: { ...message.content, subAgent: { ...meta, tool: 'other' } } }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, content: { ...message.content, subAgent: { ...meta, prompt: 'Other prompt' } } }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, content: { ...message.content, subAgent: { ...meta, senderThreadId: 'other' } } }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, content: { ...message.content, subAgent: { ...meta, agentStatus: 'complete' } } }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, content: { ...message.content, subAgent: { ...meta, receiverThreadIds: [] } } }] },
      { ...baseChat, latestPlan: plan, latestTurnPlan: plan, messages: [{ ...message, content: { ...message.content, subAgent: { ...meta, receiverThreadIds: ['child-two'] } } }] },
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

})();
