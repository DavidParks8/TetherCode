import { TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '../../theme';
import { BridgeProfileManagerSheet } from '../bridge-profile-manager-sheet';
import { ChatInput } from '../ChatInput';

jest.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => name }));

type Queryable = ReactTestInstance & {
  children: unknown[];
  parent: Queryable | null;
  props: Record<string, unknown> & {
    onChangeText: jest.Mock;
    onFocus: jest.Mock;
    onLayout: jest.Mock;
    onPress: jest.Mock;
    onTextLayout: jest.Mock;
  };
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByType(type: unknown): Queryable[];
};
const theme = createAppTheme('dark');
const profiles = [
  { id: 'home', name: 'Home Mac', bridgeUrl: 'http://127.0.0.1:3030', bridgeToken: 'home-token', createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z' },
  { id: 'studio', name: 'Studio Mac', bridgeUrl: 'https://studio.test', bridgeToken: 'studio-token', createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z' },
];

function hasText(root: Queryable, text: string) {
  return root.findAll((node) => node.children.map(String).join('').includes(text)).length > 0;
}
function byLabel(root: Queryable, label: string) {
  const node = root.findAll((candidate) => candidate.props.accessibilityLabel === label)[0];
  if (!node) throw new Error(`Missing ${label}`);
  return node;
}
function actionableByLabel(root: Queryable, label: string) {
  const nodes = root.findAll((candidate) => candidate.props.accessibilityLabel === label && typeof candidate.props.onPress === 'function');
  const node = nodes[nodes.length - 1];
  if (!node) throw new Error(`Missing actionable ${label}`);
  return node;
}
function byTextPress(root: Queryable, text: string) {
  const textNode = root.findAll((node) => node.children.map(String).join('') === text)[0];
  let node: Queryable | null = textNode ?? null;
  while (node && typeof node.props.onPress !== 'function') node = node.parent;
  if (!node) throw new Error(`Missing pressable ${text}`);
  return node;
}
async function press(node: Queryable) {
  await act(async () => { (node.props.onPress as () => void)(); await Promise.resolve(); });
}
function wrap(child: React.ReactElement): React.ReactElement {
  return <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}><AppThemeProvider theme={theme}>{child}</AppThemeProvider></SafeAreaProvider>;
}

describe('BridgeProfileManagerSheet', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.runOnlyPendingTimers(); jest.useRealTimers(); });

  it('activates, renames, deletes, cancels, closes, and renders empty state', async () => {
    const onActivate = jest.fn().mockResolvedValue(undefined);
    const onRename = jest.fn().mockResolvedValue(undefined);
    const onDelete = jest.fn().mockResolvedValue(undefined);
    const onClose = jest.fn();
    let tree: ReactTestRenderer | undefined;
    act(() => { tree = renderer.create(wrap(<BridgeProfileManagerSheet visible profiles={profiles} activeProfileId="home" onClose={onClose} onActivate={onActivate} onRename={onRename} onDelete={onDelete} />)); });
    const rendered = tree as ReactTestRenderer;
    const root = rendered.root as Queryable;
    await press(byLabel(root, 'Use Studio Mac'));
    expect(onActivate).toHaveBeenCalledWith('studio');
    await press(byLabel(root, 'Rename Home Mac'));
    const input = byLabel(root, 'Connection name');
    act(() => input.props.onChangeText('Work Mac'));
    await press(byTextPress(root, 'Save name'));
    expect(onRename).toHaveBeenCalledWith('home', 'Work Mac');
    await press(byLabel(root, 'Delete Studio Mac'));
    expect(hasText(root, 'Delete this profile?')).toBe(true);
    await press(byTextPress(root, 'Keep profile'));
    await press(byLabel(root, 'Delete Studio Mac'));
    await press(actionableByLabel(root, 'Delete Studio Mac'));
    expect(onDelete).toHaveBeenCalledWith('studio');
    await press(byTextPress(root, 'Done'));
    expect(onClose).toHaveBeenCalled();
    act(() => rendered.update(wrap(<BridgeProfileManagerSheet visible profiles={[]} onClose={onClose} />)));
    expect(hasText(root, 'No saved connections')).toBe(true);
    act(() => rendered.unmount());
  });

  it.each(['activate failed', 'rename failed', 'delete failed'])('surfaces %s', async (message) => {
    const reject = jest.fn().mockRejectedValue(new Error(message));
    let tree: ReactTestRenderer | undefined;
    act(() => { tree = renderer.create(wrap(<BridgeProfileManagerSheet visible profiles={profiles} activeProfileId="home" onClose={jest.fn()} onActivate={message.startsWith('activate') ? reject : undefined} onRename={message.startsWith('rename') ? reject : undefined} onDelete={message.startsWith('delete') ? reject : undefined} />)); });
    const root = (tree as ReactTestRenderer).root as Queryable;
    if (message.startsWith('activate')) await press(byLabel(root, 'Use Studio Mac'));
    if (message.startsWith('rename')) { await press(byLabel(root, 'Rename Home Mac')); await press(byTextPress(root, 'Save name')); }
    if (message.startsWith('delete')) { await press(byLabel(root, 'Delete Studio Mac')); await press(actionableByLabel(root, 'Delete Studio Mac')); }
    expect(hasText(root, message)).toBe(true);
    act(() => (tree as ReactTestRenderer).unmount());
  });
});

