import { AppState, FlatList } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { HostBridgeApiClient } from '../../api/client';
import type { BridgeCapabilities, BridgeUiAction, BridgeUiSurface, Chat } from '../../api/types';
import type { HostBridgeWsClient } from '../../api/ws';
import { AppThemeProvider, createAppTheme } from '../../theme';
import { MainScreen } from '../MainScreen';

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
jest.mock('../../components/LoadingGlyph', () => ({ LoadingGlyph: () => null }));

let mockApprovalProps: Record<string, unknown> | null = null;
jest.mock('../../components/ApprovalBanner', () => ({
  ApprovalBanner: (props: Record<string, unknown>) => {
    mockApprovalProps = props;
    return null;
  },
}));

let mockBridgeUiProps: {
  surface: BridgeUiSurface;
  onAction: (surface: BridgeUiSurface, action: BridgeUiAction) => void;
  onDismiss: (surface: BridgeUiSurface) => void;
}[] = [];
jest.mock('../../components/BridgeUiSurface', () => ({
  BridgeUiBanner: (props: typeof mockBridgeUiProps[number]) => {
    mockBridgeUiProps.push(props);
    return props.surface.title;
  },
  BridgeUiModal: (props: typeof mockBridgeUiProps[number]) => {
    mockBridgeUiProps.push(props);
    return props.surface.title;
  },
  BridgeUiWorkflowCard: (props: typeof mockBridgeUiProps[number]) => {
    mockBridgeUiProps.push(props);
    return props.surface.title;
  },
}));

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
      selfUpdate: true,
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
    selfUpdate: true,
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
            bridgeUrl="http://bridge"
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

describe('MainScreen live event coverage', () => {
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