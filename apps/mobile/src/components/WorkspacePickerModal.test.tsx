import { Modal, Text, TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import type { FileSystemEntry, WorkspaceSummary } from '../api/types';
import { AppThemeProvider, createAppTheme } from '../theme';
import {
  formatRelativeTime,
  getWorkspacePickerPresentation,
} from './workspacePickerHelpers';
import { WorkspacePickerModal } from './WorkspacePickerModal';
import type { WorkspacePickerModalProps } from './workspacePickerTypes';

type QueryableTestInstance = ReactTestInstance & {
  type: unknown;
  props: Record<string, unknown> & {
    onChangeText?: (value: string) => void;
    onPress?: () => void;
  };
  children: unknown[];
  findAll(predicate: (node: QueryableTestInstance) => boolean): QueryableTestInstance[];
  findAllByType(type: unknown): QueryableTestInstance[];
};

jest.mock('@expo/vector-icons', () => {
  const React = jest.requireActual('react');
  const { Text: NativeText } = jest.requireActual('react-native');

  return {
    Ionicons: ({ name }: { name: string }) =>
      React.createElement(NativeText, null, name),
  };
});

describe('WorkspacePickerModal', () => {
  const theme = createAppTheme('dark');
  const codePath = '/Users/davidparks/Code';
  const tetherCodePath = '/Users/davidparks/Code/TetherCode';
  const notesPath = '/Users/davidparks/Code/notes';

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('selects recent and default workspaces directly from the home screen', () => {
    const onSelectPath = jest.fn();
    const onClose = jest.fn();
    const tree = renderPicker({ onSelectPath, onClose });
    const root = tree.root as QueryableTestInstance;

    expect(flattenTreeText(root)).toContain('Choose Workspace');
    expect(flattenTreeText(root)).toContain('Recent');
    expect(flattenTreeText(root)).toContain('On this computer');
    expect(flattenTreeText(root)).not.toContain('Pinned');

    pressByLabel(root, 'Use Code workspace');
    expect(onSelectPath).toHaveBeenCalledWith(codePath);

    pressByLabel(root, 'Use default workspace');
    expect(onSelectPath).toHaveBeenCalledWith(null);

    const selected = findByLabel(root, 'Use TetherCode workspace');
    expect(selected.props.accessibilityState).toEqual({
      disabled: false,
      selected: true,
    });

    pressByLabel(root, 'Cancel workspace selection');
    expect(onClose).toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('pushes folder browsing and keeps navigation separate from selection', () => {
    const onBrowsePath = jest.fn();
    const onSelectPath = jest.fn();
    const tree = renderPicker({ onBrowsePath, onSelectPath });
    const root = tree.root as QueryableTestInstance;

    pressByLabel(root, 'Browse workspace folders');
    expect(findSearch(root).props.placeholder).toBe('Search this folder');
    expect(flattenTreeText(root)).toContain(`Choose "Code"`);

    pressByLabel(root, 'Open folder notes');
    expect(onBrowsePath).toHaveBeenCalledWith(notesPath);
    expect(onSelectPath).not.toHaveBeenCalled();

    act(() => {
      tree.update(
        pickerElement({
          onBrowsePath,
          onSelectPath,
          currentPath: notesPath,
          parentPath: codePath,
          entries: [],
        })
      );
    });

    expect(flattenTreeText(root)).toContain('No subfolders. You can choose this folder.');
    expect(findByLabel(root, 'Back to Code')).toBeDefined();
    pressByLabel(root, 'Choose notes workspace');
    expect(onSelectPath).toHaveBeenCalledWith(notesPath);

    pressByLabel(root, 'Back to Code');
    expect(onBrowsePath).toHaveBeenLastCalledWith(codePath);

    act(() => {
      tree.update(
        pickerElement({
          onBrowsePath,
          onSelectPath,
          currentPath: codePath,
          parentPath: '/Users/davidparks',
        })
      );
    });
    pressByLabel(root, 'Back to Workspaces');
    expect(flattenTreeText(root)).toContain('Choose Workspace');
    act(() => tree.unmount());
  });

  it('filters the current folder and clears search after navigation', () => {
    const onBrowsePath = jest.fn();
    const tree = renderPicker({ onBrowsePath });
    const root = tree.root as QueryableTestInstance;

    pressByLabel(root, 'Browse workspace folders');
    const search = findSearch(root);
    act(() => search.props.onChangeText?.('notes'));
    expect(flattenTreeText(root)).toContain('notes');
    expect(flattenTreeText(root)).not.toContain('TetherCodeGit repository');

    pressByLabel(root, 'Open folder notes');
    act(() => {
      tree.update(
        pickerElement({
          onBrowsePath,
          currentPath: notesPath,
          parentPath: codePath,
          entries: [],
        })
      );
    });
    expect(findSearch(root).props.value).toBe('');

    act(() => findSearch(root).props.onChangeText?.('missing'));
    expect(flattenTreeText(root)).toContain('No folders match this search.');
    act(() => tree.unmount());
  });

  it('renders browser loading, error, truncation, and empty states', () => {
    const tree = renderPicker({
      entries: [],
      loadingEntries: true,
      error: 'Bridge unavailable',
      truncationMessage: 'Showing the first 100 folders.',
    });
    const root = tree.root as QueryableTestInstance;

    pressByLabel(root, 'Browse workspace folders');
    expect(flattenTreeText(root)).toContain('Bridge unavailable');
    expect(flattenTreeText(root)).toContain('Showing the first 100 folders.');
    expect(
      root.findAll((node) => node.props.accessibilityLabel === 'Loading folders').length
    ).toBeGreaterThan(0);

    act(() => {
      tree.update(
        pickerElement({
          entries: [],
          loadingEntries: false,
          error: null,
          truncationMessage: null,
        })
      );
    });
    expect(flattenTreeText(root)).toContain('No subfolders. You can choose this folder.');
    act(() => tree.unmount());
  });

  it('keeps repository cloning as a plain home action', () => {
    const onActionPress = jest.fn();
    const tree = renderPicker({
      actionLabel: 'Clone Repository...',
      actionDescription: 'Choose a destination and start a session',
      onActionPress,
    });
    const root = tree.root as QueryableTestInstance;
    const action = findByLabel(root, 'Clone Repository...');

    expect(action.props.accessibilityHint).toBe(
      'Choose a destination and start a session'
    );
    press(action);
    expect(onActionPress).toHaveBeenCalledWith(tetherCodePath);

    act(() => {
      tree.update(
        pickerElement({
          actionLabel: 'Clone Repository...',
          actionDescription: 'Choose a destination and start a session',
          actionDisabled: true,
          onActionPress,
        })
      );
    });
    expect(findByLabel(root, 'Clone Repository...').props.accessibilityState).toEqual({
      disabled: true,
      selected: false,
    });
    act(() => tree.unmount());
  });

  it('resets pushed navigation and search after the modal is reopened', () => {
    const tree = renderPicker();
    const root = tree.root as QueryableTestInstance;
    pressByLabel(root, 'Browse workspace folders');
    act(() => findSearch(root).props.onChangeText?.('notes'));

    act(() => tree.update(pickerElement({ visible: false })));
    expect(root.findByType(Modal).props.visible).toBe(false);
    act(() => tree.update(pickerElement({ visible: true })));

    expect(flattenTreeText(root)).toContain('Choose Workspace');
    expect(root.findAllByType(TextInput)).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('exposes modal close behavior and selected accessibility state', () => {
    const onClose = jest.fn();
    const tree = renderPicker({ onClose });
    const root = tree.root as QueryableTestInstance;

    expect(
      root.findAll((node) => node.props.accessibilityViewIsModal === true).length
    ).toBeGreaterThan(0);
    expect(findByLabel(root, 'Close workspace picker')).toBeDefined();
    act(() => (root.findByType(Modal).props.onRequestClose as () => void)());
    expect(onClose).toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('deduplicates and caps recent workspaces', () => {
    const recentWorkspaces: WorkspaceSummary[] = [
      { path: '/work/one', chatCount: 1 },
      { path: '/work/one', chatCount: 2 },
      { path: '/work/two', chatCount: 2 },
      { path: '/work/three', chatCount: 3 },
      { path: '/work/four', chatCount: 4 },
      { path: '/work/five', chatCount: 5 },
      { path: '/work/six', chatCount: 6 },
      { path: '/work/seven', chatCount: 7 },
    ];
    const tree = renderPicker({ recentWorkspaces });
    const text = flattenTreeText(tree.root as QueryableTestInstance);
    const recentLabels = new Set(
      (tree.root as QueryableTestInstance)
        .findAll(
          (node) =>
            typeof node.props.accessibilityLabel === 'string' &&
            node.props.accessibilityLabel.startsWith('Use ') &&
            node.props.accessibilityLabel.endsWith(' workspace')
        )
        .map((node) => node.props.accessibilityLabel)
    );

    expect(recentLabels.has('Use one workspace')).toBe(true);
    expect(recentLabels.size).toBe(7);
    expect(text).toContain('six');
    expect(text).not.toContain('seven');
    act(() => tree.unmount());
  });

  it.each([
    ['2026-04-17T11:59:55.000Z', 'now'],
    ['2026-04-17T11:59:30.000Z', '30 sec ago'],
    ['2026-04-17T11:30:00.000Z', '30 min ago'],
    ['2026-04-17T07:00:00.000Z', '5 hr ago'],
    ['2026-04-16T12:00:00.000Z', '1 day ago'],
    ['2026-04-14T12:00:00.000Z', '3 days ago'],
    ['2026-04-03T12:00:00.000Z', '2 wk ago'],
    ['2026-02-17T12:00:00.000Z', '1 mo ago'],
  ])('formats recent workspace time %s as %s', (updatedAt, expected) => {
    jest.setSystemTime(new Date('2026-04-17T12:00:00.000Z'));
    expect(formatRelativeTime(updatedAt)).toBe(expected);
  });

  it('falls back to chat metadata when a recent timestamp is absent or invalid', () => {
    const tree = renderPicker({
      recentWorkspaces: [
        { path: '/work/one', chatCount: 1 },
        { path: '/work/two', chatCount: 2, updatedAt: 'invalid' },
      ],
    });
    const text = flattenTreeText(tree.root as QueryableTestInstance);
    expect(text).toContain('1 chat');
    expect(text).toContain('2 chats');
    act(() => tree.unmount());
  });

  it('adapts presentation to phones, landscape, and larger screens', () => {
    expect(
      getWorkspacePickerPresentation({
        width: 390,
        height: 844,
        topInset: 47,
        bottomInset: 34,
      })
    ).toEqual({
      isLargeScreen: false,
      horizontalPadding: 0,
      topPadding: 55,
      bottomPadding: 0,
      panelHeight: 789,
      panelMaxWidth: 390,
    });

    expect(
      getWorkspacePickerPresentation({
        width: 844,
        height: 390,
        topInset: 0,
        bottomInset: 21,
      })
    ).toEqual({
      isLargeScreen: false,
      horizontalPadding: 0,
      topPadding: 16,
      bottomPadding: 0,
      panelHeight: 374,
      panelMaxWidth: 844,
    });

    expect(
      getWorkspacePickerPresentation({
        width: 1024,
        height: 1366,
        topInset: 24,
        bottomInset: 20,
      })
    ).toEqual({
      isLargeScreen: true,
      horizontalPadding: 24,
      topPadding: 48,
      bottomPadding: 48,
      panelHeight: 820,
      panelMaxWidth: 640,
    });
  });

  it('uses optional defaults without exposing removed pin controls', () => {
    const tree = renderPicker({
      selectedPath: null,
      bridgeRoot: null,
      currentPath: null,
      parentPath: null,
      recentWorkspaces: [],
      entries: [],
    });
    const root = tree.root as QueryableTestInstance;
    expect(flattenTreeText(root)).toContain('Connected computer folders');
    expect(
      root.findAll((node) =>
        String(node.props.accessibilityLabel ?? '').toLowerCase().includes('pin')
      )
    ).toHaveLength(0);
    expect(findByLabel(root, 'Use default workspace').props.accessibilityState).toEqual({
      disabled: false,
      selected: true,
    });
    act(() => tree.unmount());
  });

  function renderPicker(overrides: Partial<WorkspacePickerModalProps> = {}) {
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = renderer.create(pickerElement(overrides));
    });
    return expectValue(rendered);
  }

  function pickerElement(overrides: Partial<WorkspacePickerModalProps> = {}) {
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
            selectedPath={tetherCodePath}
            bridgeRoot={codePath}
            recentWorkspaces={[
              { path: codePath, chatCount: 12 },
              { path: tetherCodePath, chatCount: 4 },
            ]}
            currentPath={codePath}
            parentPath="/Users/davidparks"
            entries={[
              directoryEntry('TetherCode', tetherCodePath, true),
              directoryEntry('notes', notesPath),
            ]}
            onBrowsePath={jest.fn()}
            onSelectPath={jest.fn()}
            onClose={jest.fn()}
            {...overrides}
          />
        </AppThemeProvider>
      </SafeAreaProvider>
    );
  }
});

function directoryEntry(
  name: string,
  path: string,
  isGitRepo = false
): FileSystemEntry {
  return {
    name,
    path,
    kind: 'directory',
    hidden: false,
    selectable: true,
    isGitRepo,
  };
}

function findSearch(root: QueryableTestInstance) {
  const search = root
    .findAllByType(TextInput)
    .find((node) => node.props.accessibilityLabel === 'Search this folder');
  if (!search) throw new Error('Expected folder search input');
  return search;
}

function findByLabel(root: QueryableTestInstance, label: string) {
  const matches = root.findAll((node) => node.props.accessibilityLabel === label);
  const match =
    matches.find((node) => node.props.accessibilityRole !== undefined) ?? matches[0];
  if (!match) throw new Error(`Expected element labeled "${label}"`);
  return match;
}

function pressByLabel(root: QueryableTestInstance, label: string) {
  press(findByLabel(root, label));
}

function press(node: QueryableTestInstance) {
  if (typeof node.props.onPress !== 'function') {
    throw new Error('Expected press handler');
  }
  act(() => node.props.onPress?.());
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

function expectValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected value to be set');
  return value;
}
