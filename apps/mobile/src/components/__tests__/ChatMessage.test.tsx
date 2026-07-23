import type { ReactNode } from 'react';
import { ActivityIndicator, Image, Linking, Modal, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import type { ChatMessage as ApiChatMessage } from '../../api/types';
import {
  COMPACTION_ACTIVITY_TYPE,
  createActivityMessage,
  SUBAGENT_ACTIVITY_TYPE,
} from '../../api/messages';
import { createAppTheme, AppThemeProvider } from '../../theme';
import { ChatMessage, ToolActivityGroup } from '../ChatMessage';

type QueryableTestInstance = ReactTestInstance & {
  type: unknown;
  props: Record<string, unknown> & {
    onContentSizeChange: jest.Mock;
    onLayout: jest.Mock;
    onLoad: jest.Mock;
    onRequestClose: jest.Mock;
    onScroll: jest.Mock;
    source?: { headers?: Record<string, string>; uri?: string };
  };
  children: unknown[];
  findAll(predicate: (node: QueryableTestInstance) => boolean): QueryableTestInstance[];
  findAllByProps(props: Record<string, unknown>): QueryableTestInstance[];
  findAllByType(type: unknown): QueryableTestInstance[];
};

type QueryableRenderer = ReactTestRenderer & { root: QueryableTestInstance; toJSON(): unknown };
type LegacyTestMessage = Omit<ApiChatMessage, 'role' | 'content'> & {
  id: string;
  role: ApiChatMessage['role'] | 'system';
  content: string;
  createdAt: string;
  systemKind?: 'tool' | 'reasoning' | 'subAgent' | 'compaction';
  subAgentMeta?: Parameters<typeof createActivityMessage>[2]['subAgent'];
};

jest.mock('react-native-reanimated', () => {
  const reactNative = jest.requireActual('react-native');

  return {
    __esModule: true,
    default: {
      Image: reactNative.Image,
    },
    clamp: (value: number, min: number, max: number) => Math.min(Math.max(value, min), max),
    useAnimatedStyle: (updater: () => unknown) => updater(),
    useSharedValue: <T,>(value: T) => ({ value }),
    withTiming: <T,>(value: T) => value,
  };
});

jest.mock('react-native-gesture-handler', () => {
  const React = jest.requireActual('react');
  const reactNative = jest.requireActual('react-native');

  const createGesture = () => {
    const chain = {
      enabled: () => chain,
      onStart: () => chain,
      onUpdate: () => chain,
      onEnd: () => chain,
      minDistance: () => chain,
      numberOfTaps: () => chain,
      maxDuration: () => chain,
    };
    return chain;
  };

  return {
    GestureDetector: ({ children }: { children: ReactNode }) => (
      <reactNative.View>{children}</reactNative.View>
    ),
    Gesture: {
      Pinch: () => createGesture(),
      Pan: () => createGesture(),
      Tap: () => createGesture(),
      Simultaneous: (...gestures: unknown[]) => gestures[0],
      Exclusive: (...gestures: unknown[]) => gestures[0],
    },
  };
});

describe('ChatMessage image viewer', () => {
  const theme = createAppTheme('dark');

  it('opens transcript images in a full-screen modal when tapped', () => {
    const message: ApiChatMessage = {
      id: 'msg_image',
      role: 'assistant',
      content: '[image: data:image/png;base64,abc123]',
      createdAt: '2026-04-17T00:00:00.000Z',
    };

    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 59, right: 0, bottom: 34, left: 0 },
          }}
        >
          <AppThemeProvider theme={theme}>
            <ChatMessage message={message} />
          </AppThemeProvider>
        </SafeAreaProvider>
      );
    });
    const tree = expectValue(rendered) as QueryableRenderer;

    const modal = tree.root.findByType(Modal);
    expect(modal.props.visible).toBe(false);

    const previewImage = tree.root.findAllByType(Image)[0];
    act(() => {
      previewImage.props.onLoad({ nativeEvent: { source: { width: 800, height: 400 } } });
      previewImage.props.onLoad({ nativeEvent: { source: { width: 800, height: 400 } } });
      previewImage.props.onLoad({ nativeEvent: { source: { width: 0, height: 400 } } });
      previewImage.props.onLoad({ nativeEvent: { source: {} } });
    });

    const trigger = tree.root.findByProps({
      testID: 'chat-image-fullscreen-trigger',
    });
    act(() => {
      readOnPress(trigger.props)();
    });

    expect(tree.root.findByType(Modal).props.visible).toBe(true);

    act(() => {
      (tree.root.findByType(Modal).props.onRequestClose as () => void)();
    });
    expect(tree.root.findByType(Modal).props.visible).toBe(false);

    act(() => {
      readOnPress(trigger.props)();
    });
    act(() => {
      readOnPress(tree.root.findByProps({ testID: 'chat-image-fullscreen-close' }).props)();
    });
    expect(tree.root.findByType(Modal).props.visible).toBe(false);

    act(() => {
      readOnPress(trigger.props)();
    });

    const backdrop = tree.root.findByProps({
      testID: 'chat-image-fullscreen-backdrop',
    });
    act(() => {
      readOnPress(backdrop.props)();
    });

    expect(tree.root.findByType(Modal).props.visible).toBe(false);
  });
});

