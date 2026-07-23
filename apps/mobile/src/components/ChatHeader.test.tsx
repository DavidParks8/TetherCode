import React from 'react';
import { ScrollView } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '../theme';
import { ChatHeader } from './ChatHeader';

jest.mock('@expo/vector-icons', () => {
  const mockReact = jest.requireActual('react');
  const { Text: MockText } = jest.requireActual('react-native');
  return {
    Ionicons: ({ name }: { name: string }) => mockReact.createElement(MockText, null, name),
  };
});

jest.mock('expo-linear-gradient', () => ({
  LinearGradient: 'LinearGradient',
}));

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

describe('ChatHeader', () => {
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
});