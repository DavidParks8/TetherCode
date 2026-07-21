import React from 'react';
import {
  Animated,
  Modal,
  ScrollView,
  type ViewStyle,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import type { PendingApproval, RunEvent } from '../../api/types';
import { AppThemeProvider, createAppTheme } from '../../theme';
import { ApprovalBanner } from '../ApprovalBanner';
import { ChatHeader } from '../ChatHeader';
import { ChoiceAction } from '../ChoiceAction';
import { LoadingGlyph, type LoadingGlyphVariant } from '../LoadingGlyph';
import { SelectionSheet, type SelectionSheetOption } from '../SelectionSheet';
import { StatusLine } from '../StatusLine';
import { ToolBlock } from '../ToolBlock';

jest.mock('@expo/vector-icons', () => {
  const mockReact = jest.requireActual('react');
  const { Text: MockText } = jest.requireActual('react-native');
  return {
    Ionicons: ({ name }: { name: string }) => mockReact.createElement(MockText, null, name),
  };
});

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'View' },
  FadeInDown: { duration: () => undefined },
  FadeInUp: { duration: () => undefined },
}));

jest.mock('expo-linear-gradient', () => ({
  LinearGradient: 'LinearGradient',
}));

type QueryableInstance = Omit<ReactTestInstance, 'props' | 'children' | 'findAll'> & {
  type: unknown;
  props: Record<string, unknown>;
  children: Array<QueryableInstance | string>;
  findAll(predicate: (node: QueryableInstance) => boolean): QueryableInstance[];
};

const theme = createAppTheme('dark');
const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function wrap(node: React.ReactNode) {
  return (
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <AppThemeProvider theme={theme}>{node}</AppThemeProvider>
    </SafeAreaProvider>
  );
}

function render(node: React.ReactNode): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(wrap(node));
  });
  if (!tree) throw new Error('Component did not render');
  return tree;
}

function queryRoot(tree: ReactTestRenderer): QueryableInstance {
  return tree.root as QueryableInstance;
}

function textContent(node: QueryableInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
}

function findPressable(root: QueryableInstance, label: string): QueryableInstance {
  const match = root.findAll(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
  )[0];
  if (!match) throw new Error(`Missing pressable: ${label}`);
  return match;
}

function invokeStyle(node: QueryableInstance, pressed: boolean): unknown {
  const style = node.props.style;
  return typeof style === 'function' ? style({ pressed }) : style;
}

function invokeProp(node: QueryableInstance, name: string, ...args: unknown[]): unknown {
  const callback = node.props[name];
  if (typeof callback !== 'function') throw new Error(`Missing callback: ${name}`);
  return callback(...args);
}

function findType(root: QueryableInstance, type: unknown): QueryableInstance {
  return root.findByType(type as React.ElementType) as QueryableInstance;
}