describe('ChatMessage markdown formatting', () => {
  const theme = createAppTheme('dark');

  it('keeps assistant headings compact in chat', () => {
    const message: ApiChatMessage = {
      id: 'msg_heading',
      role: 'assistant',
      content: '# Role\n\nThe bridge connects the app to local runtimes.',
      createdAt: '2026-04-17T00:00:00.000Z',
    };

    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        <AppThemeProvider theme={theme}>
          <ChatMessage message={message} />
        </AppThemeProvider>
      );
    });
    const tree = expectValue(rendered);
    const root = tree.root as QueryableTestInstance;

    const heading = root
      .findAll((node) => node.type === Text)
      .find((node) => flattenRenderedText(node.props.children).includes('Role'));

    if (!heading) {
      throw new Error('Expected heading text to render');
    }
    const headingStyle = StyleSheet.flatten(heading.props.style as never) as { fontSize?: number };
    expect(headingStyle.fontSize).toBeLessThanOrEqual(18);
  });

  it('renders markdown tables in a horizontal scroll area', () => {
    const message: ApiChatMessage = {
      id: 'msg_table',
      role: 'assistant',
      content:
        '| Listener | Routes | Purpose |\n| --- | --- | --- |\n| Main | `GET /rpc`, `GET /health` | Primary API for the app |',
      createdAt: '2026-04-17T00:00:00.000Z',
    };

    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        <AppThemeProvider theme={theme}>
          <ChatMessage message={message} />
        </AppThemeProvider>
      );
    });
    const tree = expectValue(rendered);
    const root = tree.root as QueryableTestInstance;

    expect(
      root.findAll((node) => node.type === ScrollView).some((node) => node.props.horizontal === true)
    ).toBe(true);
  });

  it('routes web and local-preview links while rendering file links as labels', () => {
    const openUrl = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const onOpenLocalPreview = jest.fn();
    const tree = renderMessage({
      id: 'markdown-links',
      role: 'assistant',
      content: '[Docs](https://example.test/docs) [Preview](http://localhost:4173) [Source](file:///tmp/source.ts:12)',
      createdAt: '2026-04-17T00:00:00.000Z',
    }, { onOpenLocalPreview });
    const root = tree.root as QueryableTestInstance;

    act(() => {
      readOnPress(findTextPressable(root, 'Docs').props)();
      readOnPress(findTextPressable(root, 'Preview').props)();
    });

    expect(openUrl).toHaveBeenCalledWith('https://example.test/docs');
    expect(onOpenLocalPreview).toHaveBeenCalledWith('http://localhost:4173');
    expect(hasRenderedText(root, 'source.ts:12')).toBe(true);
    expect(findTextNodes(root, 'source.ts:12').every((node) => node.props.onPress === undefined)).toBe(true);
    act(() => tree.unmount());
    openUrl.mockRestore();
  });

  it('renders markdown images only when their source is usable', () => {
    const tree = renderMessage({
      id: 'markdown-images',
      role: 'assistant',
      content: '![Remote](https://example.test/remote.png) ![Missing]()',
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    const images = tree.root.findAllByType(Image);
    expect(images.some((node) => node.props.source?.uri === 'https://example.test/remote.png')).toBe(true);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Remote' }).length).toBeGreaterThan(0);
    act(() => tree.unmount());
  });
});

