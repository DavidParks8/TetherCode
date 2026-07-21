import * as FileSystem from 'expo-file-system/legacy';
import { ActionSheetIOS, Alert, AppState, Platform, RefreshControl } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { HostBridgeApiClient } from '../../api/client';
import type { AgentDescriptor, ChatSummary, RpcNotification } from '../../api/types';
import type { HostBridgeWsClient } from '../../api/ws';
import { AppThemeProvider, createAppTheme } from '../../theme';
import { DrawerContent } from '../DrawerContent';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
let mockDocumentDirectory: string | null = 'file:///documents/';
jest.mock('expo-file-system/legacy', () => ({
  get documentDirectory() {
    return mockDocumentDirectory;
  },
  readAsStringAsync: jest.fn(),
  writeAsStringAsync: jest.fn(),
}));

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

function createHarness({
  chats = [],
  agents = readyAgents,
  connected = true,
  streamFailure = false,
  listFailure = false,
}: {
  chats?: ChatSummary[];
  agents?: AgentDescriptor[];
  connected?: boolean;
  streamFailure?: boolean;
  listFailure?: boolean;
} = {}): DrawerHarness {
  let eventHandler: (event: RpcNotification) => void = () => {};
  let statusHandler: (connected: boolean) => void = () => {};
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
      eventHandler = handler;
      return jest.fn();
    }),
    onStatus: jest.fn().mockImplementation((handler) => {
      statusHandler = handler;
      return jest.fn();
    }),
  } as unknown as HostBridgeWsClient;

  return {
    api,
    ws,
    emitEvent: (event) => eventHandler(event),
    emitStatus: (nextConnected) => statusHandler(nextConnected),
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
    mockDocumentDirectory = 'file:///documents/';
    jest.mocked(FileSystem.readAsStringAsync).mockRejectedValue(new Error('not persisted'));
    jest.mocked(FileSystem.writeAsStringAsync).mockResolvedValue(undefined);
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
    expect(hasText(tree.root as Queryable, 'Loading chats')).toBe(true);

    await act(async () => {
      rejectStream?.(new Error('stream failed'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hasText(tree.root as Queryable, 'No chats yet')).toBe(true);
    expect(hasText(tree.root as Queryable, 'Start a new chat and it will show up here with live activity.')).toBe(true);
    act(() => tree?.unmount());
  });

  it('renders populated workspaces, tree branches, status badges, selection, and actions', async () => {
    const onSelectChat = jest.fn();
    const onNewChat = jest.fn();
    const onNavigate = jest.fn();
    const chats = [
      createChat({ id: 'root', title: 'Running root', status: 'running', cwd: '/repo/alpha', lastMessagePreview: 'Working', updatedAt: '2026-07-20T00:29:00.000Z' }),
      createChat({ id: 'child', title: '', status: 'error', cwd: '/repo/alpha', parentThreadId: 'root', subAgentDepth: 1, lastError: 'Build failed', updatedAt: '2026-07-20T00:28:00.000Z' }),
      createChat({ id: 'other', title: 'Other workspace', cwd: '/repo/beta', lastMessagePreview: 'Other workspace', updatedAt: '2026-07-20T00:27:00.000Z' }),
    ];
    const harness = createHarness({ chats, agents: [] });
    const tree = await renderDrawer(harness, { selectedChatId: 'root', onSelectChat, onNewChat, onNavigate });
    const root = tree.root as Queryable;

    expect(findByLabel(root, 'beta, 1 chats').props.accessibilityState).toEqual(expect.objectContaining({ expanded: false }));
    expect(findByLabel(root, 'Running root, Working, running').props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));

    await press(findByLabel(root, 'Running root, Working, running'));
    await press(findByLabel(root, 'New chat'));
    await press(findByLabel(root, 'Open preview browser'));
    await press(findByLabel(root, 'Open settings'));
    await press(findByLabel(root, 'beta, 1 chats'));

    expect(onSelectChat).toHaveBeenCalledWith('root');
    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenNthCalledWith(1, 'Browser');
    expect(onNavigate).toHaveBeenNthCalledWith(2, 'Settings');
    expect(hasText(root, 'Other workspace')).toBe(true);
    act(() => tree.unmount());
  });

  it('filters by agents, searches across workspaces, clears search, and preserves one agent', async () => {
    const emptyAgent: AgentDescriptor = {
      agentId: 'empty',
      displayName: 'Empty',
      version: '1',
      provenance: 'test',
      lifecycle: 'ready',
    };
    const harness = createHarness({
      agents: [...readyAgents, emptyAgent],
      chats: [
        createChat({ id: 'copilot-chat', title: 'Fix navigation', agentId: 'copilot', cwd: '/repo/mobile' }),
        createChat({ id: 'codex-chat', title: 'Bridge diagnostics', agentId: 'codex', cwd: '/repo/bridge' }),
      ],
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    await press(findByLabel(root, 'Filter chat agents'));

    expect(findByLabel(root, 'Toggle Copilot chats').props.accessibilityState).toEqual({ checked: true });
    expect(root.findAll((node) => node.props.accessibilityLabel === 'Toggle Offline agent chats')).toHaveLength(0);
    await press(findByLabel(root, 'Toggle Copilot chats'));
    expect(hasText(root, 'Fix navigation')).toBe(false);
    expect(hasText(root, 'Bridge diagnostics')).toBe(true);

    const search = findByLabel(root, 'Search chats');
    await act(async () => {
      (search.props.onChangeText as (value: string) => void)('missing title');
      await Promise.resolve();
    });
    expect(hasText(root, 'No matching chats')).toBe(true);
    expect(hasText(root, 'Try a different title, keyword, or workspace name.')).toBe(true);
    await press(findByLabel(root, 'Clear chat search'));
    expect(hasText(root, 'Bridge diagnostics')).toBe(true);

    await press(findByLabel(root, 'Toggle Copilot chats'));
    await press(findByLabel(root, 'Toggle Codex chats'));
    await press(findByLabel(root, 'Toggle Copilot chats'));
    expect(hasText(root, 'No Empty chats')).toBe(true);
    expect(hasText(root, 'Turn another agent back on or start a new Empty chat.')).toBe(true);
    await press(findByLabel(root, 'Toggle Empty chats'));
    expect(hasText(root, 'No Empty chats')).toBe(true);
    act(() => tree.unmount());
  });

  it('limits workspace rows, shows all, and persists chat and workspace pin actions', async () => {
    const chats = Array.from({ length: 12 }, (_, index) => createChat({
      id: `chat-${index}`,
      title: `Chat ${index}`,
      cwd: '/repo/many',
      updatedAt: `2026-07-20T00:${String(29 - index).padStart(2, '0')}:00.000Z`,
    }));
    const harness = createHarness({ chats });
    const actionSheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(0));
    const tree = await renderDrawer(harness, { workspaceChatLimit: 10 });
    const root = tree.root as Queryable;

    expect(hasText(root, 'Chat 11')).toBe(false);
    await press(findByLabel(root, 'Show all chats in many'));
    expect(root.findAll((node) => node.props.accessibilityLabel === 'Show all chats in many')).toHaveLength(0);
    await press(findByLabel(root, 'Chat 0, done'), 'onLongPress');
    await press(findByLabel(root, 'many, 12 chats'), 'onLongPress');

    expect(actionSheet).toHaveBeenCalledTimes(2);
    expect(FileSystem.writeAsStringAsync).toHaveBeenCalledWith(
      'file:///documents/clawdex-pinned-chats.json',
      JSON.stringify({ ids: ['chat-0'] })
    );
    expect(FileSystem.writeAsStringAsync).toHaveBeenCalledWith(
      'file:///documents/clawdex-workspace-favorites.json',
      JSON.stringify({ version: 1, paths: ['/repo/many'] })
    );
    act(() => tree.unmount());
  });

  it('reacts to websocket connectivity, lifecycle events, and snapshot refresh', async () => {
    const harness = createHarness({
      connected: false,
      chats: [createChat({ id: 'live', title: 'Realtime chat', status: 'complete', cwd: '/repo/live' })],
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    expect(hasText(root, 'Offline')).toBe(true);

    await act(async () => {
      harness.emitStatus(true);
      harness.emitEvent({ method: 'thread/status/changed', params: { threadId: 'live', status: 'running' } });
      jest.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hasText(root, 'Live')).toBe(true);
    expect(hasText(root, '1 chats · 1 live')).toBe(true);

    await act(async () => {
      harness.emitEvent({ method: 'bridge/events/snapshotRequired', params: null });
      jest.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.api.startChatListStream).toHaveBeenCalledTimes(3);
    act(() => tree.unmount());
  });

  it('renders persisted pin ordering, pinned badges, unpin actions, and all age badges', async () => {
    jest.mocked(FileSystem.readAsStringAsync)
      .mockResolvedValueOnce(JSON.stringify({ ids: ['week', 'root'] }))
      .mockResolvedValueOnce(JSON.stringify({ version: 1, paths: ['/repo/zeta', '/repo/alpha'] }));
    const actionSheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
      .mockImplementation((_options, callback) => callback(0));
    const harness = createHarness({
      chats: [
        createChat({ id: 'root', title: 'Pinned root', cwd: '/repo/alpha', lastMessagePreview: undefined, updatedAt: '2026-07-20T00:30:00.000Z' }),
        createChat({ id: 'child', title: 'Pinned child', cwd: '/repo/alpha', parentThreadId: 'root', subAgentDepth: 6, lastMessagePreview: undefined, updatedAt: '2026-07-19T22:30:00.000Z' }),
        createChat({ id: 'day', title: 'Day old', cwd: '/repo/alpha', lastMessagePreview: undefined, updatedAt: '2026-07-17T00:30:00.000Z' }),
        createChat({ id: 'week', title: 'Week old', cwd: '/repo/alpha', lastMessagePreview: undefined, updatedAt: '2026-07-06T00:30:00.000Z' }),
        createChat({ id: 'month', title: 'Month old', cwd: '/repo/alpha', lastMessagePreview: undefined, updatedAt: '2026-05-20T00:30:00.000Z' }),
        createChat({ id: 'zeta', title: 'Pinned workspace chat', cwd: '/repo/zeta', lastMessagePreview: undefined, updatedAt: '2026-07-19T22:30:00.000Z' }),
      ],
    });
    const tree = await renderDrawer(harness, { selectedChatId: 'child', workspaceChatLimit: null });
    const root = tree.root as Queryable;
    const alphaWorkspace = root.findAll(
      (node) =>
        (node.props.accessibilityState as { expanded?: boolean } | undefined)?.expanded === false &&
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.endsWith('chats')
    )[0];
    if (!alphaWorkspace) throw new Error('Expected collapsed workspace');

    expect(alphaWorkspace.props.accessibilityState).toEqual(expect.objectContaining({ expanded: false }));
    await press(alphaWorkspace);
    await press(findByLabel(root, 'Filter chat agents'));
    await act(async () => {
      (findByLabel(root, 'Search chats').props.onChangeText as (value: string) => void)('/repo');
      await Promise.resolve();
    });
    const pinnedRoot = root.findAll(
      (node) => typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.startsWith('Pinned root')
    )[0];
    if (!pinnedRoot) throw new Error('Expected pinned root row');
    expect(pinnedRoot.props.accessibilityLabel).toContain('pinned');
    expect(hasText(root, 'now')).toBe(true);
    expect(hasText(root, '2h')).toBe(true);
    expect(hasText(root, '3d')).toBe(true);
    expect(hasText(root, '2w')).toBe(true);
    expect(hasText(root, '2mo')).toBe(true);

    await press(pinnedRoot, 'onLongPress');
    await press(alphaWorkspace, 'onLongPress');
    expect(actionSheet).toHaveBeenCalledWith(
      expect.objectContaining({ options: ['Unpin chat', 'Cancel'] }),
      expect.any(Function)
    );
    expect(actionSheet).toHaveBeenCalledWith(
      expect.objectContaining({ options: ['Unpin workspace', 'Cancel'] }),
      expect.any(Function)
    );
    renderPressedStyles(root);
    act(() => tree.unmount());
  });

  it('keeps search active while selecting and closes a searched filter menu explicitly', async () => {
    const onSelectChat = jest.fn();
    const onNewChat = jest.fn();
    const onNavigate = jest.fn();
    const harness = createHarness({ chats: [createChat({ title: 'Search target', cwd: '/repo/search' })] });
    const tree = await renderDrawer(harness, { onSelectChat, onNewChat, onNavigate });
    const root = tree.root as Queryable;

    await press(findByLabel(root, 'Filter chat agents'));
    const search = findByLabel(root, 'Search chats');
    await act(async () => {
      (search.props.onChangeText as (value: string) => void)('target');
      await Promise.resolve();
    });
    expect(findByLabel(root, 'search, 1 chats').props.accessibilityState).toEqual({ disabled: true });
    await press(findByLabel(root, 'Search target, done'));
    await press(findByLabel(root, 'New chat'));
    await press(findByLabel(root, 'Open preview browser'));
    await press(findByLabel(root, 'Open settings'));
    expect(findByLabel(root, 'Search chats').props.value).toBe('target');

    await press(findByLabel(root, 'Filter chat agents'));
    expect(root.findAll((node) => node.props.accessibilityLabel === 'Search chats')).toHaveLength(0);
    expect(onSelectChat).toHaveBeenCalledWith('thread');
    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('Browser');
    expect(onNavigate).toHaveBeenCalledWith('Settings');
    renderPressedStyles(root);
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

  it.each([
    ['legacy arrays', JSON.stringify(['chat-pin', ' chat-pin ', 7, '']), JSON.stringify(['/repo/pins', '/repo/pins', 7])],
    ['invalid records', JSON.stringify({ ids: 'invalid' }), JSON.stringify({ paths: 'invalid' })],
    ['primitive records', JSON.stringify(42), JSON.stringify(null)],
  ])('renders safely from %s persisted pin payloads', async (_name, chatPayload, workspacePayload) => {
    jest.mocked(FileSystem.readAsStringAsync)
      .mockResolvedValueOnce(chatPayload)
      .mockResolvedValueOnce(workspacePayload);
    const harness = createHarness({ chats: [createChat({ id: 'chat-pin', title: 'Persisted row', cwd: '/repo/pins' })] });
    const tree = await renderDrawer(harness);
    expect(hasText(tree.root as Queryable, 'Persisted row')).toBe(true);
    act(() => tree.unmount());
  });

  it('uses Android alert pin actions and leaves state unchanged when iOS sheets are cancelled', async () => {
    const harness = createHarness({ chats: [createChat({ title: 'Platform pin', cwd: '/repo/platform' })] });
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => buttons?.[0]?.onPress?.());
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    await press(findByLabel(root, 'Platform pin, done'), 'onLongPress');
    await press(findByLabel(root, 'platform, 1 chats'), 'onLongPress');
    expect(alert).toHaveBeenCalledTimes(2);
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });

    const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
      .mockImplementation((_options, callback) => callback(1));
    await press(findByLabel(root, 'Platform pin, done, pinned'), 'onLongPress');
    await press(findByLabel(root, 'platform, 1 chats'), 'onLongPress');
    expect(sheet).toHaveBeenCalledTimes(2);
    act(() => tree.unmount());
  });

  it('renders light theme, compact counts, duplicate updates, and searched sub-agent errors', async () => {
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

    await press(findByLabel(root, 'Filter chat agents'));
    await act(async () => {
      (findByLabel(root, 'Search chats').props.onChangeText as (value: string) => void)('Error child');
      await Promise.resolve();
    });
    const errorRow = root.findAll(
      (node) => typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.startsWith('Error child, Visible failure')
    )[0];
    if (!errorRow) throw new Error('Expected visible sub-agent error row');
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

  it('updates collapsed workspaces as streamed workspace membership changes', async () => {
    let streamBatch: ((batch: { streamId: string; limit: number; done: boolean; chats: ChatSummary[] }) => void) | undefined;
    const first = createChat({ id: 'first', title: 'First workspace', cwd: '/repo/first' });
    const second = createChat({ id: 'second', title: 'Second workspace', cwd: '/repo/second' });
    const third = createChat({ id: 'third', title: 'Third workspace', cwd: '/repo/third' });
    const harness = createHarness();
    (harness.api.startChatListStream as jest.Mock).mockImplementation(async (_options, onBatch) => {
      streamBatch = onBatch;
      onBatch({ streamId: 'stream', limit: 5, done: false, chats: [first, second] });
      return { streamId: 'stream', cancel: harness.cancelStream };
    });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;
    await press(findByLabel(root, 'second, 1 chats'));
    await press(findByLabel(root, 'second, 1 chats'));

    await act(async () => {
      streamBatch?.({ streamId: 'stream', limit: 20, done: false, chats: [first, third] });
      await Promise.resolve();
    });
    expect(findByLabel(root, 'third, 1 chats').props.accessibilityState).toEqual(expect.objectContaining({ expanded: true }));
    expect(findByLabel(root, 'second, 1 chats')).toBeDefined();
    act(() => tree.unmount());
  });

  it('keeps rendered pin state usable when persistence writes reject', async () => {
    jest.mocked(FileSystem.writeAsStringAsync).mockRejectedValue(new Error('write failed'));
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
      .mockImplementation((_options, callback) => callback(0));
    const harness = createHarness({ chats: [createChat({ title: 'Write failure', cwd: '/repo/write-failure' })] });
    const tree = await renderDrawer(harness);
    const root = tree.root as Queryable;

    await press(findByLabel(root, 'Write failure, done'), 'onLongPress');
    await press(findByLabel(root, 'write-failure, 1 chats'), 'onLongPress');
    expect(findByLabel(root, 'Write failure, done, pinned')).toBeDefined();
    act(() => tree.unmount());
  });

  it('renders pressed responder states for actions, workspaces, pagination, chats, and settings', async () => {
    const harness = createHarness({
      chats: Array.from({ length: 12 }, (_, index) => createChat({
        id: `pressed-${index}`,
        title: index === 1 ? '' : `Pressed ${index}`,
        cwd: '/repo/pressed',
        parentThreadId: index === 1 ? 'pressed-0' : undefined,
        subAgentDepth: index === 1 ? 1 : undefined,
        status: index === 1 ? 'error' : 'complete',
        lastError: index === 1 ? 'Pressed error' : undefined,
      })),
    });
    const tree = await renderDrawer(harness, { selectedChatId: 'pressed-1', workspaceChatLimit: 10 });
    const root = tree.root as Queryable;
    await press(findByLabel(root, 'Filter chat agents'));
    await act(async () => {
      (findByLabel(root, 'Search chats').props.onChangeText as (value: string) => void)('/repo/pressed');
      await Promise.resolve();
    });
    await exercisePressResponders(root);
    renderPressedStyles(root);
    act(() => tree.unmount());
  });

  it('orders multiple persisted pinned roots and workspaces and keeps the newest duplicate', async () => {
    jest.mocked(FileSystem.readAsStringAsync)
      .mockResolvedValueOnce(JSON.stringify({ ids: ['pin-b', 'pin-a'] }))
      .mockResolvedValueOnce(JSON.stringify({ version: 1, paths: ['/repo/z', '/repo/a'] }));
    const newest = createChat({ id: 'duplicate-order', title: 'Newest duplicate order', cwd: '/repo/a', updatedAt: '2026-07-20T00:20:00.000Z' });
    const older = createChat({ id: 'duplicate-order', title: 'Older duplicate order', cwd: '/repo/a', updatedAt: '2026-07-19T00:20:00.000Z' });
    const harness = createHarness({
      chats: [
        createChat({ id: 'plain', title: 'Plain root', cwd: '/repo/a', updatedAt: '2026-07-20T00:29:00.000Z' }),
        createChat({ id: 'pin-a', title: 'Pinned A', cwd: '/repo/a', updatedAt: '2026-07-20T00:27:00.000Z' }),
        createChat({ id: 'pin-b', title: 'Pinned B', cwd: '/repo/a', updatedAt: '2026-07-20T00:28:00.000Z' }),
        createChat({ id: 'z-root', title: 'Z workspace', cwd: '/repo/z' }),
        newest,
        older,
      ],
    });
    const tree = await renderDrawer(harness, { workspaceChatLimit: null });
    const root = tree.root as Queryable;
    expect(hasText(root, 'Newest duplicate order')).toBe(true);
    expect(hasText(root, 'Older duplicate order')).toBe(false);
    expect(findByLabel(root, 'Pinned B, done, pinned')).toBeDefined();
    expect(findByLabel(root, 'Pinned A, done, pinned')).toBeDefined();
    expect(findByLabel(root, 'z, 1 chats').props.accessibilityState).toEqual(expect.objectContaining({ expanded: false }));
    act(() => tree.unmount());
  });

  it('ignores persisted pin reads that settle after unmount', async () => {
    let resolveChatPins: ((value: string) => void) | undefined;
    let rejectWorkspacePins: ((error: Error) => void) | undefined;
    jest.mocked(FileSystem.readAsStringAsync)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveChatPins = resolve; }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectWorkspacePins = reject; }));
    jest.mocked(FileSystem.readAsStringAsync).mockClear();
    const harness = createHarness({ chats: [createChat({ title: 'Late persistence' })] });
    const tree = await renderDrawer(harness);
    act(() => tree.unmount());

    await act(async () => {
      resolveChatPins?.(JSON.stringify({ ids: ['thread'] }));
      rejectWorkspacePins?.(new Error('late failure'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(FileSystem.readAsStringAsync).toHaveBeenCalledTimes(2);
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

  it('settles refreshing through the stream error callback and closes an empty filter', async () => {
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
    await press(findByLabel(root, 'Filter chat agents'));
    await press(findByLabel(root, 'Filter chat agents'));
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
    expect(hasText(tree.root as Queryable, 'Some chat history could not be listed')).toBe(true);
    expect(hasText(tree.root as Queryable, 'Chat listing reached the 32-page safety limit. Tap to retry.')).toBe(true);

    const retry = (tree.root as Queryable).findAll(
      (node) => node.props.accessibilityLabel === 'Chat history is partial. Retry loading all chats'
    )[0];
    if (typeof retry?.props.onPress !== 'function') throw new Error('Expected retry action');
    await act(async () => {
      (retry.props.onPress as () => void)();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listAllChats).toHaveBeenLastCalledWith(expect.objectContaining({ forceRefresh: true }));
    expect(hasText(tree.root as Queryable, 'Some chat history could not be listed')).toBe(false);
    act(() => tree?.unmount());
  });
});
