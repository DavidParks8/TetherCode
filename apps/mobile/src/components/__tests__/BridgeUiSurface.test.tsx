import renderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { Modal } from 'react-native';
import type { BridgeUiAction, BridgeUiSurface } from '../../api/types';
import { AppThemeProvider, createAppTheme } from '../../theme';
import { BridgeUiBanner, BridgeUiModal, BridgeUiWorkflowCard } from '../BridgeUiSurface';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name }: { name: string }) => {
    const React = jest.requireActual('react');
    const reactNative = jest.requireActual('react-native');
    return React.createElement(reactNative.Text, null, name);
  },
}));

type QueryableTestInstance = ReactTestInstance & {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
  findAll(predicate: (node: QueryableTestInstance) => boolean): QueryableTestInstance[];
};

describe('BridgeUiWorkflowCard', () => {
  const theme = createAppTheme('dark');

  it('renders and resolves a dynamic agent goal surface', () => {
    const surface: BridgeUiSurface = {
      id: 'goal-agent-alpha:thread-1',
      threadId: 'agent-alpha:thread-1',
      turnId: null,
      kind: 'goal',
      presentation: 'workflowCard',
      tone: 'info',
      title: 'Goal',
      subtitle: 'Active',
      bodyMarkdown: 'Verify the mobile dynamic goal card.',
      blocks: [
        {
          type: 'keyValue',
          items: [
            { label: 'Status', value: 'Active' },
            { label: 'Tokens used', value: '42' },
          ],
        },
        {
          type: 'progress',
          label: 'Budget used',
          value: 4,
          max: 10,
          detail: '40% complete',
        },
      ],
      actions: [{ id: 'dismiss', label: 'Dismiss', style: 'secondary' }],
      dismissible: true,
    };
    const onAction = jest.fn<void, [BridgeUiSurface, BridgeUiAction]>();
    const onDismiss = jest.fn<void, [BridgeUiSurface]>();

    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        <AppThemeProvider theme={theme}>
          <BridgeUiWorkflowCard
            surface={surface}
            onAction={onAction}
            onDismiss={onDismiss}
          />
        </AppThemeProvider>
      );
    });

    const root = expectValue(rendered).root as QueryableTestInstance;
    expect(findText(root, 'Goal')).toBe(true);
    expect(findText(root, 'Active')).toBe(true);
    expect(findText(root, 'Verify the mobile dynamic goal card.')).toBe(true);
    expect(findText(root, 'Status')).toBe(true);
    expect(findText(root, 'Tokens used')).toBe(true);
    expect(findText(root, '42')).toBe(true);
    expect(findText(root, 'Budget used')).toBe(true);
    expect(findText(root, '40% complete')).toBe(true);

    const toggleButton = findPressableByLabel(root, 'Collapse surface');
    expect(toggleButton.props.accessibilityRole).toBe('button');
    expect(toggleButton.props.accessibilityState).toEqual({
      disabled: false,
      expanded: true,
    });
    act(() => {
      readOnPress(toggleButton.props)();
    });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(findText(root, 'Status')).toBe(false);
    expect(findText(root, 'Tokens used')).toBe(false);
    expect(findText(root, 'Budget used')).toBe(false);
    expect(findText(root, 'Dismiss')).toBe(false);

    act(() => {
      readOnPress(findPressableByLabel(root, 'Expand surface').props)();
    });
    expect(findPressableByLabel(root, 'Collapse surface').props.accessibilityState).toEqual({
      disabled: false,
      expanded: true,
    });
    expect(findText(root, 'Status')).toBe(true);

    act(() => {
      readOnPress(findPressableByText(root, 'Dismiss').props)();
    });
    expect(onAction).toHaveBeenCalledWith(surface, surface.actions[0]);
  });

  it('renders every block and action style in banner and modal presentations', () => {
    const surface: BridgeUiSurface = {
      id: 'review-1', threadId: 'thread-1', turnId: 'turn-1', kind: 'review',
      presentation: 'workflowCard', tone: 'warning', title: 'Review changes', subtitle: '3 checks',
      bodyMarkdown: '**Inspect** the proposed changes.',
      blocks: [
        { type: 'text', text: 'Plain detail' },
        { type: 'markdown', markdown: '`npm test`' },
        { type: 'checklist', items: [
          { label: 'Lint', status: 'completed', detail: 'Passed' },
          { label: 'Tests', status: 'inProgress' },
          { label: 'Deploy', status: 'pending' },
        ] },
        { type: 'keyValue', items: [{ label: 'Files', value: '4' }] },
        { type: 'code', language: 'sh', text: 'npm test' },
        { type: 'progress', label: 'Coverage', value: 4.5, max: 10, detail: '45%' },
      ],
      actions: [
        { id: 'accept', label: 'Accept', style: 'primary' },
        { id: 'later', label: 'Later', style: 'secondary' },
        { id: 'reject', label: 'Reject', style: 'destructive' },
      ],
      dismissible: true,
    };
    const onAction = jest.fn();
    const onDismiss = jest.fn();
    let rendered: ReactTestRenderer | undefined;
    act(() => { rendered = renderer.create(<AppThemeProvider theme={theme}><BridgeUiBanner surface={surface} onAction={onAction} onDismiss={onDismiss} /></AppThemeProvider>); });
    const tree = expectValue(rendered);
    const root = tree.root as QueryableTestInstance;
    for (const text of ['Plain detail', 'Lint', 'Passed', 'Tests', 'Deploy', 'Files', '4', 'sh', 'Coverage', '4.5 / 10', '45%']) {
      expect(findText(root, text)).toBe(true);
    }
    for (const action of surface.actions) {
      act(() => readOnPress(findPressableByText(root, action.label).props)());
      expect(onAction).toHaveBeenCalledWith(surface, action);
    }
    act(() => readOnPress(findPressableByLabel(root, 'Dismiss Review changes').props)());
    expect(onDismiss).toHaveBeenCalledWith(surface);

    act(() => { tree.update(<AppThemeProvider theme={theme}><BridgeUiModal surface={surface} onAction={onAction} onDismiss={onDismiss} /></AppThemeProvider>); });
    act(() => (tree.root.findByType(Modal).props.onRequestClose as () => void)());
    expect(onDismiss).toHaveBeenCalledTimes(2);
    act(() => tree.unmount());
  });

  it.each(['warning', 'error', 'success', 'info'] as const)('renders %s tone and clamps progress', (tone) => {
    const surface: BridgeUiSurface = {
      id: tone, threadId: 'thread', turnId: null, kind: 'status', presentation: 'banner', tone,
      title: `${tone} surface`, subtitle: null, bodyMarkdown: null,
      blocks: [{ type: 'progress', label: 'Range', value: tone === 'error' ? -4 : 40, max: 10 }],
      actions: [], dismissible: false,
    };
    let rendered: ReactTestRenderer | undefined;
    act(() => { rendered = renderer.create(<AppThemeProvider theme={theme}><BridgeUiBanner surface={surface} onAction={jest.fn()} onDismiss={jest.fn()} /></AppThemeProvider>); });
    const root = expectValue(rendered).root as QueryableTestInstance;
    expect(findText(root, `${tone} surface`)).toBe(true);
    expect(root.findAll((node) => node.props.accessibilityLabel === `Dismiss ${tone} surface`)).toHaveLength(0);
    act(() => expectValue(rendered).unmount());
  });

  it('renders empty details and ignores modal close when not dismissible', () => {
    const surface: BridgeUiSurface = {
      id: 'empty', threadId: 'thread', turnId: null, kind: 'status', presentation: 'modal', tone: 'info',
      title: 'Empty', subtitle: null, bodyMarkdown: null, blocks: [], actions: [], dismissible: false,
    };
    const onDismiss = jest.fn();
    let rendered: ReactTestRenderer | undefined;
    act(() => { rendered = renderer.create(<AppThemeProvider theme={theme}><BridgeUiModal surface={surface} onAction={jest.fn()} onDismiss={onDismiss} /></AppThemeProvider>); });
    const tree = expectValue(rendered);
    expect(findText(tree.root as QueryableTestInstance, 'No details provided.')).toBe(true);
    act(() => (tree.root.findByType(Modal).props.onRequestClose as () => void)());
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});