describe('ChatMessage command rows', () => {
  const theme = createAppTheme('dark');

  it('renders long command titles in horizontal scroll viewports without ellipsis', () => {
    const messages: LegacyTestMessage[] = [
      {
        id: 'tool_command',
        role: 'system',
        systemKind: 'tool',
        content: '• Ran npm test -- --runInBand src/components/__tests__/ChatMessage.test.tsx',
        createdAt: '2026-04-17T00:00:00.000Z',
      },
    ];

    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        <AppThemeProvider theme={theme}>
          <ToolActivityGroup messages={messages.map(toOfficialMessage)} />
        </AppThemeProvider>
      );
    });
    const tree = expectValue(rendered);
    const viewport = tree.root.findByProps({ testID: 'tool-command-scroll' });
    const horizontalScroll = viewport.findByType(ScrollView);
    const commandText = horizontalScroll.findByType(Text);

    expect(horizontalScroll.props.horizontal).toBe(true);
    expect(commandText.props.numberOfLines).toBeUndefined();
    expect(flattenRenderedText(commandText.props.children)).toContain('ChatMessage.test.tsx');
  });
});

describe('ChatMessage role and part matrices', () => {
  it.each([
    {
      name: 'user mentions and file markers',
      message: {
        id: 'user-file', role: 'user' as const, content: 'Review @report.txt\n[file: /tmp/report.txt]',
        createdAt: '2026-04-17T00:00:00.000Z',
      },
      expected: ['Review', '@report.txt', 'report.txt'],
    },
    {
      name: 'assistant empty cursor',
      message: {
        id: 'assistant-empty', role: 'assistant' as const, content: '',
        createdAt: '2026-04-17T00:00:00.000Z',
      },
      expected: ['▍'],
    },
    {
      name: 'compaction default',
      message: {
        id: 'compact', role: 'system' as const, systemKind: 'compaction' as const,
        content: 'Compacted conversation context', createdAt: '2026-04-17T00:00:00.000Z',
      },
      expected: ['Conversation compacted'],
    },
    {
      name: 'compaction custom',
      message: {
        id: 'compact-custom', role: 'system' as const, systemKind: 'compaction' as const,
        content: '- Reduced old turns', createdAt: '2026-04-17T00:00:00.000Z',
      },
      expected: ['Reduced old turns'],
    },
  ])('renders $name', ({ message, expected }) => {
    const tree = renderMessage(message);
    for (const text of expected) expect(hasRenderedText(tree.root as QueryableTestInstance, text)).toBe(true);
    act(() => tree.unmount());
  });

  it('renders all structured content part families and local image auth', () => {
    const message: ApiChatMessage = {
      id: 'parts',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-17T00:00:00.000Z',
      parts: [
        { type: 'text', text: 'Structured text' },
        { type: 'image', url: 'https://example.test/image.png' },
        { type: 'image', uri: '/tmp/local.png' },
        { type: 'image' },
        { type: 'audio', mimeType: 'audio/wav' },
        { type: 'audio' },
        { type: 'resourceLink', uri: 'file:///tmp/report.json', name: 'Report' },
        { type: 'resourceLink', uri: 'https://example.test/resource' },
        { type: 'resource', resource: { uri: 'file:///tmp/data.txt', text: 'Embedded text' } },
        { type: 'resource', resource: { text: 'Inline resource' } },
      ],
    };
    const tree = renderMessage(message, { bridgeUrl: 'http://bridge', bridgeToken: 'secret' });
    const root = tree.root as QueryableTestInstance;
    for (const text of ['Structured text', '[image]', '[audio: audio/wav]', '[audio]', 'Report', 'Embedded text', 'Inline resource']) {
      expect(hasRenderedText(root, text)).toBe(true);
    }
    const images = root.findAll((node) => node.type === Image);
    expect(images.some((node) => node.props.source?.uri === 'https://example.test/image.png')).toBe(true);
    expect(images.some((node) => String(node.props.source?.uri).includes('/local-image?path='))).toBe(true);
    expect(images.some((node) => node.props.source?.headers?.Authorization === 'Bearer secret')).toBe(true);
    act(() => tree.unmount());
  });

  it.each([
    ['remote marker', '[image: https://example.test/marker.png]', 'marker.png'],
    ['local marker', '[local image: /tmp/local-marker.png]', 'local-marker.png'],
    ['windows file', '[file: C:\\work\\report.txt:9]', 'report.txt:9'],
    ['encoded file', '[file: file:///tmp/my%20report.txt#L7]', 'my report.txt:7'],
    ['root file fallback', '[file: /]', '/'],
  ])('renders the %s content marker', (_name, content, expected) => {
    const tree = renderMessage({ id: content, role: 'assistant', content, createdAt: '2026-04-17T00:00:00.000Z' }, { bridgeUrl: 'https://bridge' });
    expect(hasRenderedText(tree.root as QueryableTestInstance, expected) || tree.root.findAllByProps({ accessibilityLabel: expected }).length > 0).toBe(true);
    act(() => tree.unmount());
  });

  it('renders structured data images and omits empty text and resource bodies', () => {
    const tree = renderMessage({
      id: 'part-fallbacks', role: 'assistant', content: 'ignored', createdAt: '2026-04-17T00:00:00.000Z',
      parts: [
        { type: 'text', text: '' },
        { type: 'image', data: 'abc123', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 42 as never, text: '' } },
      ],
    });
    expect(tree.root.findAllByType(Image).some((node) => node.props.source?.uri === 'data:image/png;base64,abc123')).toBe(true);
    expect(hasRenderedText(tree.root as QueryableTestInstance, '[embedded resource]')).toBe(true);
    act(() => tree.unmount());
  });
});

