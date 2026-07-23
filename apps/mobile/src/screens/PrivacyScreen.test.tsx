import { Alert, Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '../theme';
import { PrivacyScreen } from './PrivacyScreen';

jest.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => name }));
jest.mock('expo-blur', () => ({ BlurView: 'mock-blur-view' }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'mock-linear-gradient' }));

type Queryable = Omit<ReactTestInstance, 'children' | 'findAll' | 'parent' | 'props'> & {
  children: unknown[];
  props: Record<string, unknown>;
  parent: Queryable | null;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

type PressCallback = () => void;

const theme = createAppTheme('dark');

function hasText(root: Queryable, text: string): boolean {
  return root.findAll((node) => node.children.map(String).join('').includes(text)).length > 0;
}

function findPressableByText(root: Queryable, text: string): Queryable {
  const textNode = root.findAll((node) => node.children.map(String).join('') === text)[0];
  let current: Queryable | null = textNode ?? null;
  while (current && typeof current.props.onPress !== 'function') current = current.parent as Queryable | null;
  if (!current) throw new Error(`Missing pressable: ${text}`);
  return current;
}

function findPressableAncestor(node: Queryable): Queryable {
  let current: Queryable | null = node;
  while (current && typeof current.props.onPress !== 'function') current = current.parent as Queryable | null;
  if (!current) throw new Error('Missing pressable ancestor');
  return current;
}

function getPressCallback(node: Queryable): PressCallback {
  const callback = node.props.onPress;
  if (typeof callback !== 'function') throw new Error('Expected onPress callback');
  return callback as PressCallback;
}

async function renderPrivacy(url: string | null, onOpenDrawer = jest.fn()): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
        <AppThemeProvider theme={theme}>
          <PrivacyScreen policyUrl={url} onOpenDrawer={onOpenDrawer} />
        </AppThemeProvider>
      </SafeAreaProvider>
    );
  });
  if (!tree) throw new Error('Expected privacy screen tree');
  return tree;
}

async function press(node: Queryable): Promise<void> {
  await act(async () => {
    getPressCallback(node)();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('PrivacyScreen behavior', () => {
  const button = 'Open privacy policy';
  const url = 'https://example.com/privacy';
  const missing = 'Not configured. Set EXPO_PUBLIC_PRIVACY_POLICY_URL.';
  const unsupported = 'The privacy policy URL is not supported on this device.';

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  it('renders configured and missing states, opens the drawer, and opens supported links', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const drawer = jest.fn();
    const configured = await renderPrivacy(url, drawer);
    const root = configured.root as Queryable;
    await press(findPressableByText(root, button));
    expect(Linking.canOpenURL).toHaveBeenCalledWith(url);
    expect(Linking.openURL).toHaveBeenCalledWith(url);
    const menuIcon = root.findAll((node) => node.children.includes('menu'))[0];
    await press(findPressableAncestor(menuIcon));
    expect(drawer).toHaveBeenCalled();
    act(() => configured.unmount());

    const absent = await renderPrivacy(null);
    expect(hasText(absent.root as Queryable, missing)).toBe(true);
    expect(findPressableByText(absent.root as Queryable, button).props.disabled).toBe(true);
    act(() => absent.unmount());
  });

  it('alerts for unsupported links and open failures', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValueOnce(false);
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const unsupportedTree = await renderPrivacy(url);
    await press(findPressableByText(unsupportedTree.root as Queryable, button));
    expect(Alert.alert).toHaveBeenCalledWith('Cannot open link', unsupported);
    expect(Linking.openURL).not.toHaveBeenCalled();
    act(() => unsupportedTree.unmount());

    jest.spyOn(Linking, 'canOpenURL').mockRejectedValueOnce(new Error('native failure'));
    const failedTree = await renderPrivacy(url);
    await press(findPressableByText(failedTree.root as Queryable, button));
    expect(Alert.alert).toHaveBeenCalledWith('Could not open link', 'Please open the policy URL manually.');
    act(() => failedTree.unmount());
  });

  it('shows and guards the in-flight opening state', async () => {
    let resolveSupported: ((supported: boolean) => void) | undefined;
    jest.spyOn(Linking, 'canOpenURL').mockImplementation(() => new Promise((resolve) => {
      resolveSupported = resolve;
    }));
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const tree = await renderPrivacy(url);
    const root = tree.root as Queryable;
    const buttonNode = findPressableByText(root, button);
    act(() => getPressCallback(buttonNode)());
    expect(hasText(root, 'Opening...')).toBe(true);
    expect(buttonNode.props.disabled).toBe(true);
    act(() => getPressCallback(buttonNode)());
    expect(Linking.canOpenURL).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSupported?.(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(Linking.openURL).toHaveBeenCalledWith(url);
    act(() => tree.unmount());
  });
});