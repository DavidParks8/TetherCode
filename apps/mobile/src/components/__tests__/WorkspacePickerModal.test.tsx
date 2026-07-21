import { ActionSheetIOS, Modal, Text, TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import type { FileSystemEntry } from '../../api/types';
import { createAppTheme, AppThemeProvider } from '../../theme';
import { WorkspacePickerModal } from '../WorkspacePickerModal';

type QueryableTestInstance = ReactTestInstance & {
  type: unknown;
  props: Record<string, unknown> & {
    onChangeText: jest.Mock;
    onLongPress: jest.Mock;
    onPress: jest.Mock;
  };
  children: unknown[];
  findAll(predicate: (node: QueryableTestInstance) => boolean): QueryableTestInstance[];
  findAllByType(type: unknown): QueryableTestInstance[];
};

jest.mock('@expo/vector-icons', () => {
  const React = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');

  return {
    Ionicons: ({ name }: { name: string }) => React.createElement(Text, null, name),
  };
});

describe('WorkspacePickerModal', () => {
  const theme = createAppTheme('dark');
  const oldSelectionPath =
    '/Users/davidparks/Documents/github/serious-projects/tethercode';
  const githubPath = '/Users/davidparks/Documents/github';
  const seriousProjectsPath = '/Users/davidparks/Documents/github/serious-projects';

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('keeps a browsed checkout destination when currentPath refreshes', () => {
    const onBrowsePath = jest.fn();
    const onSelectPath = jest.fn();

    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        renderPicker({
          onBrowsePath,
          onSelectPath,
          currentPath: githubPath,
          parentPath: '/Users/davidparks/Documents',
          entries: [directoryEntry('serious-projects', seriousProjectsPath)],
        })
      );
    });

    const tree = expectValue(rendered);
    act(() => {
      readOnPress(findPressableContainingText(tree.root, 'serious-projects').props)();
    });

    expect(onBrowsePath).toHaveBeenCalledWith(seriousProjectsPath);

    act(() => {
      tree.update(
        renderPicker({
          onBrowsePath,
          onSelectPath,
          currentPath: seriousProjectsPath,
          parentPath: githubPath,
          entries: [directoryEntry('tethercode', oldSelectionPath)],
        })
      );
    });

    act(() => {
      readOnPress(findPressableWithExactText(tree.root, 'Use').props)();
    });

    expect(onSelectPath).toHaveBeenCalledWith(seriousProjectsPath);
    expect(onSelectPath).not.toHaveBeenCalledWith(oldSelectionPath);

    act(() => {
      tree.unmount();
    });
  });

  it('exposes modal, selected, and disabled workspace controls', () => {
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        renderPicker({
          onBrowsePath: jest.fn(),
          onSelectPath: jest.fn(),
          currentPath: githubPath,
          parentPath: githubPath,
          entries: [directoryEntry('serious-projects', seriousProjectsPath)],
        })
      );
    });

    const root = expectValue(rendered).root as QueryableTestInstance;
    expect(root.findAll((node) => node.props.accessibilityViewIsModal === true).length)
      .toBeGreaterThan(0);
    expect(root.findAll((node) => node.props.accessibilityLabel === 'Close workspace picker').length)
      .toBeGreaterThan(0);
    expect(
      root.findAll((node) => node.props.accessibilityLabel === 'Use default workspace')[0]?.props
        .accessibilityState
    ).toEqual({ disabled: false, selected: false });
    act(() => {
      expectValue(rendered).unmount();
    });
  });

  it('browses, searches, selects, pins, uses default, and closes populated workspaces', () => {
    const onBrowsePath = jest.fn();
    const onSelectPath = jest.fn();
    const onToggleFavorite = jest.fn();
    const onClose = jest.fn();
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(renderPickerMatrix({ onBrowsePath, onSelectPath, onToggleFavorite, onClose }));
    });
    const tree = expectValue(rendered);
    const root = tree.root as QueryableTestInstance;
    act(() => readOnPress(findPressableContainingText(root, 'notes').props)());
    expect(onBrowsePath).toHaveBeenCalledWith('/Users/davidparks/Code/notes');
    const parent = root.findAll((node) => node.props.accessibilityLabel === 'Go to parent folder')[0];
    act(() => readOnPress(parent.props)());
    expect(onBrowsePath).toHaveBeenCalledWith('/Users/davidparks');
    const search = root.findAllByType(TextInput).find((node) => node.props.accessibilityLabel === 'Search folders');
    if (!search) throw new Error('Missing search');
    act(() => search.props.onChangeText('missing'));
    expect(flattenTreeText(root)).toContain('No folders match this search.');
    act(() => search.props.onChangeText(''));
    act(() => readOnPress(findPressableWithExactText(root, 'Use').props)());
    expect(onSelectPath).toHaveBeenCalledWith('/Users/davidparks');
    const unpin = root.findAll((node) => node.props.accessibilityLabel === 'Pin davidparks')[0];
    act(() => readOnPress(unpin.props)());
    expect(onToggleFavorite).toHaveBeenCalledWith('/Users/davidparks');
    act(() => readOnPress(root.findAll((node) => node.props.accessibilityLabel === 'Use default workspace')[0].props)());
    expect(onSelectPath).toHaveBeenCalledWith(null);
    act(() => readOnPress(root.findAll((node) => node.props.accessibilityLabel === 'Close workspace picker')[0].props)());
    expect(onClose).toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('renders loading, errors, truncation, empty folders, and custom action states', () => {
    const onActionPress = jest.fn();
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(renderPickerMatrix({
        entries: [], loadingEntries: true, error: 'Bridge unavailable',
        truncationMessage: 'Showing the first 100 folders.', actionLabel: 'Clone here', onActionPress,
      }));
    });
    const tree = expectValue(rendered);
    const root = tree.root as QueryableTestInstance;
    expect(flattenTreeText(root)).toContain('Bridge unavailable');
    expect(flattenTreeText(root)).toContain('Showing the first 100 folders.');
    expect(root.findAll((node) => node.props.accessibilityLabel === 'Loading folders...').length).toBeGreaterThan(0);
    act(() => readOnPress(root.findAll((node) => node.props.accessibilityLabel === 'Clone here')[0].props)());
    expect(onActionPress).toHaveBeenCalled();
    act(() => tree.update(renderPickerMatrix({ entries: [], loadingEntries: false })));
    expect(flattenTreeText(root)).toContain('No folders found here.');
    act(() => tree.unmount());
  });

  it('resets search and pending selection across visibility and selected-path changes', () => {
    const onSelectPath = jest.fn();
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(renderPickerMatrix({ onSelectPath }));
    });
    const tree = expectValue(rendered);
    const root = tree.root as QueryableTestInstance;
    const search = root.findAllByType(TextInput)[0];
    act(() => search.props.onChangeText('notes'));
    expect(root.findAllByType(TextInput)[0].props.value).toBe('notes');

    act(() => tree.update(renderPickerMatrix({ visible: false, selectedPath: null, currentPath: null, bridgeRoot: null, parentPath: null, entries: [], onSelectPath })));
    expect(tree.root.findByType(Modal).props.visible).toBe(false);
    act(() => tree.update(renderPickerMatrix({ visible: true, selectedPath: null, currentPath: null, bridgeRoot: null, parentPath: null, entries: [], onSelectPath })));
    expect(root.findAllByType(TextInput)[0].props.value).toBe('');
    expect(flattenTreeText(root)).toContain('Default workspace');
    const use = root.findAll((node) => node.props.accessibilityLabel === 'Use Default workspace workspace')[0];
    const pin = root.findAll((node) => node.props.accessibilityLabel === 'Pin Default workspace')[0];
    expect(use.props.accessibilityState).toEqual({ disabled: true });
    expect(pin.props.accessibilityState).toEqual({ disabled: true, selected: false });

    act(() => tree.update(renderPickerMatrix({ selectedPath: '/Users/davidparks/Code/next', onSelectPath })));
    expect(flattenTreeText(root)).toContain('next');
    act(() => tree.unmount());
  });

  it('preserves a browsed pending path when the external selection changes', () => {
    const onBrowsePath = jest.fn();
    let rendered: ReactTestRenderer | undefined;
    act(() => { rendered = renderer.create(renderPickerMatrix({ onBrowsePath })); });
    const tree = expectValue(rendered);
    act(() => readOnPress(findPressableContainingText(tree.root, 'notes').props)());
    act(() => tree.update(renderPickerMatrix({ onBrowsePath, selectedPath: '/Users/davidparks/Code/other' })));
    expect(flattenTreeText(tree.root as QueryableTestInstance)).toContain('/Users/davidparks/Code/notes');
    act(() => tree.unmount());
  });

  it('exposes disabled loading and action controls without invoking callbacks', () => {
    const onBrowsePath = jest.fn();
    const onActionPress = jest.fn();
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(renderPickerMatrix({
        entries: [], loadingEntries: true, parentPath: '/Users/davidparks',
        actionLabel: 'Clone here', actionDisabled: true, onActionPress, onBrowsePath,
      }));
    });
    const root = expectValue(rendered).root as QueryableTestInstance;
    const up = root.findAll((node) => node.props.accessibilityLabel === 'Go to parent folder')[0];
    const action = root.findAll((node) => node.props.accessibilityLabel === 'Clone here')[0];
    expect(up.props.accessibilityState).toEqual({ disabled: true });
    expect(action.props.accessibilityState).toEqual({ disabled: true });
    expect(action.props.accessibilityHint).toBe('Clones a repository into this folder');
    expect(onBrowsePath).not.toHaveBeenCalled();
    expect(onActionPress).not.toHaveBeenCalled();
    act(() => expectValue(rendered).unmount());
  });

  it('confirms pinned and unpinned workspaces through long-press actions', () => {
    const onToggleFavorite = jest.fn();
    const actionSheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(0));
    let rendered: ReactTestRenderer | undefined;
    act(() => { rendered = renderer.create(renderPickerMatrix({ onToggleFavorite })); });
    const root = expectValue(rendered).root as QueryableTestInstance;
    const pinnedTile = root.findAll((node) => node.props.accessibilityLabel === 'Code, 12 chats')[0];
    const notesRow = root.findAll((node) => node.props.accessibilityLabel === 'Open folder notes')[0];
    act(() => {
      pinnedTile.props.onLongPress();
      notesRow.props.onLongPress();
    });
    expect(actionSheet.mock.calls[0]?.[0]).toMatchObject({ options: ['Unpin workspace', 'Cancel'], title: 'Unpin this workspace?' });
    expect(actionSheet.mock.calls[1]?.[0]).toMatchObject({ options: ['Pin workspace', 'Cancel'], title: 'Pin this workspace?' });
    expect(onToggleFavorite).toHaveBeenCalledWith('/Users/davidparks/Code');
    expect(onToggleFavorite).toHaveBeenCalledWith('/Users/davidparks/Code/notes');
    actionSheet.mockRestore();
    act(() => expectValue(rendered).unmount());
  });

  it('filters pinned workspaces and renders recent metadata variants', () => {
    jest.setSystemTime(new Date('2026-04-17T12:00:00.000Z'));
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(renderPickerMatrix({
        favoriteWorkspacePaths: ['/work/one', '/work/missing'],
        recentWorkspaces: [
          { path: '/work/one', chatCount: 1, updatedAt: '2026-04-17T11:59:55.000Z' },
          { path: '/work/two', chatCount: 2, updatedAt: 'invalid' },
        ],
      }));
    });
    const root = expectValue(rendered).root as QueryableTestInstance;
    expect(flattenTreeText(root)).toContain('now');
    expect(flattenTreeText(root)).toContain('0 chats');
    const search = root.findAllByType(TextInput)[0];
    act(() => search.props.onChangeText('does-not-match'));
    expect(flattenTreeText(root)).not.toContain('Pinned');
    act(() => expectValue(rendered).unmount());
  });

  it.each([
    ['2026-04-17T11:59:30.000Z', '30 sec ago'],
    ['2026-04-17T11:30:00.000Z', '30 min ago'],
    ['2026-04-17T07:00:00.000Z', '5 hr ago'],
    ['2026-04-16T12:00:00.000Z', '1 day ago'],
    ['2026-04-14T12:00:00.000Z', '3 days ago'],
    ['2026-04-03T12:00:00.000Z', '2 wk ago'],
    ['2026-02-17T12:00:00.000Z', '1 mo ago'],
  ])('renders recent workspace time %s as %s', (updatedAt, expected) => {
    jest.setSystemTime(new Date('2026-04-17T12:00:00.000Z'));
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(renderPickerMatrix({
        favoriteWorkspacePaths: ['/work/time'],
        recentWorkspaces: [{ path: '/work/time', chatCount: 4, updatedAt }],
      }));
    });
    expect(flattenTreeText(expectValue(rendered).root as QueryableTestInstance)).toContain(expected);
    act(() => expectValue(rendered).unmount());
  });

  it('renders singular chat metadata, custom action copy, and modal request close', () => {
    const onClose = jest.fn();
    const onActionPress = jest.fn();
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(renderPickerMatrix({
        favoriteWorkspacePaths: ['/work/one'],
        recentWorkspaces: [{ path: '/work/one', chatCount: 1 }],
        actionLabel: 'Clone here', actionDescription: 'Create a checkout here',
        onActionPress, onClose,
      }));
    });
    const root = expectValue(rendered).root as QueryableTestInstance;
    expect(flattenTreeText(root)).toContain('1 chat');
    const action = root.findAll((node) => node.props.accessibilityLabel === 'Clone here')[0];
    expect(action.props.accessibilityHint).toBe('Create a checkout here');
    act(() => readOnPress(action.props)());
    expect(onActionPress).toHaveBeenCalledWith('/Users/davidparks/Code/tethercode');
    act(() => (root.findByType(Modal).props.onRequestClose as () => void)());
    expect(onClose).toHaveBeenCalled();
    act(() => expectValue(rendered).unmount());
  });

  it('uses omitted optional defaults and exposes disabled favorite state', () => {
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
          <AppThemeProvider theme={theme}>
            <WorkspacePickerModal visible={false} recentWorkspaces={[]} entries={[]} onBrowsePath={jest.fn()} onSelectPath={jest.fn()} onClose={jest.fn()} />
          </AppThemeProvider>
        </SafeAreaProvider>
      );
    });
    const root = expectValue(rendered).root as QueryableTestInstance;
    expect(root.findByType(Modal).props.visible).toBe(false);
    act(() => {
      expectValue(rendered).update(
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
          <AppThemeProvider theme={theme}>
            <WorkspacePickerModal visible recentWorkspaces={[]} entries={[]} onBrowsePath={jest.fn()} onSelectPath={jest.fn()} onClose={jest.fn()} />
          </AppThemeProvider>
        </SafeAreaProvider>
      );
    });
    expect(root.findAll((node) => node.props.accessibilityLabel === 'Pin Default workspace')[0].props.accessibilityState).toEqual({ disabled: true, selected: false });
    act(() => expectValue(rendered).unmount());
  });

  function renderPickerMatrix(overrides: Record<string, unknown>) {
    return (
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
        <AppThemeProvider theme={theme}>
          <WorkspacePickerModal
            visible
            selectedPath="/Users/davidparks/Code/tethercode"
            bridgeRoot="/Users/davidparks/Code"
            recentWorkspaces={[{ path: '/Users/davidparks/Code', chatCount: 12 }]}
            favoriteWorkspacePaths={['/Users/davidparks/Code']}
            currentPath="/Users/davidparks/Code"
            parentPath="/Users/davidparks"
            entries={[directoryEntry('tethercode', '/Users/davidparks/Code/tethercode'), directoryEntry('notes', '/Users/davidparks/Code/notes')]}
            onBrowsePath={jest.fn()}
            onSelectPath={jest.fn()}
            onClose={jest.fn()}
            {...overrides}
          />
        </AppThemeProvider>
      </SafeAreaProvider>
    );
  }

  function renderPicker({
    onBrowsePath,
    onSelectPath,
    currentPath,
    parentPath,
    entries,
  }: {
    onBrowsePath: (path: string | null) => void;
    onSelectPath: (path: string | null) => void;
    currentPath: string;
    parentPath: string;
    entries: FileSystemEntry[];
  }) {
    return (
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 },
        }}
      >
        <AppThemeProvider theme={theme}>
          <WorkspacePickerModal
            visible
            selectedPath={oldSelectionPath}
            bridgeRoot={oldSelectionPath}
            recentWorkspaces={[]}
            currentPath={currentPath}
            parentPath={parentPath}
            entries={entries}
            onBrowsePath={onBrowsePath}
            onSelectPath={onSelectPath}
            onClose={jest.fn()}
          />
        </AppThemeProvider>
      </SafeAreaProvider>
    );
  }
});