describe('ChatMessage system timeline matrices', () => {
  it.each([
    { kind: 'reasoning' as const, content: '• Plan\n  └ First thought\n  └ Second thought', label: 'Plan', hint: 'Tap to show thinking' },
    { kind: 'tool' as const, content: '• Called tool `search`\n  └ query=coverage\n  └ 3 results', label: 'Called tool `search`', hint: 'Tap to show 2 lines' },
  ])('expands $kind timeline details', ({ kind, content, label, hint }) => {
    const tree = renderMessage({
      id: `timeline-${kind}`, role: 'system', systemKind: kind, content,
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    const root = tree.root as QueryableTestInstance;
    expect(root.findAll((node) => node.props.accessibilityLabel === label).length).toBeGreaterThan(0);
    expect(hasRenderedText(root, hint)).toBe(true);
    const control = root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];
    act(() => readOnPress(control.props)());
    expect(hasRenderedText(root, kind === 'reasoning' ? 'First thought' : 'query=coverage')).toBe(true);
    act(() => tree.unmount());
  });

  it('renders subagent details and opens the receiver transcript', () => {
    const onOpenSubAgentThread = jest.fn();
    const tree = renderMessage({
      id: 'subagent', role: 'system', systemKind: 'subAgent',
      content: '• Spawned agent\n  └ Analyze tests',
      subAgentMeta: { receiverThreadIds: [' child-thread '] },
      createdAt: '2026-04-17T00:00:00.000Z',
    }, { onOpenSubAgentThread });
    const root = tree.root as QueryableTestInstance;
    expect(hasRenderedText(root, 'Analyze tests')).toBe(true);
    expect(hasRenderedText(root, 'Open agent chat')).toBe(true);
    const control = root.findAll((node) => node.props.accessibilityLabel === 'Spawned agent' && typeof node.props.onPress === 'function')[0];
    act(() => readOnPress(control.props)());
    expect(onOpenSubAgentThread).toHaveBeenCalledWith('child-thread');
    act(() => tree.unmount());
  });

  it('shows internal subagent results without a broken transcript action', () => {
    const onOpenSubAgentThread = jest.fn();
    const tree = renderMessage({
      id: 'subagent-internal',
      role: 'system',
      systemKind: 'subAgent',
      content: '• Spawned sub-agent\n  Result: Workspace title',
      createdAt: '',
      subAgentMeta: {
        receiverThreadIds: ['child-internal'],
        agentStatus: 'completed',
        navigable: false,
      },
    }, { onOpenSubAgentThread });
    const root = tree.root as QueryableTestInstance;
    const button = root.findAll((node) => node.props.accessibilityRole === 'button')[0];
    expect(button?.props.accessibilityState).toMatchObject({ disabled: true });
    expect(hasRenderedText(root, 'Workspace title')).toBe(true);
    expect(hasRenderedText(root, 'Open agent chat')).toBe(false);
    act(() => tree.unmount());
  });

  it('animates a running subagent card and stops after completion', () => {
    const running = createActivityMessage('subagent-live', SUBAGENT_ACTIVITY_TYPE, {
      text: '• Sub-agent working\n  Latest: Reading repository',
      subAgent: { toolCallId: 'task-live', agentStatus: 'running', receiverThreadIds: [] },
    }, '2026-04-17T00:00:00.000Z');
    const tree = renderMessage(running);
    expect(tree.root.findAllByType(ActivityIndicator)).toHaveLength(1);

    const completed = createActivityMessage('subagent-live', SUBAGENT_ACTIVITY_TYPE, {
      text: '• Sub-agent completed\n  Latest: Returned result',
      subAgent: { toolCallId: 'task-live', agentStatus: 'completed', receiverThreadIds: [] },
    }, '2026-04-17T00:00:01.000Z');
    const completedTree = renderMessage(completed);
    expect(completedTree.root.findAllByType(ActivityIndicator)).toHaveLength(0);
    act(() => tree.unmount());
    act(() => completedTree.unmount());
  });

  it('renders collapsed and expanded tool activity groups with error and overflow entries', () => {
    const messages: LegacyTestMessage[] = [
      { id: 'one', role: 'system', systemKind: 'tool', content: '• Ran npm test\n  └ pass', createdAt: '2026-04-17T00:00:00.000Z' },
      { id: 'two', role: 'system', systemKind: 'tool', content: '• Called tool `lint`\n  └ clean', createdAt: '2026-04-17T00:00:00.000Z' },
      { id: 'three', role: 'system', systemKind: 'tool', content: '• Tool failed `build`\n  └ compile error', createdAt: '2026-04-17T00:00:00.000Z' },
    ];
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<AppThemeProvider theme={createAppTheme('dark')}><ToolActivityGroup messages={messages.map(toOfficialMessage)} liveTurnActive /></AppThemeProvider>);
    });
    const rendered = expectValue(tree);
    const root = rendered.root as QueryableTestInstance;
    expect(hasRenderedText(root, '+1 more')).toBe(true);
    const expand = root.findAll((node) =>
      typeof node.props.onPress === 'function' &&
      (node.props.accessibilityState as { expanded?: boolean } | undefined)?.expanded === false
    )[0];
    if (!expand) throw new Error('Missing tool group expander');
    act(() => readOnPress(expand.props)());
    expect(hasRenderedText(root, 'Tool failed `build`')).toBe(true);
    act(() => rendered.unmount());
  });

  it('renders the computer-use action family with metadata and image output', () => {
    const actions = [
      ['getAppState', 'Captured screen'], ['click', 'Clicked'], ['scroll', 'Scrolled'],
      ['typeText', 'Typed text'], ['pressKey', 'Pressed key'], ['drag', 'Dragged'],
      ['setValue', 'Set value'], ['listApps', 'Listed apps'], ['customAction', 'Custom Action'],
    ];
    const content = actions.map(([action], index) =>
      `• Called tool \`computerUse/${action}\`\n  └ ${index === 0 ? '[image: https://example.test/screen.png]' : index === 1 ? 'Window: "Editor", App: com.microsoft.VSCode.' : 'App=com.apple.Safari (active)'}`
    ).join('\n');
    const tree = renderMessage({
      id: 'computer-use', role: 'system', systemKind: 'tool', content,
      createdAt: '2026-04-17T00:00:00.000Z',
    });
    const root = tree.root as QueryableTestInstance;
    expect(hasRenderedText(root, '9 actions')).toBe(true);
    for (const [, label] of actions) expect(hasRenderedText(root, label)).toBe(true);
    expect(hasRenderedText(root, 'VSCode')).toBe(true);
    expect(root.findAllByType(Image).some((node) => node.props.source?.uri === 'https://example.test/screen.png')).toBe(true);
    act(() => tree.unmount());
  });

  it.each([
    ['Ran command', '1 command'],
    ['Called tool `search`', '1 tool call'],
    ['Searched web for coverage', '1 web search'],
    ['Applied file changes', '1 file change'],
    ['Reading source.ts', '1 file read'],
    ['Listing src', '1 folder listing'],
    ['Explored tests', '1 exploration'],
    ['Viewed image', '1 tool step'],
  ])('summarizes %s tool groups', (title, summary) => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <AppThemeProvider theme={createAppTheme('dark')}>
          <ToolActivityGroup messages={[toOfficialMessage({
            id: title, role: 'system', systemKind: 'tool', content: `• ${title}`,
            createdAt: '2026-04-17T00:00:00.000Z',
          })]} />
        </AppThemeProvider>
      );
    });
    expect(hasRenderedText(expectValue(tree).root as QueryableTestInstance, summary)).toBe(true);
    act(() => expectValue(tree).unmount());
  });

  it('expands image and long-output tool details and updates command fades', () => {
    const details = Array.from({ length: 26 }, (_, index) => `line ${String(index + 1)}`);
    const messages: LegacyTestMessage[] = [
      { id: 'view', role: 'system', systemKind: 'tool', content: '• Viewed image\n  └ /tmp/screen.png', createdAt: '2026-04-17T00:00:00.000Z' },
      { id: 'long', role: 'system', systemKind: 'tool', content: `• Ran exhaustive command\n${details.map((line) => `  └ ${line}`).join('\n')}`, createdAt: '2026-04-17T00:00:00.000Z' },
    ];
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(<AppThemeProvider theme={createAppTheme('dark')}><ToolActivityGroup messages={messages.map(toOfficialMessage)} bridgeUrl="https://bridge" bridgeToken="token" /></AppThemeProvider>);
    });
    const rendered = expectValue(tree);
    const root = rendered.root as QueryableTestInstance;
    const header = root.findAll((node) => typeof node.props.onPress === 'function' && String(node.props.accessibilityLabel).includes('tools'))[0];
    act(() => readOnPress(header.props)());
    const viewEntry = root.findAll((node) => node.props.accessibilityLabel === 'Viewed image')[0];
    const longEntry = root.findAll((node) => node.props.accessibilityLabel === 'Ran exhaustive command')[0];
    const commandScroll = root.findByProps({ testID: 'tool-command-scroll' }).findByType(ScrollView) as QueryableTestInstance;
    act(() => {
      commandScroll.props.onLayout({ nativeEvent: { layout: { width: 100 } } });
      commandScroll.props.onContentSizeChange(300);
      commandScroll.props.onScroll({ nativeEvent: { contentOffset: { x: 50 } } });
    });
    expect(root.findAll((node) => Array.isArray(node.props.colors)).length).toBeGreaterThanOrEqual(1);
    act(() => {
      commandScroll.props.onScroll({ nativeEvent: { contentOffset: { x: 200 } } });
    });
    act(() => {
      readOnPress(viewEntry.props)();
    });
    expect(hasRenderedText(root, 'Tap to hide output')).toBe(true);
    act(() => {
      readOnPress(longEntry.props)();
    });
    expect(hasRenderedText(root, 'line 26')).toBe(true);
    expect(root.findAllByType(ScrollView).some((node) => node.props.showsVerticalScrollIndicator === true)).toBe(true);
    act(() => rendered.unmount());
  });

  it('renders disabled reasoning, subagent, and empty tool edge cases', () => {
    const reasoning = renderMessage({ id: 'reasoning-empty', role: 'system', systemKind: 'reasoning', content: '• Waiting', createdAt: '2026-04-17T00:00:00.000Z' });
    expect((reasoning.root as QueryableTestInstance).findAll((node) => node.props.accessibilityLabel === 'Waiting')[0].props.accessibilityState).toEqual({ disabled: true });
    act(() => reasoning.unmount());

    const subagent = renderMessage({ id: 'subagent-error', role: 'system', systemKind: 'subAgent', content: '• Agent failed', subAgentMeta: { receiverThreadIds: [''] }, createdAt: '2026-04-17T00:00:00.000Z' });
    expect((subagent.root as QueryableTestInstance).findAll((node) => node.props.accessibilityLabel === 'Agent failed')[0].props.accessibilityState).toEqual({ disabled: true });
    act(() => subagent.unmount());

    let emptyGroup: ReactTestRenderer | undefined;
    act(() => { emptyGroup = renderer.create(<AppThemeProvider theme={createAppTheme('dark')}><ToolActivityGroup messages={[]} /></AppThemeProvider>); });
    expect((expectValue(emptyGroup) as QueryableRenderer).toJSON()).toBeNull();
    act(() => expectValue(emptyGroup).unmount());
  });

  it.each([
    ['Agent waiting', 'pause-circle-outline'],
    ['Agent closed', 'checkmark-circle-outline'],
    ['Spawned helper', 'sparkles-outline'],
    ['Agent active', 'git-branch-outline'],
  ])('renders the %s subagent visual', (title, icon) => {
    const tree = renderMessage({ id: title, role: 'system', systemKind: 'subAgent', content: `• ${title}`, createdAt: '2026-04-17T00:00:00.000Z' });
    expect((tree.root as QueryableTestInstance).findAll((node) => node.props.name === icon).length).toBeGreaterThan(0);
    act(() => tree.unmount());
  });

  it.each([
    ['', 'Conversation compacted'],
    ['• Compacted conversation context', 'Conversation compacted'],
    ['- Custom compaction', 'Custom compaction'],
  ])('formats compaction content %p', (content, expected) => {
    const tree = renderMessage({ id: `compact-${content}`, role: 'system', systemKind: 'compaction', content, createdAt: '2026-04-17T00:00:00.000Z' });
    expect(hasRenderedText(tree.root as QueryableTestInstance, expected)).toBe(true);
    act(() => tree.unmount());
  });

  it('falls back to plain system markdown for malformed timeline content', () => {
    const tree = renderMessage({ id: 'malformed', role: 'system', systemKind: 'tool', content: 'before bullet\n• Tool call', createdAt: '2026-04-17T00:00:00.000Z' });
    expect(hasRenderedText(tree.root as QueryableTestInstance, 'before bullet')).toBe(true);
    act(() => tree.unmount());
  });
});

