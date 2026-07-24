import { ActionSheetIOS, AppState, Platform, RefreshControl } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { HostBridgeApiClient } from '../api/client';
import type {
  AgentDescriptor,
  ChatSummary,
  PendingApproval,
  PendingUserInputRequest,
  RpcNotification,
} from '../api/types';
import type { HostBridgeWsClient } from '../api/ws';
import { AppThemeProvider, createAppTheme } from '../theme';
import { DrawerContent } from './DrawerContent';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

type Queryable = ReactTestInstance & {
  type: unknown;
  children: unknown[];
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

const theme = createAppTheme('dark');
const listedChat: ChatSummary = {
  id: 'thread',
  title: 'Listed thread',
  status: 'complete',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  statusUpdatedAt: '2026-07-20T00:00:00.000Z',
  lastMessagePreview: 'done',
  cwd: '/workspace',
};

const readyAgents: AgentDescriptor[] = [
  {
    agentId: 'copilot',
    displayName: 'Copilot',
    version: '1',
    provenance: 'test',
    lifecycle: 'ready',
  },
  {
    agentId: 'codex',
    displayName: 'Codex',
    version: '1',
    provenance: 'test',
    lifecycle: 'ready',
  },
  {
    agentId: 'offline',
    displayName: 'Offline agent',
    version: '1',
    provenance: 'test',
    lifecycle: 'unavailable',
  },
];

interface DrawerHarness {
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
  emitEvent: (event: RpcNotification) => void;
  emitStatus: (connected: boolean) => void;
  cancelStream: jest.Mock;
}

function createChat(overrides: Partial<ChatSummary> = {}): ChatSummary {
  const id = overrides.id ?? 'thread';
  return {
    ...listedChat,
    id,
    title: overrides.title ?? `Chat ${id}`,
    createdAt: overrides.createdAt ?? '2026-07-20T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-07-20T00:00:00.000Z',
    statusUpdatedAt: overrides.statusUpdatedAt ?? '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

function createApproval(
  threadId: string,
  overrides: Partial<PendingApproval> = {}
): PendingApproval {
  return {
    requestId: `approval-${threadId}`,
    agentId: 'codex',
    kind: 'command',
    threadId,
    turnId: `turn-${threadId}`,
    itemId: `item-${threadId}`,
    title: 'Approval required',
    message: 'Approve this command.',
    requestedAt: '2026-07-20T00:29:30.000Z',
    options: [{ id: 'accept', label: 'Accept' }],
    ...overrides,
  };
}

function createUserInput(
  threadId: string,
  overrides: Partial<PendingUserInputRequest> = {}
): PendingUserInputRequest {
  return {
    requestId: `input-${threadId}`,
    agentId: 'copilot',
    threadId,
    turnId: `turn-${threadId}`,
    itemId: `item-${threadId}`,
    message: 'Input required.',
    requestedAt: '2026-07-20T00:29:00.000Z',
    questions: [],
    ...overrides,
  };
}

function createHarness({
  chats = [],
  agents = readyAgents,
  approvals = [],
  userInputs = [],
  connected = true,
  streamFailure = false,
  listFailure = false,
  approvalFailure = false,
  userInputFailure = false,
}: {
  chats?: ChatSummary[];
  agents?: AgentDescriptor[];
  approvals?: PendingApproval[];
  userInputs?: PendingUserInputRequest[];
  connected?: boolean;
  streamFailure?: boolean;
  listFailure?: boolean;
  approvalFailure?: boolean;
  userInputFailure?: boolean;
} = {}): DrawerHarness {
  const eventHandlers = new Set<(event: RpcNotification) => void>();
  const statusHandlers = new Set<(connected: boolean) => void>();
  const cancelStream = jest.fn();
  const listChats = listFailure
    ? jest.fn().mockRejectedValue(new Error('list failed'))
    : jest.fn().mockResolvedValue(chats);
  const api = {
    readBridgeCapabilities: jest.fn().mockResolvedValue({ agents, supportsByAgent: {} }),
    peekAllChats: jest.fn().mockReturnValue(null),
    peekChats: jest.fn().mockReturnValue(null),
    rememberChats: jest.fn(),
    listLoadedChatIds: jest.fn().mockResolvedValue([]),
    getChatSummaries: jest.fn().mockResolvedValue([]),
    listApprovals: approvalFailure
      ? jest.fn().mockRejectedValue(new Error('approval list failed'))
      : jest.fn().mockResolvedValue(approvals),
    listPendingUserInputs: userInputFailure
      ? jest.fn().mockRejectedValue(new Error('user input list failed'))
      : jest.fn().mockResolvedValue(userInputs),
    listChats,
    listAllChats: jest.fn().mockResolvedValue({ chats, partial: false, diagnostics: [] }),
    startChatListStream: streamFailure
      ? jest.fn().mockRejectedValue(new Error('stream failed'))
      : jest.fn().mockImplementation(async (_options, onBatch) => {
          onBatch({ streamId: 'stream', limit: 20, done: true, chats });
          return { streamId: 'stream', cancel: cancelStream };
        }),
  } as unknown as HostBridgeApiClient;
  const ws = {
    isConnected: connected,
    onEvent: jest.fn().mockImplementation((handler) => {
      eventHandlers.add(handler);
      return jest.fn(() => eventHandlers.delete(handler));
    }),
    onStatus: jest.fn().mockImplementation((handler) => {
      statusHandlers.add(handler);
      return jest.fn(() => statusHandlers.delete(handler));
    }),
  } as unknown as HostBridgeWsClient;

  return {
    api,
    ws,
    emitEvent: (event) => eventHandlers.forEach((handler) => handler(event)),
    emitStatus: (nextConnected) => statusHandlers.forEach((handler) => handler(nextConnected)),
    cancelStream,
  };
}

async function renderDrawer(
  harness: DrawerHarness,
  props: Partial<React.ComponentProps<typeof DrawerContent>> = {}
): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
        <AppThemeProvider theme={theme}>
          <DrawerContent
            api={harness.api}
            ws={harness.ws}
            active
            selectedChatId={null}
            onSelectChat={jest.fn()}
            onNewChat={jest.fn()}
            onNavigate={jest.fn()}
            {...props}
          />
        </AppThemeProvider>
      </SafeAreaProvider>
    );
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
  if (!tree) throw new Error('Expected drawer tree');
  return tree;
}

function findByLabel(root: Queryable, label: string): Queryable {
  const node = root.findAll((candidate) => candidate.props.accessibilityLabel === label)[0];
  if (!node) throw new Error(`Expected accessibility label: ${label}`);
  return node;
}

async function press(node: Queryable, prop = 'onPress'): Promise<void> {
  const handler = node.props[prop];
  if (typeof handler !== 'function') throw new Error(`Expected ${prop} handler`);
  await act(async () => {
    (handler as () => void)();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function hasText(root: Queryable, value: string): boolean {
  return root.findAll((node) => textContent(node).includes(value)).length > 0;
}

function textContent(node: Queryable): string {
  return node.children
    .map((child) => typeof child === 'string' || typeof child === 'number'
      ? String(child)
      : textContent(child as Queryable))
    .join('');
}

function renderPressedStyles(root: Queryable): void {
  for (const node of root.findAll((candidate) => typeof candidate.props.style === 'function')) {
    (node.props.style as (state: { pressed: boolean }) => unknown)({ pressed: true });
  }
}

async function exercisePressResponders(root: Queryable): Promise<void> {
  const responders = root.findAll((node) => typeof node.props.onResponderGrant === 'function');
  await act(async () => {
    for (const node of responders) {
      const event = { nativeEvent: {}, persist: jest.fn() };
      (node.props.onResponderGrant as (event: unknown) => void)(event);
      if (typeof node.props.onResponderRelease === 'function') {
        (node.props.onResponderRelease as (event: unknown) => void)(event);
      }
    }
    await Promise.resolve();
  });
}

describe('DrawerContent render behavior matrix', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-20T00:30:00.000Z'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('renders loading, then the empty state when boundary loading fails', async () => {
    let rejectStream: ((error: Error) => void) | undefined;
    const harness = createHarness({ streamFailure: true, listFailure: true });
    (harness.api.startChatListStream as jest.Mock).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectStream = reject; })
    );

    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
          <AppThemeProvider theme={theme}>
            <DrawerContent api={harness.api} ws={harness.ws} active selectedChatId={null} onSelectChat={jest.fn()} onNewChat={jest.fn()} onNavigate={jest.fn()} />
          </AppThemeProvider>
        </SafeAreaProvider>
      );
      await Promise.resolve();
    });
    if (!tree) throw new Error('Expected drawer tree');
    expect(hasText(tree.root as Queryable, 'Loading sessions')).toBe(true);

    await act(async () => {
      rejectStream?.(new Error('stream failed'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hasText(tree.root as Queryable, 'No sessions yet')).toBe(true);
    expect(hasText(tree.root as Queryable, 'Start a new chat and it will appear here with live activity.')).toBe(true);
    act(() => tree?.unmount());
  });

  it('keeps pending-session hydration failures retryable in an empty drawer', async () => {
    const harness = createHarness({
      userInputs: [createUserInput('missing-child')],
    });
    (harness.api.getChatSummaries as jest.Mock).mockRejectedValue(
      new Error('summary unavailable')
    );
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    const noticeLabel =
      'Some pending request sessions could not be loaded. Retry';

    expect(findByLabel(root, noticeLabel)).toBeDefined();
    expect(root.findAll((node) => node.type === RefreshControl)).toHaveLength(1);
    await act(async () => {
      jest.advanceTimersByTime(2500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(findByLabel(root, noticeLabel)).toBeDefined();
    act(() => tree.unmount());
  });

  it('clears a hydration warning when the live stream supplies the pending session', async () => {
    let streamBatch:
      | ((batch: { streamId: string; limit: number; done: boolean; chats: ChatSummary[] }) => void)
      | undefined;
    const hydrated = createChat({
      id: 'stream-child',
      title: 'Streamed pending session',
      cwd: '/repo/streamed',
      agentId: 'codex',
    });
    const harness = createHarness({
      userInputs: [createUserInput('stream-child')],
    });
    (harness.api.getChatSummaries as jest.Mock).mockRejectedValue(
      new Error('summary unavailable')
    );
    (harness.api.startChatListStream as jest.Mock).mockImplementation(
      async (_options, onBatch) => {
        streamBatch = onBatch;
        onBatch({ streamId: 'stream', limit: 5, done: false, chats: [] });
        return { streamId: 'stream', cancel: harness.cancelStream };
      }
    );
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    const noticeLabel =
      'Some pending request sessions could not be loaded. Retry';
    expect(findByLabel(root, noticeLabel)).toBeDefined();

    await act(async () => {
      streamBatch?.({
        streamId: 'stream',
        limit: 5,
        done: false,
        chats: [hydrated],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(root.findAll((node) => node.props.accessibilityLabel === noticeLabel)).toHaveLength(0);
    expect(findByLabel(root, 'Streamed pending session, streamed, Codex, Input requested')).toBeDefined();
    act(() => tree.unmount());
  });

  it('renders attention lanes, explicit agents, selection, and primary actions', async () => {
    const onSelectChat = jest.fn();
    const onNewChat = jest.fn();
    const onNavigate = jest.fn();
    const chats = [
      createChat({ id: 'root', title: 'Running root', status: 'running', cwd: '/repo/alpha', agentId: 'copilot', updatedAt: '2026-07-20T00:29:00.000Z' }),
      createChat({ id: 'approval', title: 'Approval chat', cwd: '/repo/beta', agentId: 'codex', updatedAt: '2026-07-20T00:28:00.000Z' }),
      createChat({ id: 'input', title: 'Input chat', cwd: '/repo/beta', agentId: 'copilot', updatedAt: '2026-07-20T00:27:30.000Z' }),
      createChat({ id: 'failed', title: 'Failed chat', status: 'error', cwd: '/repo/beta', agentId: 'codex', lastError: 'Build failed', updatedAt: '2026-07-20T00:27:00.000Z' }),
      createChat({ id: 'recent', title: 'Recent chat', cwd: '/repo/alpha', agentId: 'copilot', updatedAt: '2026-07-20T00:26:00.000Z' }),
    ];
    const harness = createHarness({
      chats,
      approvals: [createApproval('approval')],
      userInputs: [createUserInput('input')],
    });
    const tree = await renderDrawer(harness, { selectedChatId: 'root', onSelectChat, onNewChat, onNavigate });
    const root = tree.root as Queryable;

    expect(findByLabel(root, 'Needs your attention, 3 sessions').props.accessibilityState).toEqual(expect.objectContaining({ expanded: true }));
    expect(findByLabel(root, 'Running root, alpha, Copilot, Working').props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
    expect(findByLabel(root, 'Approval chat, beta, Codex, Approval requested')).toBeDefined();
    expect(findByLabel(root, 'Input chat, beta, Copilot, Input requested')).toBeDefined();
    expect(findByLabel(root, 'Failed chat, beta, Codex, Failed')).toBeDefined();
    expect(hasText(root, 'Copilot')).toBe(true);
    expect(hasText(root, 'Codex')).toBe(true);

    await press(findByLabel(root, 'Running root, alpha, Copilot, Working'));
    await press(findByLabel(root, 'New chat'));
    await press(findByLabel(root, 'Open preview browser'));
    await press(findByLabel(root, 'Open settings'));
    await press(findByLabel(root, 'Needs your attention, 3 sessions'));

    expect(onSelectChat).toHaveBeenCalledWith('root');
    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenNthCalledWith(1, 'Browser');
    expect(onNavigate).toHaveBeenNthCalledWith(2, 'Settings');
    expect(hasText(root, 'Approval chat')).toBe(false);
    act(() => tree.unmount());
  });

  it('filters every lane with the native iOS folder picker', async () => {
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
      .mockImplementationOnce((options, callback) => {
        callback(options.options.indexOf('beta'));
      })
      .mockImplementationOnce((_options, callback) => callback(0));
    const harness = createHarness({
      chats: [
        createChat({ id: 'alpha', title: 'Alpha session', agentId: 'copilot', cwd: '/repo/alpha', updatedAt: '2026-07-20T00:29:00.000Z' }),
        createChat({ id: 'beta', title: 'Beta session', agentId: 'codex', cwd: '/repo/beta', status: 'running', updatedAt: '2026-07-20T00:28:00.000Z' }),
      ],
    });
    try {
      const tree = await renderDrawer(harness);
      const root = tree.root as Queryable;
      await press(findByLabel(root, 'Filter sessions by folder, All folders'));
      expect(sheet).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Folder' }),
        expect.any(Function)
      );
      expect(hasText(root, 'Alpha session')).toBe(false);
      expect(hasText(root, 'Beta session')).toBe(true);
      expect(findByLabel(root, 'Filter sessions by folder, beta')).toBeDefined();

      await press(findByLabel(root, 'Filter sessions by folder, beta'));
      expect(hasText(root, 'Alpha session')).toBe(true);
      expect(hasText(root, 'Beta session')).toBe(true);
      act(() => tree.unmount());
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    }
  });

  it('reacts to websocket connectivity, lifecycle events, and snapshot refresh', async () => {
    const harness = createHarness({
      connected: false,
      chats: [createChat({ id: 'live', title: 'Realtime chat', status: 'complete', cwd: '/repo/live' })],
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    expect(hasText(root, 'Bridge offline')).toBe(true);

    await act(async () => {
      harness.emitStatus(true);
      harness.emitEvent({ method: 'thread/status/changed', params: { threadId: 'live', status: 'running' } });
      jest.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hasText(root, 'Bridge connected')).toBe(true);
    expect(findByLabel(root, 'Working now, 1 session')).toBeDefined();

    await act(async () => {
      harness.emitEvent({ method: 'bridge/events/snapshotRequired', params: null });
      jest.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.api.startChatListStream).toHaveBeenCalledTimes(3);
    act(() => tree.unmount());
  });

  it('refreshes pending interaction lanes from websocket request events', async () => {
    const pendingChat = createChat({
      id: 'pending',
      title: 'Pending interaction',
      cwd: '/repo/pending',
      agentId: 'copilot',
    });
    const harness = createHarness({ chats: [pendingChat] });
    (harness.api.listApprovals as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createApproval('pending')])
      .mockResolvedValueOnce([]);
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    await act(async () => {
      harness.emitEvent({ method: 'bridge/approval.requested', params: { threadId: 'pending' } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(findByLabel(root, 'Pending interaction, pending, Copilot, Approval requested')).toBeDefined();

    await act(async () => {
      harness.emitEvent({ method: 'bridge/approval.resolved', params: { threadId: 'pending' } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(findByLabel(root, 'Pending interaction, pending, Copilot, Complete')).toBeDefined();
    act(() => tree.unmount());
  });

  it('hydrates a pending sub-agent and requests sub-agent-inclusive chat lists', async () => {
    const rootChat = createChat({
      id: 'parent',
      title: 'Parent session',
      cwd: '/repo/mobile',
      agentId: 'copilot',
    });
    const childChat = createChat({
      id: 'child',
      title: 'Sub-agent request',
      cwd: undefined,
      parentThreadId: 'parent',
      subAgentDepth: 1,
      agentId: 'codex',
    });
    const harness = createHarness({
      chats: [rootChat],
      userInputs: [createUserInput('child')],
    });
    (harness.api.getChatSummaries as jest.Mock).mockResolvedValue([childChat]);
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    expect(harness.api.getChatSummaries).toHaveBeenCalledWith(['child']);
    expect(harness.api.startChatListStream).toHaveBeenCalledWith(
      expect.objectContaining({ includeSubAgents: true }),
      expect.any(Function),
      expect.any(Function)
    );
    expect(findByLabel(root, 'Sub-agent request, mobile, Codex, Input requested')).toBeDefined();
    act(() => tree.unmount());
  });

  it('keeps successful approval data when user-input refresh fails', async () => {
    const approvalChat = createChat({
      id: 'approval-partial',
      title: 'Visible approval',
      cwd: '/repo/partial',
      agentId: 'codex',
    });
    const harness = createHarness({
      chats: [approvalChat],
      approvals: [createApproval('approval-partial')],
      userInputFailure: true,
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    expect(findByLabel(root, 'Visible approval, partial, Codex, Approval requested')).toBeDefined();
    expect(findByLabel(root, 'Could not refresh pending input requests. Retry')).toBeDefined();
    act(() => tree.unmount());
  });

  it('retries agent metadata from the drawer notice', async () => {
    const customAgent: AgentDescriptor = {
      agentId: 'custom-agent',
      displayName: 'Friendly Agent',
      version: '1',
      provenance: 'test',
      lifecycle: 'ready',
    };
    const harness = createHarness({
      agents: [customAgent],
      chats: [createChat({
        id: 'custom',
        title: 'Custom agent session',
        cwd: '/repo/custom',
        agentId: 'custom-agent',
      })],
    });
    (harness.api.readBridgeCapabilities as jest.Mock)
      .mockRejectedValueOnce(new Error('capabilities failed'));
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    expect(findByLabel(root, 'Custom agent session, custom, Custom Agent, Complete')).toBeDefined();
    await press(findByLabel(root, 'Could not refresh agent names. Retry'));
    expect(findByLabel(root, 'Custom agent session, custom, Friendly Agent, Complete')).toBeDefined();
    expect(root.findAll((node) => node.props.accessibilityLabel === 'Could not refresh agent names. Retry')).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('handles refresh, non-refresh events, app activation, inactivity, and stream cancellation', async () => {
    let appStateHandler: ((state: string) => void) | undefined;
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
      appStateHandler = handler as (state: string) => void;
      return { remove };
    });
    const harness = createHarness({ chats: [createChat({ status: 'running', cwd: '/repo/live' })] });
    (harness.api.startChatListStream as jest.Mock).mockImplementation(async (_options, onBatch) => {
      onBatch({ streamId: 'stream', limit: 5, done: false, chats: [createChat({ status: 'running', cwd: '/repo/live' })] });
      return { streamId: 'stream', cancel: harness.cancelStream };
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    const refreshControl = root.findAll((node) => node.type === RefreshControl)[0];
    if (typeof refreshControl?.props.onRefresh !== 'function') throw new Error('Expected refresh control');

    await act(async () => {
      (refreshControl.props.onRefresh as () => void)();
      harness.emitEvent({ method: 'unrelated/event', params: null });
      harness.emitEvent({ method: 'thread/started', params: { threadId: 'thread' } });
      harness.emitEvent({ method: 'thread/name/updated', params: { threadId: 'thread' } });
      harness.emitStatus(false);
      appStateHandler?.('background');
      appStateHandler?.('active');
      jest.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      tree.update(
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
          <AppThemeProvider theme={theme}>
            <DrawerContent api={harness.api} ws={harness.ws} active={false} selectedChatId={null} onSelectChat={jest.fn()} onNewChat={jest.fn()} onNavigate={jest.fn()} />
          </AppThemeProvider>
        </SafeAreaProvider>
      );
      harness.emitEvent({ method: 'thread/status/changed', params: { threadId: 'thread', status: 'complete' } });
      jest.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(harness.cancelStream).toHaveBeenCalled();
    act(() => tree.unmount());
    expect(remove).toHaveBeenCalled();
  });

  it('hydrates cached deep chats and refreshes their newest rows without streaming', async () => {
    const cached = createChat({ id: 'cached', title: 'Cached history', cwd: '/repo/cache' });
    const newest = createChat({ id: 'newest', title: 'Newest refresh', cwd: '/repo/cache', updatedAt: '2026-07-20T00:29:00.000Z' });
    const harness = createHarness();
    (harness.api.peekAllChats as jest.Mock).mockReturnValue([cached]);
    (harness.api.listChats as jest.Mock).mockResolvedValue([newest]);
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    expect(hasText(root, 'Cached history')).toBe(true);
    expect(hasText(root, 'Newest refresh')).toBe(true);
    expect(harness.api.startChatListStream).not.toHaveBeenCalled();
    expect(harness.api.rememberChats).toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it.each([
    ['full', 20],
    ['fast', 5],
  ])('hydrates the %s cached stream tier before live batches', async (_name, cachedLimit) => {
    const harness = createHarness({ chats: [createChat({ id: 'live-tier', title: 'Live tier', cwd: '/repo/tier' })] });
    (harness.api.peekChats as jest.Mock).mockImplementation(({ limit }: { limit: number }) =>
      limit === cachedLimit ? [createChat({ id: `cached-${cachedLimit}`, title: `Cached ${cachedLimit}`, cwd: '/repo/tier' })] : null
    );
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    expect(hasText(root, `Cached ${cachedLimit}`)).toBe(true);
    expect(hasText(root, 'Live tier')).toBe(true);
    act(() => tree.unmount());
  });

  it('falls back from stream failure through fast and full chat listings', async () => {
    const fast = createChat({ id: 'fast-fallback', title: 'Fast fallback', cwd: '/repo/fallback' });
    const full = createChat({ id: 'full-fallback', title: 'Full fallback', cwd: '/repo/fallback' });
    const harness = createHarness({ streamFailure: true });
    (harness.api.listChats as jest.Mock)
      .mockResolvedValueOnce([fast])
      .mockResolvedValueOnce([fast, full]);
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    expect(hasText(root, 'Fast fallback')).toBe(true);
    expect(hasText(root, 'Full fallback')).toBe(true);
    expect(harness.api.listChats).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 5 }));
    expect(harness.api.listChats).toHaveBeenNthCalledWith(2, expect.objectContaining({ limit: 20 }));
    act(() => tree.unmount());
  });

  it('renders deep-page progress and merges loaded chat summaries before completion', async () => {
    let resolveDeep: ((value: { chats: ChatSummary[]; partial: boolean; diagnostics: string[] }) => void) | undefined;
    const firstPage = createChat({ id: 'page', title: 'Deep page', cwd: '/repo/deep' });
    const loaded = createChat({ id: 'loaded', title: 'Loaded summary', cwd: '/repo/deep' });
    const harness = createHarness({ chats: [createChat({ id: 'recent', title: 'Recent row', cwd: '/repo/deep' })] });
    (harness.api.listLoadedChatIds as jest.Mock).mockResolvedValue(['recent', 'loaded']);
    (harness.api.getChatSummaries as jest.Mock).mockResolvedValue([loaded]);
    (harness.api.listAllChats as jest.Mock).mockImplementation(({ onPage }) => {
      onPage([firstPage]);
      return new Promise((resolve) => { resolveDeep = resolve; });
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    await act(async () => {
      jest.advanceTimersByTime(2500);
      await Promise.resolve();
    });
    expect(hasText(root, 'Deep page')).toBe(true);
    expect(root.findAll((node) => Boolean(node.props.style) && textContent(node) === '')).not.toHaveLength(0);

    await act(async () => {
      resolveDeep?.({ chats: [firstPage], partial: false, diagnostics: [] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hasText(root, 'Loaded summary')).toBe(true);
    expect(harness.api.getChatSummaries).toHaveBeenCalledWith(['loaded']);
    act(() => tree.unmount());
  });

  it('primes while inactive and ignores late capability and stream callbacks after unmount', async () => {
    let resolveCapabilities: ((value: { agents: AgentDescriptor[]; supportsByAgent: Record<string, unknown> }) => void) | undefined;
    let streamBatch: ((batch: { streamId: string; limit: number; done: boolean; chats: ChatSummary[] }) => void) | undefined;
    const harness = createHarness();
    (harness.api.readBridgeCapabilities as jest.Mock).mockReturnValue(
      new Promise((resolve) => { resolveCapabilities = resolve; })
    );
    (harness.api.startChatListStream as jest.Mock).mockImplementation(async (_options, onBatch) => {
      streamBatch = onBatch;
      return { streamId: 'stream', cancel: harness.cancelStream };
    });
    const tree = await renderDrawer(harness, { active: false });

    expect(harness.api.listChats).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
    await act(async () => {
      tree.update(
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
          <AppThemeProvider theme={theme}>
            <DrawerContent api={harness.api} ws={harness.ws} active selectedChatId={null} onSelectChat={jest.fn()} onNewChat={jest.fn()} onNavigate={jest.fn()} />
          </AppThemeProvider>
        </SafeAreaProvider>
      );
      await Promise.resolve();
    });
    act(() => tree.unmount());
    await act(async () => {
      resolveCapabilities?.({ agents: readyAgents, supportsByAgent: {} });
      streamBatch?.({ streamId: 'stream', limit: 5, done: true, chats: [listedChat] });
      await Promise.resolve();
    });
    expect(harness.cancelStream).toHaveBeenCalled();
  });

  it('cancels a stream controller that resolves after the drawer deactivates', async () => {
    let resolveStream:
      | ((controller: { streamId: string; cancel: () => void }) => void)
      | undefined;
    const harness = createHarness();
    (harness.api.startChatListStream as jest.Mock)
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveStream = resolve;
        })
      )
      .mockImplementationOnce(async (_options, onBatch) => {
        onBatch({ streamId: 'second', limit: 5, done: true, chats: [] });
        return { streamId: 'second', cancel: jest.fn() };
      });
    const tree = await renderDrawer(harness);

    await act(async () => {
      tree.update(
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
          <AppThemeProvider theme={theme}>
            <DrawerContent api={harness.api} ws={harness.ws} active={false} selectedChatId={null} onSelectChat={jest.fn()} onNewChat={jest.fn()} onNavigate={jest.fn()} />
          </AppThemeProvider>
        </SafeAreaProvider>
      );
      resolveStream?.({ streamId: 'late', cancel: harness.cancelStream });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.cancelStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.update(
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
          <AppThemeProvider theme={theme}>
            <DrawerContent api={harness.api} ws={harness.ws} active selectedChatId={null} onSelectChat={jest.fn()} onNewChat={jest.fn()} onNavigate={jest.fn()} />
          </AppThemeProvider>
        </SafeAreaProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.api.startChatListStream).toHaveBeenCalledTimes(2);
    act(() => tree.unmount());
  });

  it('uses the in-app folder picker outside iOS', async () => {
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    const harness = createHarness({
      chats: [
        createChat({ id: 'platform', title: 'Platform session', cwd: '/repo/platform' }),
        createChat({ id: 'other', title: 'Other session', cwd: '/repo/other' }),
      ],
    });
    try {
      const tree = await renderDrawer(harness);
      const root = tree.root as Queryable;
      await press(findByLabel(root, 'Filter sessions by folder, All folders'));
      await press(findByLabel(root, 'platform, 1 session'));
      expect(hasText(root, 'Platform session')).toBe(true);
      expect(hasText(root, 'Other session')).toBe(false);
      expect(root.findAll((node) => node.props.accessibilityLabel === 'Close folder picker')).toHaveLength(0);
      act(() => tree.unmount());
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    }
  });

  it('renders light theme, compact counts, duplicate updates, and explicit error state', async () => {
    const manyChats = Array.from({ length: 1001 }, (_, index) => createChat({
      id: `bulk-${index}`,
      title: `Bulk ${index}`,
      cwd: '/repo/bulk',
      updatedAt: `2026-07-19T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
    }));
    const olderDuplicate = createChat({ id: 'duplicate', title: 'Older duplicate', cwd: '/repo/bulk', updatedAt: '2026-07-18T00:00:00.000Z' });
    const newerDuplicate = createChat({ id: 'duplicate', title: 'Newer duplicate', cwd: '/repo/bulk', updatedAt: '2026-07-20T00:00:00.000Z' });
    const subAgent = createChat({
      id: 'sub-error',
      title: 'Error child',
      cwd: '/repo/bulk',
      subAgentDepth: 2,
      status: 'error',
      lastError: 'Visible failure',
      agentId: 'codex',
    });
    const harness = createHarness({ chats: [...manyChats, olderDuplicate, newerDuplicate, subAgent] });
    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
          <AppThemeProvider theme={createAppTheme('light')}>
            <DrawerContent api={harness.api} ws={harness.ws} active workspaceChatLimit={null} selectedChatId="sub-error" onSelectChat={jest.fn()} onNewChat={jest.fn()} onNavigate={jest.fn()} />
          </AppThemeProvider>
        </SafeAreaProvider>
      );
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
    if (!tree) throw new Error('Expected light drawer tree');
    const root = tree.root as Queryable;
    expect(hasText(root, '1k')).toBe(true);
    expect(hasText(root, 'Newer duplicate')).toBe(true);
    expect(hasText(root, 'Older duplicate')).toBe(false);
    const errorRow = findByLabel(root, 'Error child, bulk, Codex, Failed');
    expect(errorRow.props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
    renderPressedStyles(root);
    act(() => tree?.unmount());
  });

  it('queues forced refreshes while a stream starts and settles them after completion', async () => {
    let resolveStream: ((value: { streamId: string; cancel: () => void }) => void) | undefined;
    let streamBatch: ((batch: { streamId: string; limit: number; done: boolean; chats: ChatSummary[] }) => void) | undefined;
    const harness = createHarness();
    (harness.api.startChatListStream as jest.Mock).mockImplementation((_options, onBatch) => {
      streamBatch = onBatch;
      return new Promise((resolve) => { resolveStream = resolve; });
    });
    const tree = await renderDrawer(harness);

    await act(async () => {
      harness.emitEvent({ method: 'thread/started', params: { threadId: 'queued' } });
      harness.emitEvent({ method: 'bridge/events/snapshotRequired', params: null });
      harness.emitStatus(true);
      jest.advanceTimersByTime(250);
      await Promise.resolve();
    });
    await act(async () => {
      streamBatch?.({ streamId: 'stream', limit: 5, done: false, chats: [createChat({ id: 'queued', title: 'Queued row' })] });
      resolveStream?.({ streamId: 'stream', cancel: harness.cancelStream });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.api.startChatListStream).toHaveBeenCalledTimes(1);
    expect(hasText(tree.root as Queryable, 'Queued row')).toBe(true);
    act(() => tree.unmount());
  });

  it('keeps collapsed lanes stable as streamed activity changes', async () => {
    let streamBatch: ((batch: { streamId: string; limit: number; done: boolean; chats: ChatSummary[] }) => void) | undefined;
    const first = createChat({ id: 'first', title: 'First recent', cwd: '/repo/first' });
    const second = createChat({ id: 'second', title: 'Second recent', cwd: '/repo/second' });
    const third = createChat({ id: 'third', title: 'New working session', cwd: '/repo/third', status: 'running' });
    const harness = createHarness();
    (harness.api.startChatListStream as jest.Mock).mockImplementation(async (_options, onBatch) => {
      streamBatch = onBatch;
      onBatch({ streamId: 'stream', limit: 5, done: false, chats: [first, second] });
      return { streamId: 'stream', cancel: harness.cancelStream };
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    await press(findByLabel(root, 'Recent, 2 sessions'));

    await act(async () => {
      streamBatch?.({ streamId: 'stream', limit: 20, done: false, chats: [first, second, third] });
      await Promise.resolve();
    });
    expect(findByLabel(root, 'Recent, 2 sessions').props.accessibilityState).toEqual(expect.objectContaining({ expanded: false }));
    expect(findByLabel(root, 'Working now, 1 session').props.accessibilityState).toEqual(expect.objectContaining({ expanded: true }));
    expect(hasText(root, 'First recent')).toBe(false);
    expect(hasText(root, 'New working session')).toBe(true);
    act(() => tree.unmount());
  });

  it('renders pressed responder states for header, folders, lanes, chats, and footer actions', async () => {
    const harness = createHarness({
      chats: Array.from({ length: 4 }, (_, index) => createChat({
        id: `pressed-${index}`,
        title: `Pressed ${index}`,
        cwd: '/repo/pressed',
        status: index === 1 ? 'error' : 'complete',
        lastError: index === 1 ? 'Pressed error' : undefined,
      })),
    });
    const tree = await renderDrawer(harness, { selectedChatId: 'pressed-1' });
    const root = tree.root as Queryable;
    await exercisePressResponders(root);
    renderPressedStyles(root);
    act(() => tree.unmount());
  });

  it('keeps the newest duplicate and renders rows in attention order', async () => {
    const newest = createChat({ id: 'duplicate-order', title: 'Newest duplicate order', cwd: '/repo/a', updatedAt: '2026-07-20T00:20:00.000Z' });
    const older = createChat({ id: 'duplicate-order', title: 'Older duplicate order', cwd: '/repo/a', updatedAt: '2026-07-19T00:20:00.000Z' });
    const harness = createHarness({
      chats: [
        createChat({ id: 'plain', title: 'Plain root', cwd: '/repo/a', updatedAt: '2026-07-20T00:29:00.000Z' }),
        createChat({ id: 'working', title: 'Working root', cwd: '/repo/a', status: 'running', updatedAt: '2026-07-20T00:27:00.000Z' }),
        createChat({ id: 'failed', title: 'Failed root', cwd: '/repo/z', status: 'error' }),
        newest,
        older,
      ],
    });
    const tree = await renderDrawer(harness, { workspaceChatLimit: null });
    const root = tree.root as Queryable;
    expect(hasText(root, 'Newest duplicate order')).toBe(true);
    expect(hasText(root, 'Older duplicate order')).toBe(false);
    expect(findByLabel(root, 'Needs your attention, 1 session')).toBeDefined();
    expect(findByLabel(root, 'Working now, 1 session')).toBeDefined();
    expect(findByLabel(root, 'Recent, 2 sessions')).toBeDefined();
    act(() => tree.unmount());
  });

  it('formats five-digit chat totals as a whole compact count', async () => {
    const chats = Array.from({ length: 10_001 }, (_, index) => createChat({
      id: `count-${index}`,
      title: `Count ${index}`,
      cwd: '/repo/count',
    }));
    const harness = createHarness({ chats });
    const tree = await renderDrawer(harness, { workspaceChatLimit: 10 });
    expect(hasText(tree.root as Queryable, '10k')).toBe(true);
    act(() => tree.unmount());
  });

  it('refreshes cached deep history with the full recent-chat tier', async () => {
    const cached = createChat({ id: 'deep-cache', title: 'Deep cache refresh', cwd: '/repo/deep-cache' });
    const refreshed = createChat({ id: 'deep-new', title: 'Deep cache newest', cwd: '/repo/deep-cache' });
    const harness = createHarness();
    (harness.api.peekAllChats as jest.Mock).mockReturnValue([cached]);
    (harness.api.listChats as jest.Mock).mockResolvedValue([refreshed]);
    const tree = await renderDrawer(harness);
    const refreshControl = (tree.root as Queryable).findAll((node) => node.type === RefreshControl)[0];
    if (typeof refreshControl?.props.onRefresh !== 'function') throw new Error('Expected cached refresh control');

    await act(async () => {
      (refreshControl.props.onRefresh as () => void)();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.api.listChats).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20, forceRefresh: true }));
    expect(hasText(tree.root as Queryable, 'Deep cache newest')).toBe(true);
    act(() => tree.unmount());
  });

  it('settles refreshing through the stream error callback', async () => {
    let streamError: (() => void) | undefined;
    const harness = createHarness({ chats: [listedChat] });
    (harness.api.startChatListStream as jest.Mock)
      .mockImplementationOnce(async (_options, onBatch) => {
        onBatch({ streamId: 'initial', limit: 5, done: true, chats: [listedChat] });
        return { streamId: 'initial', cancel: jest.fn() };
      })
      .mockImplementationOnce(async (_options, _onBatch, onError) => {
        streamError = onError;
        return { streamId: 'refresh', cancel: harness.cancelStream };
      });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    const refreshControl = root.findAll((node) => node.type === RefreshControl)[0];
    if (typeof refreshControl?.props.onRefresh !== 'function') throw new Error('Expected error refresh control');

    await act(async () => {
      (refreshControl.props.onRefresh as () => void)();
      await Promise.resolve();
      streamError?.();
      await Promise.resolve();
    });
    expect(harness.api.startChatListStream).toHaveBeenCalledTimes(2);
    act(() => tree.unmount());
  });

  it('ignores scheduled events while inactive and clears pending work on unmount', async () => {
    const harness = createHarness({ chats: [listedChat] });
    const tree = await renderDrawer(harness);
    await act(async () => {
      harness.emitEvent({ method: 'thread/started', params: { threadId: 'scheduled' } });
      tree.update(
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
          <AppThemeProvider theme={theme}>
            <DrawerContent api={harness.api} ws={harness.ws} active={false} selectedChatId={null} onSelectChat={jest.fn()} onNewChat={jest.fn()} onNavigate={jest.fn()} />
          </AppThemeProvider>
        </SafeAreaProvider>
      );
      harness.emitEvent({ method: 'thread/name/updated', params: { threadId: 'scheduled' } });
      await Promise.resolve();
    });
    act(() => tree.unmount());
    expect(harness.api.startChatListStream).toHaveBeenCalledTimes(1);
  });

  it('keeps deep loading visible when another completed stream schedules during the in-flight request', async () => {
    let resolveDeep: ((value: { chats: ChatSummary[]; partial: boolean; diagnostics: string[] }) => void) | undefined;
    const harness = createHarness({ chats: [listedChat] });
    (harness.api.listAllChats as jest.Mock).mockReturnValue(
      new Promise((resolve) => { resolveDeep = resolve; })
    );
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    await act(async () => {
      jest.advanceTimersByTime(2500);
      await Promise.resolve();
    });
    const refreshControl = root.findAll((node) => node.type === RefreshControl)[0];
    if (typeof refreshControl?.props.onRefresh !== 'function') throw new Error('Expected deep refresh control');
    await act(async () => {
      (refreshControl.props.onRefresh as () => void)();
      await Promise.resolve();
      resolveDeep?.({ chats: [listedChat], partial: false, diagnostics: [] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.api.listAllChats).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('ignores deep pages, results, and loaded summaries that settle after deactivation', async () => {
    let onDeepPage: ((chats: ChatSummary[]) => void) | undefined;
    let resolveDeep: ((value: { chats: ChatSummary[]; partial: boolean; diagnostics: string[] }) => void) | undefined;
    const deepChat = createChat({ id: 'inactive-deep', title: 'Inactive deep result' });
    const loadedChat = createChat({ id: 'inactive-loaded', title: 'Inactive loaded summary' });
    const harness = createHarness({ chats: [listedChat] });
    (harness.api.listLoadedChatIds as jest.Mock).mockResolvedValue(['inactive-loaded']);
    (harness.api.getChatSummaries as jest.Mock).mockResolvedValue([loadedChat]);
    (harness.api.listAllChats as jest.Mock).mockImplementation(({ onPage }) => {
      onDeepPage = onPage;
      return new Promise((resolve) => { resolveDeep = resolve; });
    });
    const tree = await renderDrawer(harness);
    await act(async () => {
      jest.advanceTimersByTime(2500);
      await Promise.resolve();
      tree.update(
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
          <AppThemeProvider theme={theme}>
            <DrawerContent api={harness.api} ws={harness.ws} active={false} selectedChatId={null} onSelectChat={jest.fn()} onNewChat={jest.fn()} onNavigate={jest.fn()} />
          </AppThemeProvider>
        </SafeAreaProvider>
      );
      await Promise.resolve();
    });
    await act(async () => {
      onDeepPage?.([deepChat]);
      resolveDeep?.({ chats: [deepChat], partial: false, diagnostics: [] });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hasText(tree.root as Queryable, 'Inactive deep result')).toBe(false);
    expect(hasText(tree.root as Queryable, 'Inactive loaded summary')).toBe(true);
    act(() => tree.unmount());
  });

  it('ignores a live stream batch delivered after deactivation', async () => {
    let streamBatch: ((batch: { streamId: string; limit: number; done: boolean; chats: ChatSummary[] }) => void) | undefined;
    const harness = createHarness();
    (harness.api.startChatListStream as jest.Mock).mockImplementation(async (_options, onBatch) => {
      streamBatch = onBatch;
      return { streamId: 'stream', cancel: harness.cancelStream };
    });
    const tree = await renderDrawer(harness);
    await act(async () => {
      tree.update(
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
          <AppThemeProvider theme={theme}>
            <DrawerContent api={harness.api} ws={harness.ws} active={false} selectedChatId={null} onSelectChat={jest.fn()} onNewChat={jest.fn()} onNavigate={jest.fn()} />
          </AppThemeProvider>
        </SafeAreaProvider>
      );
      await Promise.resolve();
    });
    await act(async () => {
      streamBatch?.({ streamId: 'stream', limit: 5, done: true, chats: [createChat({ title: 'Late stream row' })] });
      await Promise.resolve();
    });
    expect(hasText(tree.root as Queryable, 'Late stream row')).toBe(false);
    act(() => tree.unmount());
  });
});

describe('DrawerContent partial history diagnostics', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('persists diagnostics and clears them after a forced successful retry', async () => {
    const listAllChats = jest.fn()
      .mockResolvedValueOnce({
        chats: [listedChat],
        partial: true,
        diagnostics: ['Chat listing reached the 32-page safety limit.'],
      })
      .mockResolvedValueOnce({ chats: [listedChat], partial: false, diagnostics: [] });
    const api = {
      readBridgeCapabilities: jest.fn().mockResolvedValue({ agents: [], supportsByAgent: {} }),
      peekAllChats: jest.fn().mockReturnValue(null),
      peekChats: jest.fn().mockReturnValue(null),
      rememberChats: jest.fn(),
      listLoadedChatIds: jest.fn().mockResolvedValue([]),
      getChatSummaries: jest.fn().mockResolvedValue([]),
      listChats: jest.fn().mockResolvedValue([listedChat]),
      listAllChats,
      listApprovals: jest.fn().mockResolvedValue([]),
      listPendingUserInputs: jest.fn().mockResolvedValue([]),
      startChatListStream: jest.fn().mockImplementation(async (_options, onBatch) => {
        onBatch({ streamId: 'stream', limit: 20, done: true, chats: [listedChat] });
        return { streamId: 'stream', cancel: jest.fn() };
      }),
    } as unknown as HostBridgeApiClient;
    const ws = {
      isConnected: true,
      onEvent: jest.fn().mockReturnValue(jest.fn()),
      onStatus: jest.fn().mockReturnValue(jest.fn()),
    } as unknown as HostBridgeWsClient;

    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
          <AppThemeProvider theme={theme}>
            <DrawerContent
              api={api}
              ws={ws}
              active
              selectedChatId={null}
              onSelectChat={jest.fn()}
              onNewChat={jest.fn()}
              onNavigate={jest.fn()}
            />
          </AppThemeProvider>
        </SafeAreaProvider>
      );
      await Promise.resolve();
    });
    if (!tree) throw new Error('Expected drawer tree');

    await act(async () => {
      jest.advanceTimersByTime(2500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hasText(tree.root as Queryable, 'Some drawer data may be stale')).toBe(true);
    expect(hasText(tree.root as Queryable, 'Chat listing reached the 32-page safety limit.')).toBe(true);

    const retry = (tree.root as Queryable).findAll(
      (node) => node.props.accessibilityLabel === 'Chat listing reached the 32-page safety limit. Retry'
    )[0];
    if (typeof retry?.props.onPress !== 'function') throw new Error('Expected retry action');
    await act(async () => {
      (retry.props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listAllChats).toHaveBeenLastCalledWith(expect.objectContaining({ forceRefresh: true }));
    expect(hasText(tree.root as Queryable, 'Some drawer data may be stale')).toBe(false);
    act(() => tree?.unmount());
  });
});
