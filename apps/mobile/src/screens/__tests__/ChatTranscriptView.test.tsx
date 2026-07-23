import { FlatList, Keyboard, Platform, Pressable } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { Chat } from '../../api/types';
import { createAgUiThreadMessageState } from '../../api/agUiMessages';
import { AppThemeProvider, createAppTheme } from '../../theme';
import { ChatTranscriptView, type ChatTranscriptViewProps } from '../ChatTranscriptView';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../../components/ChatMessage', () => ({
  ChatMessage: ({ message }: { message: { content: string } }) => message.content,
  ToolActivityGroup: () => null,
}));

type Queryable = ReactTestInstance & {
  children: unknown[];
  props: Record<string, unknown> & {
    contentContainerStyle: unknown[];
    data: Array<Record<string, unknown>>;
    keyExtractor: (item: Record<string, unknown>) => string;
    onContentSizeChange: jest.Mock;
    onLayout: jest.Mock;
    onMomentumScrollBegin: jest.Mock;
    onMomentumScrollEnd: jest.Mock;
    onPress: jest.Mock;
    onScroll: jest.Mock;
    onScrollBeginDrag: jest.Mock;
    onScrollEndDrag: jest.Mock;
    renderItem: (info: Record<string, unknown>) => React.ReactElement;
  };
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByProps(props: Record<string, unknown>): Queryable[];
  findAllByType(type: unknown): Queryable[];
};

type QueryableRenderer = ReactTestRenderer & { root: Queryable; toJSON(): unknown };

const theme = createAppTheme('dark');
const chat: Chat = {
  id: 'thread',
  title: 'Transcript',
  status: 'complete',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  statusUpdatedAt: '2026-07-20T00:00:00.000Z',
  lastMessagePreview: 'latest',
  messages: [{ id: 'message', role: 'assistant', content: 'latest', createdAt: '2026-07-20T00:00:00.000Z' }],
};

function makeMessages(count: number): Chat['messages'] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${String(index)}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${String(index)}`,
    createdAt: `2026-07-20T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
  }));
}

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return { ...chat, ...overrides };
}

const baseProps: ChatTranscriptViewProps = {
  chat,
  parentChat: null,
  bridgeUrl: 'https://bridge',
  bridgeToken: null,
  showToolCalls: true,
  agentThreadStatusById: new Map(),
  scrollRef: { current: null },
  inlineChoicesEnabled: false,
  onInlineOptionSelect: jest.fn(),
  onPinnedAutoScroll: jest.fn(),
  onJumpToLatest: jest.fn(),
  onScrollInteractionStart: jest.fn(),
  autoScrollStateRef: { current: { shouldStickToBottom: true, isUserInteracting: false, isMomentumScrolling: false } },
  bottomInset: 0,
};

function render(overrides: Partial<ChatTranscriptViewProps> = {}): QueryableRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <AppThemeProvider theme={theme}>
        <ChatTranscriptView {...baseProps} {...overrides} />
      </AppThemeProvider>
    );
  });
  if (!tree) throw new Error('Expected transcript tree');
  return tree as QueryableRenderer;
}

function findText(root: Queryable, value: string): Queryable {
  const match = root.findAll((node) => node.children.includes(value))[0];
  if (!match) throw new Error(`Missing text: ${value}`);
  return match;
}

function getList(tree: ReactTestRenderer): Queryable {
  return tree.root.findByType(FlatList) as Queryable;
}

function scroll(
  list: Queryable,
  y: number,
  contentHeight = 1000,
  viewportHeight = 200
): void {
  act(() => list.props.onScroll({
    nativeEvent: {
      contentOffset: { x: 0, y },
      contentSize: { width: 320, height: contentHeight },
      layoutMeasurement: { width: 320, height: viewportHeight },
    },
  }));
}

function update(tree: ReactTestRenderer, overrides: Partial<ChatTranscriptViewProps>): void {
  act(() => tree.update(
    <AppThemeProvider theme={theme}>
      <ChatTranscriptView {...baseProps} {...overrides} />
    </AppThemeProvider>
  ));
}