function renderMessage(
  message: ApiChatMessage | LegacyTestMessage,
  props: { bridgeUrl?: string; bridgeToken?: string; onOpenLocalPreview?: (url: string) => void; onOpenSubAgentThread?: (id: string) => void } = {}
): QueryableRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 59, right: 0, bottom: 34, left: 0 } }}>
        <AppThemeProvider theme={createAppTheme('dark')}>
          <ChatMessage message={toOfficialMessage(message)} {...props} />
        </AppThemeProvider>
      </SafeAreaProvider>
    );
  });
  return expectValue(tree) as QueryableRenderer;
}

function toOfficialMessage(message: ApiChatMessage | LegacyTestMessage): ApiChatMessage {
  const legacy = message as LegacyTestMessage;
  if (legacy.systemKind === 'reasoning') {
    return { id: legacy.id, role: 'reasoning', content: legacy.content, createdAt: legacy.createdAt };
  }
  if (legacy.systemKind === 'tool') {
    return { id: legacy.id, role: 'tool', toolCallId: legacy.id, content: legacy.content, createdAt: legacy.createdAt };
  }
  if (legacy.systemKind === 'subAgent') {
    return createActivityMessage(legacy.id, SUBAGENT_ACTIVITY_TYPE, {
      text: legacy.content,
      ...(legacy.subAgentMeta ? { subAgent: legacy.subAgentMeta } : {}),
    }, legacy.createdAt);
  }
  if (legacy.systemKind === 'compaction') {
    return createActivityMessage(legacy.id, COMPACTION_ACTIVITY_TYPE, { text: legacy.content }, legacy.createdAt);
  }
  return message as ApiChatMessage;
}

function hasRenderedText(root: QueryableTestInstance, text: string): boolean {
  return root.findAll((node) => flattenRenderedText(node.children).includes(text)).length > 0;
}

function expectValue<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('Expected value to be set');
  }
  return value;
}

function readOnPress(props: Record<string, unknown>): () => void {
  if (typeof props.onPress !== 'function') {
    throw new Error('Expected press handler');
  }
  return props.onPress as () => void;
}

function findTextNodes(root: QueryableTestInstance, text: string): QueryableTestInstance[] {
  return root.findAll((node) => node.type === Text && flattenTestTreeText(node) === text);
}

function findTextPressable(root: QueryableTestInstance, text: string): QueryableTestInstance {
  const node = findTextNodes(root, text).find((candidate) => typeof candidate.props.onPress === 'function');
  if (!node) throw new Error(`Expected pressable text "${text}"`);
  return node;
}

function flattenTestTreeText(node: QueryableTestInstance): string {
  return node.children.map((child) =>
    typeof child === 'string' || typeof child === 'number'
      ? String(child)
      : flattenTestTreeText(child as QueryableTestInstance)
  ).join('');
}

function flattenRenderedText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(flattenRenderedText).join('');
  }
  return '';
}