function findText(root: QueryableTestInstance, text: string): boolean {
  return root.findAll((node) => node.children.includes(text)).length > 0;
}

function findPressableByLabel(
  root: QueryableTestInstance,
  label: string
): QueryableTestInstance {
  const pressable = root.findAll(
    (node) =>
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityLabel === label
  )[0];
  if (!pressable) {
    throw new Error(`Unable to find pressable with label "${label}"`);
  }
  return pressable;
}

function findPressableByText(
  root: QueryableTestInstance,
  text: string
): QueryableTestInstance {
  const pressable = root.findAll(
    (node) => typeof node.props.onPress === 'function' && containsText(node, text)
  )[0];
  if (!pressable) {
    throw new Error(`Unable to find pressable with text "${text}"`);
  }
  return pressable;
}

function containsText(node: QueryableTestInstance, text: string): boolean {
  if (node.children.includes(text)) {
    return true;
  }
  return node.children.some(
    (child) =>
      typeof child === 'object' &&
      child !== null &&
      'children' in child &&
      containsText(child as QueryableTestInstance, text)
  );
}

function readOnPress(props: { onPress?: unknown }): () => void {
  if (typeof props.onPress !== 'function') {
    throw new Error('Expected onPress to be a function');
  }
  return props.onPress as () => void;
}

function expectValue<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('Expected value to be defined');
  }
  return value;
}