describe('ChatTranscriptView continuation', () => {
  it('renders load, loading, retry, exhausted, and unavailable boundary states', () => {
    const onLoadEarlier = jest.fn();
    const tree = render({
      continuationState: { loading: false, error: null, exhausted: false, unavailableCount: 0 },
      onLoadEarlier,
    });
    const list = tree.root.findByType(FlatList);
    expect(list.props.inverted).toBe(true);
    expect(list.props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 });
    const loadBoundary = list.props.ListFooterComponent as React.ReactElement<{
      onPress: () => void;
    }>;
    act(() => loadBoundary.props.onPress());
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);

    act(() => tree.update(
      <AppThemeProvider theme={theme}>
        <ChatTranscriptView {...baseProps} onLoadEarlier={onLoadEarlier} continuationState={{ loading: true, error: null, exhausted: false, unavailableCount: 0 }} />
      </AppThemeProvider>
    ));
    expect(findText(tree.root as Queryable, 'Loading earlier history...')).toBeTruthy();

    act(() => tree.update(
      <AppThemeProvider theme={theme}>
        <ChatTranscriptView {...baseProps} onLoadEarlier={onLoadEarlier} continuationState={{ loading: false, error: 'offline', exhausted: false, unavailableCount: 0 }} />
      </AppThemeProvider>
    ));
    expect(findText(tree.root as Queryable, 'Earlier history failed to load. Tap to retry.')).toBeTruthy();

    act(() => tree.update(
      <AppThemeProvider theme={theme}>
        <ChatTranscriptView {...baseProps} onLoadEarlier={onLoadEarlier} continuationState={{ loading: false, error: null, exhausted: true, unavailableCount: 0 }} />
      </AppThemeProvider>
    ));
    expect(tree.root.findAll((node) => node.children.includes('Beginning of history'))).toHaveLength(0);

    act(() => tree.update(
      <AppThemeProvider theme={theme}>
        <ChatTranscriptView {...baseProps} onLoadEarlier={onLoadEarlier} continuationState={{ loading: false, error: null, exhausted: true, unavailableCount: 3 }} />
      </AppThemeProvider>
    ));
    expect(findText(tree.root as Queryable, '3 older history entries are no longer available.')).toBeTruthy();

    update(tree, {
      continuationState: { loading: false, error: null, exhausted: true, unavailableCount: 1 },
      onLoadEarlier,
    });
    expect(findText(tree.root as Queryable, '1 older history entry is no longer available.')).toBeTruthy();
    act(() => tree.unmount());
  });

  it('drives drag, momentum, near-bottom, away-bottom, and jump-latest callbacks', () => {
    const autoScrollStateRef = {
      current: { shouldStickToBottom: true, isUserInteracting: false, isMomentumScrolling: false },
    };
    const onScrollInteractionStart = jest.fn();
    const onJumpToLatest = jest.fn();
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(jest.fn());
    const tree = render({ autoScrollStateRef, onScrollInteractionStart, onJumpToLatest });
    let list = getList(tree);

    act(() => list.props.onScrollBeginDrag());
    expect(onScrollInteractionStart).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(autoScrollStateRef.current).toEqual({
      shouldStickToBottom: false,
      isUserInteracting: true,
      isMomentumScrolling: false,
    });

    act(() => list.props.onMomentumScrollBegin());
    act(() => list.props.onScrollEndDrag());
    expect(autoScrollStateRef.current.isUserInteracting).toBe(true);
    act(() => list.props.onMomentumScrollEnd());
    expect(autoScrollStateRef.current.isUserInteracting).toBe(false);
    expect(autoScrollStateRef.current.isMomentumScrolling).toBe(false);

    act(() => list.props.onScrollBeginDrag());
    act(() => list.props.onScrollEndDrag());
    expect(autoScrollStateRef.current.isUserInteracting).toBe(false);

    scroll(list, 100);
    expect(autoScrollStateRef.current.shouldStickToBottom).toBe(false);
    const jump = tree.root.findByProps({ accessibilityLabel: 'Jump to latest message' }) as Queryable;
    act(() => jump.props.onPress());
    expect(onJumpToLatest).toHaveBeenCalledTimes(1);
    expect(autoScrollStateRef.current.shouldStickToBottom).toBe(true);

    list = getList(tree);
    scroll(list, -10);
    expect(autoScrollStateRef.current.shouldStickToBottom).toBe(true);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Jump to latest message' })).toHaveLength(0);
    dismiss.mockRestore();
    act(() => tree.unmount());
  });

  it('loads local pages from layout, content changes, and older-directed scrolls once per checkpoint', () => {
    const largeChat = makeChat({ messages: makeMessages(140) });
    const onPinnedAutoScroll = jest.fn();
    const tree = render({ chat: largeChat, onPinnedAutoScroll });
    let list = getList(tree);
    expect(list.props.data).toHaveLength(80);
    expect(list.props.initialNumToRender).toBe(18);
    expect(list.props.maxToRenderPerBatch).toBe(12);
    expect(list.props.updateCellsBatchingPeriod).toBe(32);
    expect(list.props.windowSize).toBe(13);

    act(() => list.props.onLayout({ nativeEvent: { layout: { height: 200 } } }));
    list = getList(tree);
    expect(list.props.data).toHaveLength(140);

    act(() => list.props.onContentSizeChange(320, 1000));
    expect(onPinnedAutoScroll).toHaveBeenCalledWith(false);
    scroll(list, 100, 1000, 200);
    expect(getList(tree).props.data).toHaveLength(140);

    const pagedChat = makeChat({ id: 'paged', messages: makeMessages(220) });
    update(tree, { chat: pagedChat, onPinnedAutoScroll });
    list = getList(tree);
    expect(list.props.data).toHaveLength(80);
    act(() => list.props.onContentSizeChange(320, 1000));
    scroll(list, 100, 1000, 0);
    scroll(list, 100, 1000, 200);
    scroll(list, 101, 1000, 200);
    scroll(list, 100, 1000, 200);
    expect(getList(tree).props.data).toHaveLength(80);
    const checkpointScroll = getList(tree).props.onScroll;
    act(() => {
      checkpointScroll({
        nativeEvent: {
          contentOffset: { x: 0, y: 760 },
          contentSize: { width: 320, height: 1000 },
          layoutMeasurement: { width: 320, height: 200 },
        },
      });
      checkpointScroll({
        nativeEvent: {
          contentOffset: { x: 0, y: 780 },
          contentSize: { width: 320, height: 1000 },
          layoutMeasurement: { width: 320, height: 200 },
        },
      });
    });
    expect(getList(tree).props.data).toHaveLength(160);
    scroll(getList(tree), 700, 1000, 200);
    scroll(getList(tree), 790, 1000, 200);
    expect(getList(tree).props.data).toHaveLength(220);

    update(tree, { chat: makeChat({ id: 'shrunk', messages: makeMessages(180) }), onPinnedAutoScroll });
    act(() => getList(tree).props.onLayout({ nativeEvent: { layout: { height: 200 } } }));
    expect(getList(tree).props.data).toHaveLength(160);
    update(tree, { chat: makeChat({ id: 'shrunk', messages: makeMessages(20) }), onPinnedAutoScroll });
    expect(getList(tree).props.data).toHaveLength(20);
    act(() => tree.unmount());
  });

  it('guards bridge pagination while loading or exhausted and requests it when available', () => {
    const onLoadEarlier = jest.fn();
    const tree = render({
      continuationState: { loading: true, error: null, exhausted: false, unavailableCount: 0 },
      onLoadEarlier,
    });
    let list = getList(tree);
    act(() => list.props.onLayout({ nativeEvent: { layout: { height: 200 } } }));
    expect(onLoadEarlier).not.toHaveBeenCalled();

    update(tree, {
      continuationState: { loading: false, error: null, exhausted: true, unavailableCount: 0 },
      onLoadEarlier,
    });
    list = getList(tree);
    act(() => list.props.onContentSizeChange(320, 100));
    expect(onLoadEarlier).not.toHaveBeenCalled();

    update(tree, {
      continuationState: { loading: false, error: null, exhausted: false, unavailableCount: 0 },
      onLoadEarlier,
    });
    list = getList(tree);
    act(() => list.props.onLayout({ nativeEvent: { layout: { height: 200 } } }));
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);

    update(tree, { continuationState: undefined, onLoadEarlier });
    list = getList(tree);
    act(() => list.props.onContentSizeChange(320, 100));
    expect(onLoadEarlier).toHaveBeenCalledTimes(2);
    act(() => tree.unmount());
  });

  it('uses platform keyboard and inset behavior', () => {
    const originalOS = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    const androidTree = render({ bottomInset: 24 });
    const androidList = getList(androidTree);
    expect(androidList.props.keyboardDismissMode).toBe('on-drag');
    expect(androidList.props.contentContainerStyle[1]).toEqual({ paddingTop: 24 });
    act(() => androidTree.unmount());

    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    const iosTree = render({ bottomInset: 12 });
    const iosList = getList(iosTree);
    expect(iosList.props.keyboardDismissMode).toBe('interactive');
    expect(iosList.props.contentContainerStyle[1]).toEqual({ paddingBottom: 12 });
    act(() => iosTree.unmount());
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
  });

  it('resets paging and scroll state for a new chat id', () => {
    const autoScrollStateRef = {
      current: { shouldStickToBottom: true, isUserInteracting: false, isMomentumScrolling: false },
    };
    const first = makeChat({ id: 'first', messages: makeMessages(180) });
    const tree = render({ chat: first, autoScrollStateRef });
    scroll(getList(tree), 100);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Jump to latest message' }).length).toBeGreaterThan(0);

    const second = makeChat({ id: 'second', title: '', messages: makeMessages(20) });
    update(tree, { chat: second, autoScrollStateRef });
    const list = getList(tree);
    expect(list.props.data).toHaveLength(20);
    expect(list.props.accessibilityLabel).toBe('Chat transcript');
    expect(tree.root.findAllByType(Pressable)).toHaveLength(0);
    expect(autoScrollStateRef.current).toEqual({
      shouldStickToBottom: true,
      isUserInteracting: false,
      isMomentumScrolling: false,
    });
    act(() => tree.unmount());
  });

  it('memoizes equivalent chats and rerenders for every compared prop family', () => {
    const messages = makeMessages(2);
    const stableChat = makeChat({ messages });
    const equivalentTree = render({ chat: stableChat });
    const firstRenderItem = getList(equivalentTree).props.renderItem;
    update(equivalentTree, { chat: makeChat({ title: 'Ignored title change', messages }) });
    expect(getList(equivalentTree).props.renderItem).toBe(firstRenderItem);
    act(() => equivalentTree.unmount());

    const changedChats: Chat[] = [
      makeChat({ id: 'other', messages }),
      makeChat({ parentThreadId: 'parent', messages }),
      makeChat({ agentId: 'agent', messages }),
      makeChat({ status: 'running', messages }),
      makeChat({ messages: [...messages] }),
    ];
    for (const changedChat of changedChats) {
      const changedTree = render({ chat: stableChat });
      update(changedTree, { chat: changedChat });
      expect(getList(changedTree).props.extraData).toBe(changedChat.status);
      act(() => changedTree.unmount());
    }

    const parent = makeChat({ id: 'parent', messages });
    const parentTree = render({ chat: stableChat, parentChat: parent });
    update(parentTree, { chat: stableChat, parentChat: makeChat({ id: 'parent-2', messages }) });
    update(parentTree, { chat: stableChat, parentChat: null });
    act(() => parentTree.unmount());

    const propVariants: Partial<ChatTranscriptViewProps>[] = [
      { bridgeUrl: 'https://other' },
      { bridgeToken: 'token' },
      { onOpenLocalPreview: jest.fn() },
      { showToolCalls: false },
      { agentThreadStatusById: new Map([['thread', 'running']]) },
      { scrollRef: { current: null } },
      { inlineChoicesEnabled: true },
      { onInlineOptionSelect: jest.fn() },
      { onPinnedAutoScroll: jest.fn() },
      { onJumpToLatest: jest.fn() },
      { onScrollInteractionStart: jest.fn() },
      { autoScrollStateRef: { current: { shouldStickToBottom: true, isUserInteracting: false, isMomentumScrolling: false } } },
      { bottomInset: 8 },
      { liveMessageState: createAgUiThreadMessageState() },
      { onOpenSubAgentThread: jest.fn() },
      { continuationState: { loading: false, error: null, exhausted: false, unavailableCount: 0 } },
      { onLoadEarlier: jest.fn() },
    ];
    for (const variant of propVariants) {
      const variantTree = render({ chat: stableChat });
      update(variantTree, { chat: stableChat, ...variant });
      expect(getList(variantTree).props.data).toHaveLength(2);
      act(() => variantTree.unmount());
    }
  });

  it('renders and keys messages, tool groups, and inline options through FlatList callbacks', () => {
    const onInlineOptionSelect = jest.fn();
    const messages: Chat['messages'] = [
      {
        id: 'tool', role: 'tool', toolCallId: 'tool', content: '• Ran tests',
        createdAt: '2026-07-20T00:00:00.000Z',
      },
      {
        id: 'choice', role: 'assistant',
        content: 'Which one?\n1. Fast - Quick result\n2. Safe',
        createdAt: '2026-07-20T00:00:01.000Z',
      },
    ];
    const tree = render({
      chat: makeChat({ status: 'running', messages }),
      inlineChoicesEnabled: true,
      onInlineOptionSelect,
    });
    const list = getList(tree);
    const messageItem = list.props.data.find((item) => item.kind === 'message');
    const toolItem = list.props.data.find((item) => item.kind === 'toolGroup');
    if (!messageItem || !toolItem) throw new Error('Expected message and tool items');
    expect(list.props.keyExtractor(messageItem)).toBe(messageItem.renderKey);
    expect(list.props.keyExtractor(toolItem)).toBe(toolItem.id);

    const renderedMessage = list.props.renderItem({
      item: messageItem, index: 0, separators: {},
    }) as React.ReactElement<{ children: React.ReactNode[] }>;
    const inlineChoices = renderedMessage.props.children[1] as React.ReactElement<{
      children: React.ReactNode[];
    }>;
    const options = inlineChoices.props.children[0] as React.ReactElement<{
      accessibilityHint: string;
      onPress: () => void;
      style: (state: { pressed: boolean }) => unknown[];
    }>[];
    let toolTree: ReactTestRenderer | undefined;
    act(() => {
      toolTree = renderer.create(<AppThemeProvider theme={theme}>{list.props.renderItem({ item: toolItem, index: 1, separators: {} })}</AppThemeProvider>);
    });
    if (!toolTree) throw new Error('Expected rendered tool item');
    expect(options).toHaveLength(2);
    expect(options[0].props.style({ pressed: false })[1]).toBe(false);
    expect(options[0].props.style({ pressed: true })[1]).toBeTruthy();
    expect(options[1].props.accessibilityHint).toBe('Fills the reply box with this answer');
    act(() => options[0].props.onPress());
    expect(onInlineOptionSelect).toHaveBeenCalledWith('Fast');
    expect((toolTree as QueryableRenderer).toJSON()).toBeTruthy();

    const noChoicesTree = render({
      chat: makeChat({ messages: [messages[1]] }),
      inlineChoicesEnabled: false,
    });
    const noChoicesList = getList(noChoicesTree);
    let itemTree: ReactTestRenderer | undefined;
    act(() => {
      itemTree = renderer.create(<AppThemeProvider theme={theme}>{noChoicesList.props.renderItem({
        item: noChoicesList.props.data[0], index: 0, separators: {},
      })}</AppThemeProvider>);
    });
    expect((itemTree as QueryableRenderer | undefined)?.root.findAllByType(Pressable)).toHaveLength(0);
    act(() => {
      toolTree?.unmount();
      itemTree?.unmount();
      noChoicesTree.unmount();
      tree.unmount();
    });
  });
});