describe('component coverage closure', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('resolves command and file approvals across pending, reject, and retry states', async () => {
    let finishResolution: (() => void) | undefined;
    const onResolve = jest.fn(
      () => new Promise<void>((resolve) => { finishResolution = resolve; })
    );
    const commandApproval: PendingApproval = {
      requestId: 'approval-1',
      agentId: 'codex',
      kind: 'commandExecution',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      title: 'Run command',
      message: 'Runs the focused suite',
      requestedAt: '2026-07-20T12:00:00.000Z',
      command: 'npm test',
      reason: 'Runs the focused suite',
      options: [
        { id: 'allow', label: 'Allow', kind: 'allow' },
        { id: 'reject', label: 'Reject', kind: 'reject' },
      ],
    };
    const tree = render(<ApprovalBanner approval={commandApproval} onResolve={onResolve} />);
    const root = queryRoot(tree);
    const allow = findPressable(root, 'Allow');
    expect(invokeStyle(allow, true)).toBeDefined();

    await act(async () => {
      invokeProp(allow, 'onPress');
      await Promise.resolve();
    });
    expect(onResolve).toHaveBeenCalledWith('approval-1', 'allow');
    expect(findPressable(root, 'Allow').props.accessibilityState).toEqual({
      disabled: true,
      busy: true,
    });
    expect(findPressable(root, 'Reject').props.accessibilityState).toEqual({
      disabled: true,
      busy: false,
    });
    await act(async () => finishResolution?.());
    expect(findPressable(root, 'Allow').props.accessibilityState).toEqual({
      disabled: false,
      busy: false,
    });

    const failed = jest.fn().mockRejectedValue(new Error('denied'));
    act(() => {
      tree.update(wrap(<ApprovalBanner approval={{ ...commandApproval, command: undefined }} onResolve={failed} />));
    });
    await act(async () => invokeProp(findPressable(queryRoot(tree), 'Reject'), 'onPress'));
    expect(failed).toHaveBeenCalledWith('approval-1', 'reject');

    act(() => {
      tree.update(wrap(
        <ApprovalBanner
          approval={{ ...commandApproval, kind: 'fileChange', reason: undefined }}
          onResolve={jest.fn().mockResolvedValue(undefined)}
        />
      ));
    });
    expect(textContent(queryRoot(tree))).toContain('File change');
    act(() => tree.unmount());
  });

  it('renders and presses every ChoiceAction presentation', () => {
    const onPress = jest.fn();
    const tree = render(
      <>
        <ChoiceAction title="Primary" meta="Ready" variant="primary" logo="github" onPress={onPress} />
        <ChoiceAction title="Brand" logo="clawdex" onPress={onPress} />
        <ChoiceAction title="Icon" iconName="folder-outline" onPress={onPress} />
        <ChoiceAction title="Loading" loading onPress={onPress} />
        <ChoiceAction title="Disabled" disabled onPress={onPress} />
        <ChoiceAction title="Plain" onPress={onPress} />
      </>
    );
    const buttons = queryRoot(tree).findAll(
      (node) => typeof node.props.onPress === 'function' && typeof node.props.style === 'function'
    );
    expect(buttons).toHaveLength(6);
    expect(invokeStyle(buttons[0], true)).toBeDefined();
    expect(invokeStyle(buttons[3], true)).toBeDefined();
    expect(invokeStyle(buttons[4], false)).toBeDefined();
    act(() => invokeProp(buttons[0], 'onPress'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(textContent(queryRoot(tree))).toContain('Ready');
    act(() => tree.unmount());
  });

  it('tracks ToolBlock overflow fades and all statuses', () => {
    const tree = render(<ToolBlock command="cargo test --all-targets" status="running" />);
    const scroll = findType(queryRoot(tree), ScrollView);
    act(() => {
      invokeProp(scroll, 'onLayout', { nativeEvent: { layout: { width: 100 } } });
      invokeProp(scroll, 'onContentSizeChange', 240);
    });
    expect(queryRoot(tree).findAll((node) => node.type === 'LinearGradient')).toHaveLength(1);
    act(() => invokeProp(scroll, 'onScroll', { nativeEvent: { contentOffset: { x: 40 } } }));
    expect(queryRoot(tree).findAll((node) => node.type === 'LinearGradient')).toHaveLength(2);
    act(() => invokeProp(scroll, 'onScroll', { nativeEvent: { contentOffset: { x: 140 } } }));
    expect(queryRoot(tree).findAll((node) => node.type === 'LinearGradient')).toHaveLength(1);
    act(() => tree.update(wrap(<ToolBlock command="done" status="complete" icon="code-outline" />)));
    expect(textContent(queryRoot(tree))).toContain('checkmark');
    act(() => tree.update(wrap(<ToolBlock command="failed" status="error" />)));
    expect(textContent(queryRoot(tree))).toContain('close');
    act(() => tree.unmount());
  });

  it('starts and stops pulse, bars, and ring animations and renders both sizes', () => {
    const starts: jest.Mock[] = [];
    const stops: jest.Mock[] = [];
    jest.spyOn(Animated, 'loop').mockImplementation(() => {
      const start = jest.fn();
      const stop = jest.fn();
      starts.push(start);
      stops.push(stop);
      return { start, stop } as unknown as Animated.CompositeAnimation;
    });

    const variants: LoadingGlyphVariant[] = ['spinner', 'pulse', 'bars', 'ring'];
    const tree = render(
      <>{variants.map((variant) => <LoadingGlyph key={variant} color="#fff" variant={variant} />)}</>
    );
    expect(starts).toHaveLength(3);
    act(() => {
      tree.update(wrap(<LoadingGlyph color="#000" variant="ring" size="medium" style={{ opacity: 0.5 } as ViewStyle} />));
    });
    act(() => tree.unmount());
    expect(stops.every((stop) => stop.mock.calls.length > 0)).toBe(true);
  });

  it('renders known, failed, detailed, and unknown status events', () => {
    const events = [
      { eventType: 'run.started', detail: undefined },
      { eventType: 'run.completed', detail: 'All checks passed' },
      { eventType: 'run.failed', detail: 'Exit 1' },
      { eventType: 'run.paused', detail: '' },
    ] as RunEvent[];
    const tree = render(<>{events.map((event) => <StatusLine key={event.eventType} event={event} />)}</>);
    const content = textContent(queryRoot(tree));
    expect(content).toContain('Run started');
    expect(content).toContain('Run completed — All checks passed');
    expect(content).toContain('Run failed — Exit 1');
    expect(content).toContain('run.paused');
    act(() => tree.unmount());
  });

  it('opens ChatHeader actions and updates title overflow fades', () => {
    const onOpenDrawer = jest.fn();
    const onOpenTitleMenu = jest.fn();
    const onRightActionPress = jest.fn();
    const tree = render(
      <ChatHeader
        onOpenDrawer={onOpenDrawer}
        title="  A very long chat title  "
        onOpenTitleMenu={onOpenTitleMenu}
        rightIconName="git-branch-outline"
        onRightActionPress={onRightActionPress}
      />
    );
    const root = queryRoot(tree);
    act(() => invokeProp(findPressable(root, 'Open navigation drawer'), 'onPress'));
    act(() => invokeProp(findPressable(root, 'A very long chat title, chat options'), 'onPress'));
    act(() => invokeProp(findPressable(root, 'Open Git'), 'onPress'));
    expect(onOpenDrawer).toHaveBeenCalled();
    expect(onOpenTitleMenu).toHaveBeenCalled();
    expect(onRightActionPress).toHaveBeenCalled();
    expect(invokeStyle(findPressable(root, 'A very long chat title, chat options'), true)).toBeDefined();

    const scroll = findType(root, ScrollView);
    act(() => {
      invokeProp(scroll, 'onLayout', { nativeEvent: { layout: { width: 90 } } });
      invokeProp(scroll, 'onContentSizeChange', 240);
    });
    expect(root.findAll((node) => node.type === 'LinearGradient')).toHaveLength(1);
    act(() => invokeProp(scroll, 'onScroll', { nativeEvent: { contentOffset: { x: 30 } } }));
    expect(root.findAll((node) => node.type === 'LinearGradient')).toHaveLength(2);
    act(() => invokeProp(scroll, 'onScroll', { nativeEvent: { contentOffset: { x: 150 } } }));
    expect(root.findAll((node) => node.type === 'LinearGradient')).toHaveLength(1);

    act(() => {
      tree.update(wrap(<ChatHeader onOpenDrawer={onOpenDrawer} title=" " rightIconName="search" />));
    });
    expect(textContent(queryRoot(tree))).toContain('New chat');
    act(() => tree.update(wrap(<ChatHeader onOpenDrawer={onOpenDrawer} title="Plain" />)));
    expect(textContent(queryRoot(tree))).toContain('Plain');
    act(() => tree.unmount());
  });

  it('renders and invokes populated SelectionSheet option variants', () => {
    const onClose = jest.fn();
    const optionPresses = [jest.fn(), jest.fn(), jest.fn()];
    const options: SelectionSheetOption[] = [
      {
        key: 'selected', title: 'Selected', description: 'Current choice', badge: 'Active',
        meta: 'Default', icon: 'checkmark', selected: true, tone: 'accent',
        descriptionNumberOfLines: 4, titleColor: '#101010', descriptionColor: '#202020',
        titleStyle: { fontWeight: '700' }, descriptionStyle: { fontStyle: 'italic' },
        badgeBackgroundColor: '#303030', badgeTextColor: '#fff', metaColor: '#404040',
        iconColor: '#505050', onPress: optionPresses[0],
      },
      {
        key: 'danger', title: 'Delete', description: 'Cannot be undone', icon: 'trash-outline',
        tone: 'danger', disabled: true, onPress: optionPresses[1],
      },
      { key: 'plain', title: 'Plain', onPress: optionPresses[2] },
    ];
    const tree = render(
      <SelectionSheet
        visible title="Choose one" subtitle="Available choices" eyebrow="Workspace"
        options={options} onClose={onClose} closeLabel="Done" presentation="expanded"
      />
    );
    const root = queryRoot(tree);
    const selected = findPressable(root, 'Selected');
    const danger = findPressable(root, 'Delete');
    const plain = findPressable(root, 'Plain');
    expect(selected.props.accessibilityState).toEqual({ disabled: false, selected: true });
    expect(danger.props.accessibilityState).toEqual({ disabled: true });
    expect(invokeStyle(selected, true)).toBeDefined();
    expect(invokeStyle(danger, true)).toBeDefined();
    expect(invokeStyle(plain, false)).toBeDefined();
    act(() => invokeProp(selected, 'onPress'));
    expect(optionPresses[0]).toHaveBeenCalled();
    act(() => invokeProp(findPressable(root, 'Close Choose one'), 'onPress'));
    act(() => invokeProp(findPressable(root, 'Done'), 'onPress'));
    act(() => invokeProp(findType(root, Modal), 'onRequestClose'));
    expect(onClose).toHaveBeenCalledTimes(3);
    act(() => tree.unmount());
  });

  it('renders SelectionSheet loading, empty, hidden, and default presentations', () => {
    const onClose = jest.fn();
    const tree = render(
      <SelectionSheet visible title="Loading sheet" options={[]} onClose={onClose} loading />
    );
    expect(textContent(queryRoot(tree))).toContain('Loading…');
    act(() => {
      tree.update(wrap(
        <SelectionSheet
          visible title="Empty sheet" subtitle="Nothing here" options={[]} onClose={onClose}
          loadingLabel="Fetching choices" emptyLabel="No choices" presentation="default"
        />
      ));
    });
    expect(textContent(queryRoot(tree))).toContain('No choices');
    act(() => {
      tree.update(wrap(
        <SelectionSheet visible={false} title="Hidden" options={[]} onClose={onClose} />
      ));
    });
    expect(findType(queryRoot(tree), Modal).props.visible).toBe(false);
    act(() => tree.unmount());
  });
});