import React from 'react';
import { ScrollView } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '../theme';
import { ToolBlock } from './ToolBlock';

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

function invokeProp(node: QueryableInstance, name: string, ...args: unknown[]): unknown {
  const callback = node.props[name];
  if (typeof callback !== 'function') throw new Error(`Missing callback: ${name}`);
  return callback(...args);
}

function findType(root: QueryableInstance, type: unknown): QueryableInstance {
  return root.findByType(type as React.ElementType) as QueryableInstance;
}

describe('ToolBlock', () => {
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
});