describe('ChatInput behavior', () => {
  const base = { onChangeText: jest.fn(), onFocus: jest.fn(), onSubmit: jest.fn(), onStop: jest.fn(), onAttachPress: jest.fn(), onRemoveAttachment: jest.fn() };
  afterEach(() => jest.clearAllMocks());

  it('renders attachment, send, stop, loading, and disabled action states', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => { tree = renderer.create(wrap(<ChatInput {...base} value="Send this" isLoading={false} onAttachPress={base.onAttachPress} attachments={[{ id: 'a1', label: 'error.log' }]} />)); });
    const rendered = tree as ReactTestRenderer;
    const root = rendered.root as Queryable;
    act(() => byLabel(root, 'Message').props.onChangeText('changed'));
    act(() => byLabel(root, 'Message').props.onFocus());
    act(() => byLabel(root, 'Add attachment').props.onPress());
    act(() => byLabel(root, 'error.log, remove attachment').props.onPress());
    act(() => byLabel(root, 'Send message').props.onPress());
    expect(base.onChangeText).toHaveBeenCalledWith('changed');
    expect(base.onSubmit).toHaveBeenCalled();
    expect(base.onRemoveAttachment).toHaveBeenCalledWith('a1');

    act(() => rendered.update(wrap(<ChatInput {...base} value="" isLoading showStopButton onAttachPress={base.onAttachPress} />)));
    act(() => byLabel(root, 'Stop agent').props.onPress());
    expect(base.onStop).toHaveBeenCalled();
    act(() => rendered.update(wrap(<ChatInput {...base} value="" isLoading isStopping showStopButton onAttachPress={base.onAttachPress} attachDisabled />)));
    expect(byLabel(root, 'Stopping agent').props.disabled).toBe(true);
    expect(byLabel(root, 'Add attachment').props.disabled).toBe(true);
    act(() => rendered.update(wrap(<ChatInput {...base} value="" isLoading onAttachPress={base.onAttachPress} />)));
    expect(byLabel(root, 'Agent is responding').props.disabled).toBe(true);
    act(() => rendered.unmount());
  });

  it('measures single and multiline composer height and renders footer reserves', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => { tree = renderer.create(wrap(<ChatInput {...base} value="line" isLoading={false} onAttachPress={base.onAttachPress} footer={<></>} reserveFooterSpace />)); });
    const rendered = tree as ReactTestRenderer;
    const root = rendered.root as Queryable;
    const input = root.findAllByType(TextInput).find((node) => node.props.accessibilityLabel === 'Message');
    if (!input) throw new Error('Missing message input');
    act(() => input.props.onLayout({ nativeEvent: { layout: { width: 240 } } }));
    const measure = root.findAll((node) => typeof node.props.onTextLayout === 'function')[0];
    act(() => measure.props.onTextLayout({ nativeEvent: { lines: [{}, {}, {}, {}, {}, {}] } }));
    expect(root.findAllByType(TextInput).find((node) => node.props.accessibilityLabel === 'Message')?.props.scrollEnabled).toBe(true);
    act(() => rendered.update(wrap(<ChatInput {...base} value="" isLoading={false} onAttachPress={base.onAttachPress} reserveFooterSpace />)));
    act(() => rendered.unmount());
  });
});