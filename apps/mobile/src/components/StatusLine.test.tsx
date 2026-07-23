import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import type { RunEvent } from '../api/types';
import { AppThemeProvider, createAppTheme } from '../theme';
import { StatusLine } from './StatusLine';

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'View' },
  FadeInUp: { duration: () => undefined },
}));

type QueryableInstance = Omit<ReactTestInstance, 'props' | 'children'> & {
  props: Record<string, unknown>;
  children: Array<QueryableInstance | string>;
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

describe('StatusLine', () => {
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
});