function directoryEntry(name: string, path: string): FileSystemEntry {
  return {
    name,
    path,
    kind: 'directory',
    hidden: false,
    selectable: true,
    isGitRepo: false,
  };
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

function findPressableContainingText(
  root: ReactTestInstance,
  expectedText: string
): ReactTestInstance {
  const matches = (root as QueryableTestInstance).findAll(
    (node: QueryableTestInstance) =>
      typeof node.props.onPress === 'function' &&
      flattenTreeText(node).includes(expectedText)
  );
  if (matches.length === 0) {
    throw new Error(`Expected press target containing "${expectedText}"`);
  }
  return matches[0];
}

function findPressableWithExactText(
  root: ReactTestInstance,
  expectedText: string
): ReactTestInstance {
  const matches = (root as QueryableTestInstance).findAll(
    (node: QueryableTestInstance) =>
      typeof node.props.onPress === 'function' &&
      flattenTreeText(node) === expectedText
  );
  if (matches.length === 0) {
    throw new Error(`Expected press target with text "${expectedText}"`);
  }
  return matches[0];
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

function flattenTreeText(node: QueryableTestInstance): string {
  if (node.type === Text) {
    return flattenRenderedText(node.props.children);
  }

  return node.children
    .map((child) =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : flattenTreeText(child as QueryableTestInstance)
    )
    .join('');
}
