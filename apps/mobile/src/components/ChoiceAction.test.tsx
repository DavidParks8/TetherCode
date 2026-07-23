import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '../theme';
import { ChoiceAction } from './ChoiceAction';

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

function invokeStyle(node: QueryableInstance, pressed: boolean): unknown {
  const style = node.props.style;
  return typeof style === 'function' ? style({ pressed }) : style;
}

function invokeProp(node: QueryableInstance, name: string, ...args: unknown[]): unknown {
  const callback = node.props[name];
  if (typeof callback !== 'function') throw new Error(`Missing callback: ${name}`);
  return callback(...args);
}

describe('ChoiceAction', () => {
  it('renders and presses every ChoiceAction presentation', () => {
    const onPress = jest.fn();
    const tree = render(
      <>
        <ChoiceAction title="Primary" meta="Ready" variant="primary" logo="github" onPress={onPress} />
        <ChoiceAction title="Brand" logo="tethercode" onPress={onPress} />
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
});