import React from 'react';
import { Modal } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '../theme';
import { SelectionSheet, type SelectionSheetOption } from './SelectionSheet';

jest.mock('@expo/vector-icons', () => {
  const mockReact = jest.requireActual('react');
  const { Text: MockText } = jest.requireActual('react-native');
  return {
    Ionicons: ({ name }: { name: string }) => mockReact.createElement(MockText, null, name),
  };
});

type QueryableInstance = Omit<ReactTestInstance, 'props' | 'children' | 'findAll'> & {
  type: unknown;
  props: Record<string, unknown>;
  children: Array<QueryableInstance | string>;
  findAll(predicate: (node: QueryableInstance) => boolean): QueryableInstance[];
  findByType(type: React.ElementType): QueryableInstance;
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

describe('SelectionSheet', () => {
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