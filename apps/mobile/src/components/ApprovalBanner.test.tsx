import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import type { PendingApproval } from '../api/types';
import { AppThemeProvider, createAppTheme } from '../theme';
import { ApprovalBanner, runApprovalResolution } from './ApprovalBanner';

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'View' },
  FadeInDown: { duration: () => undefined },
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

describe('ApprovalBanner', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('returns an awaitable resolution and restores controls after failure', async () => {
    const setResolving = jest.fn();
    const resolve = jest.fn().mockRejectedValue(new Error('temporary failure'));

    await expect(
      runApprovalResolution('approval-1', 'accept', resolve, setResolving)
    ).rejects.toThrow('temporary failure');
    expect(setResolving.mock.calls).toEqual([['accept'], [null]]);
  });

  it('resolves command and file approvals across pending, reject, and retry states', async () => {
    let finishResolution: (() => void) | undefined;
    const onResolve = jest.fn(
      () => new Promise<void>((resolve) => {
        finishResolution = resolve;
      })
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
});