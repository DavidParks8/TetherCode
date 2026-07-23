import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import type { HostBridgeApiClient } from '../../api/client';
import type { BridgeCapabilities, Chat, ChatSummary } from '../../api/types';
import type { HostBridgeWsClient } from '../../api/ws';
import { ChatMessage } from '../../components/ChatMessage';
import { AppThemeProvider, createAppTheme } from '../../theme';
import { MainScreen } from '../MainScreen';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: Object.assign(() => null, { glyphMap: {} }),
}));
jest.mock('react-native-markdown-display', () => 'Markdown');
jest.mock('../../components/LoadingGlyph', () => ({ LoadingGlyph: () => null }));
jest.mock('../../components/ApprovalBanner', () => ({ ApprovalBanner: () => null }));
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
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  readAsStringAsync: jest.fn().mockRejectedValue(new Error('missing')),
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  getInfoAsync: jest.fn(),
}));

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

describe('MainScreen control and modal coverage', () => {
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
    act(() => detailMessage?.props.onOpenLocalPreview('http://localhost:4173'));
    expect(onOpenLocalPreview).toHaveBeenCalledWith('http://localhost:4173');
    await press(byLabel(root, 'Close sub-agent transcript'));

    act(() => tree.unmount());
  });
});