import * as Clipboard from 'expo-clipboard';
import { Modal, Platform, Share } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppThemeProvider, createAppTheme } from '../../theme';
import { OnboardingScreen, type OnboardingMode } from '../OnboardingScreen';

const mockRequestCameraPermission = jest.fn().mockResolvedValue({ granted: false });
const mockWsRequest = jest.fn().mockResolvedValue({ status: 'ok' });
const mockWsDisconnect = jest.fn();
let mockCameraGranted = false;

jest.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => name }));
jest.mock('expo-blur', () => ({ BlurView: jest.requireActual('react-native').View }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: jest.requireActual('react-native').View }));
jest.mock('expo-camera', () => ({
  CameraView: (props: Record<string, unknown>) => jest.requireActual('react').createElement('mock-camera-view', props),
  useCameraPermissions: () => [{ granted: mockCameraGranted }, mockRequestCameraPermission],
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../api/ws', () => ({
  HostBridgeWsClient: class {
    request = mockWsRequest;
    disconnect = mockWsDisconnect;
  },
}));

type Queryable = ReactTestInstance & {
  children: unknown[];
  parent: Queryable | null;
  type: unknown;
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

type PropHandler = (...args: never[]) => unknown;

function readHandler<Handler extends PropHandler>(node: Queryable, property: string): Handler {
  const handler = node.props[property];
  if (typeof handler !== 'function') throw new Error(`Missing handler: ${property}`);
  return handler as Handler;
}

const theme = createAppTheme('dark');
const lightTheme = createAppTheme('light');

function hasText(root: Queryable, text: string): boolean {
  return root.findAll((node) => node.children.map(String).join('').includes(text)).length > 0;
}

function findByLabel(root: Queryable, label: string): Queryable {
  const node = root.findAll((candidate) => candidate.props.accessibilityLabel === label)[0];
  if (!node) throw new Error(`Missing label: ${label}`);
  return node;
}

function findPressableByText(root: Queryable, text: string): Queryable {
  const textNode = root.findAll((node) => node.children.map(String).join('') === text)[0];
  let current: Queryable | null = textNode ?? null;
  while (current && typeof current.props.onPress !== 'function') current = current.parent;
  if (!current) throw new Error(`Missing pressable: ${text}`);
  return current;
}

async function press(node: Queryable): Promise<void> {
  await act(async () => {
    readHandler<() => void>(node, 'onPress')();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderOnboarding(options: {
  mode?: OnboardingMode;
  initialBridgeUrl?: string | null;
  initialBridgeToken?: string | null;
  onSave?: jest.Mock;
  onCancel?: jest.Mock;
  allowInsecureRemoteBridge?: boolean;
  allowQueryTokenAuth?: boolean;
  themeMode?: 'dark' | 'light';
} = {}): Promise<{ tree: ReactTestRenderer; onSave: jest.Mock; onCancel: jest.Mock; rerender: (next: typeof options) => Promise<void> }> {
  const onSave = options.onSave ?? jest.fn().mockResolvedValue(undefined);
  const onCancel = options.onCancel ?? jest.fn();
  const createElement = (props: typeof options) => (
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
      <AppThemeProvider theme={props.themeMode === 'light' ? lightTheme : theme}>
        <OnboardingScreen
          mode={props.mode}
          initialBridgeUrl={props.initialBridgeUrl}
          initialBridgeToken={props.initialBridgeToken}
          allowInsecureRemoteBridge={props.allowInsecureRemoteBridge}
          allowQueryTokenAuth={props.allowQueryTokenAuth}
          onSave={props.onSave ?? onSave}
          onCancel={props.onCancel ?? onCancel}
        />
      </AppThemeProvider>
    </SafeAreaProvider>
  );
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(createElement(options));
    await Promise.resolve();
  });
  if (!tree) throw new Error('Expected onboarding tree');
  const renderedTree = tree;
  return {
    tree: renderedTree,
    onSave,
    onCancel,
    rerender: async (next) => {
      await act(async () => {
        renderedTree.update(createElement({ ...options, ...next }));
        await Promise.resolve();
      });
    },
  };
}

describe('OnboardingScreen behavior', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockCameraGranted = false;
    global.fetch = jest.fn().mockResolvedValue({ status: 200 }) as jest.Mock;
    mockWsRequest.mockResolvedValue({ status: 'ok' });
    jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('moves between initial intro and connection setup', async () => {
    const { tree } = await renderOnboarding();
    const root = tree.root as Queryable;
    expect(hasText(root, 'Clawdex')).toBe(true);
    expect(hasText(root, 'Pair your phone with your own machine.')).toBe(true);
    await press(findPressableByText(root, 'Private connection'));
    expect(findByLabel(root, 'Bridge URL')).toBeTruthy();
    expect(hasText(root, '1. Start')).toBe(true);
    await press(findPressableByText(root, 'Back'));
    expect(hasText(root, 'Private connection')).toBe(true);
    act(() => tree.unmount());
  });

  it.each([
    { mode: 'add' as const, label: 'Continue' },
    { mode: 'edit' as const, label: 'Save URL' },
    { mode: 'reconnect' as const, label: 'Reconnect' },
  ])('renders direct connection mode controls', async ({ mode, label }) => {
    const result = await renderOnboarding({ mode, initialBridgeUrl: 'http://127.0.0.1:3001', initialBridgeToken: 'token' });
    const root = result.tree.root as Queryable;
    expect(findByLabel(root, label)).toBeTruthy();
    await press(findByLabel(root, 'Cancel connection setup'));
    expect(result.onCancel).toHaveBeenCalled();
    await press(findByLabel(root, 'Show bridge token'));
    expect(findByLabel(root, 'Bridge token').props.secureTextEntry).toBe(false);
    await press(findByLabel(root, 'Hide bridge token'));
    expect(findByLabel(root, 'Bridge token').props.secureTextEntry).toBe(true);
    act(() => result.tree.unmount());
  });

  it('validates URL and token before probing', async () => {
    const { tree, onSave } = await renderOnboarding({ mode: 'add' });
    const root = tree.root as Queryable;
    await press(findByLabel(root, 'Continue'));
    expect(hasText(root, 'Enter a valid URL.')).toBe(true);
    const url = findByLabel(root, 'Bridge URL');
    const token = findByLabel(root, 'Bridge token');
    act(() => readHandler<(value: string) => void>(url, 'onChangeText')('http://127.0.0.1:3001'));
    await press(findByLabel(root, 'Continue'));
    expect(hasText(root, 'Connection token is required.')).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    await press(findPressableByText(root, 'Test Connection'));
    expect(hasText(root, 'Enter a valid URL.')).toBe(false);
    expect(hasText(root, 'Connection token is required.')).toBe(true);
    act(() => readHandler<(value: string) => void>(token, 'onChangeText')('token'));
    act(() => tree.unmount());
  });

  it('probes and saves normalized credentials', async () => {
    const result = await renderOnboarding({
      mode: 'edit',
      initialBridgeUrl: ' ws://127.0.0.1:3001/path/ ',
      initialBridgeToken: ' token ',
    });
    const root = result.tree.root as Queryable;
    await press(findByLabel(root, 'Save URL'));
    expect(global.fetch).toHaveBeenCalledWith('http://127.0.0.1:3001/path/health', expect.objectContaining({
      headers: { Authorization: 'Bearer token' },
    }));
    expect(mockWsRequest).toHaveBeenCalledWith('bridge/health/read');
    expect(mockWsDisconnect).toHaveBeenCalled();
    expect(result.onSave).toHaveBeenCalledWith({ bridgeUrl: 'http://127.0.0.1:3001/path', bridgeToken: 'token' });
    expect(hasText(root, 'Connected. URL and token both verified.')).toBe(true);
    act(() => result.tree.unmount());
  });

  it('reports partial health, RPC failure, save failure, and insecure remote warnings', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ status: 503 });
    const partial = await renderOnboarding({ mode: 'add', initialBridgeUrl: 'http://127.0.0.1:3001', initialBridgeToken: 'token' });
    await press(findPressableByText(partial.tree.root as Queryable, 'Test Connection'));
    expect(hasText(partial.tree.root as Queryable, 'Authenticated RPC verified')).toBe(true);
    act(() => partial.tree.unmount());

    mockWsRequest.mockRejectedValueOnce(new Error('offline'));
    const failed = await renderOnboarding({ mode: 'add', initialBridgeUrl: 'http://127.0.0.1:3001', initialBridgeToken: 'token' });
    await press(findPressableByText(failed.tree.root as Queryable, 'Test Connection'));
    expect(hasText(failed.tree.root as Queryable, 'Connection error.')).toBe(true);
    act(() => failed.tree.unmount());

    const saveFailed = await renderOnboarding({
      mode: 'add', initialBridgeUrl: 'http://example.com', initialBridgeToken: 'token',
      onSave: jest.fn().mockRejectedValue(new Error('could not persist')),
    });
    expect(hasText(saveFailed.tree.root as Queryable, 'plain HTTP over a non-private host')).toBe(true);
    await press(findByLabel(saveFailed.tree.root as Queryable, 'Continue'));
    expect(hasText(saveFailed.tree.root as Queryable, 'could not persist')).toBe(true);
    act(() => saveFailed.tree.unmount());
  });

  it('handles denied camera permission and valid QR pairing payloads', async () => {
    const denied = await renderOnboarding({ mode: 'add' });
    await press(findPressableByText(denied.tree.root as Queryable, 'Scan QR'));
    expect(mockRequestCameraPermission).toHaveBeenCalled();
    expect(hasText(denied.tree.root as Queryable, 'Camera permission is required')).toBe(true);
    act(() => denied.tree.unmount());

    mockCameraGranted = true;
    const granted = await renderOnboarding({ mode: 'add' });
    const root = granted.tree.root as Queryable;
    await press(findPressableByText(root, 'Scan QR'));
    expect(hasText(root, 'Scan Pairing QR')).toBe(true);
    const camera = root.findAll((node) => node.type === 'mock-camera-view')[0];
    if (!camera) throw new Error('Missing camera');
    await act(async () => {
      readHandler<(event: { data: string }) => void>(camera, 'onBarcodeScanned')({
        data: JSON.stringify({
          type: 'clawdex-bridge-pair',
          bridgeUrl: 'http://127.0.0.1:3001',
          bridgeToken: ' qr-token ',
        }),
      });
    });
    expect(findByLabel(root, 'Bridge URL').props.value).toBe('http://127.0.0.1:3001');
    expect(findByLabel(root, 'Bridge token').props.value).toBe('qr-token');
    expect(hasText(root, 'Scan Pairing QR')).toBe(false);
    act(() => granted.tree.unmount());
  });

  it('reports invalid QR payloads, unlocks scanning, and closes the scanner', async () => {
    mockCameraGranted = true;
    const result = await renderOnboarding({ mode: 'add' });
    const root = result.tree.root as Queryable;
    await press(findPressableByText(root, 'Scan QR'));
    const camera = root.findAll((node) => node.type === 'mock-camera-view')[0];
    await act(async () => {
      readHandler<(event: { data: string }) => void>(camera, 'onBarcodeScanned')({ data: 'not-a-pairing-code' });
    });
    expect(hasText(root, 'QR code is not a valid Clawdex bridge pairing code.')).toBe(true);
    act(() => jest.advanceTimersByTime(1200));
    await press(findByLabel(root, 'Cancel QR scan'));
    expect(hasText(root, 'Scan Pairing QR')).toBe(false);
    act(() => result.tree.unmount());
  });

  it.each([
    ['bridge URL and token aliases', { url: 'ws://127.0.0.1:3001/', token: ' alias-token ' }, 'http://127.0.0.1:3001', 'alias-token'],
    ['slash pair type', { type: ' CLAWDEX/BRIDGE-PAIR ', bridgeToken: 'slash-pair' }, '', 'slash-pair'],
    ['dash token type', { type: 'clawdex-bridge-token', bridgeToken: 'dash-token' }, '', 'dash-token'],
    ['slash token type', { type: 'clawdex/bridge-token', token: 'slash-token' }, '', 'slash-token'],
    ['missing type', { bridgeToken: 'typeless' }, '', 'typeless'],
  ])('accepts QR JSON payload using %s', async (_name, payload, expectedUrl, expectedToken) => {
    mockCameraGranted = true;
    const result = await renderOnboarding({ mode: 'add' });
    const root = result.tree.root as Queryable;
    await press(findPressableByText(root, 'Scan QR'));
    const camera = root.findAll((node) => node.type === 'mock-camera-view')[0];
    await act(async () => readHandler<(event: { data: string }) => void>(camera, 'onBarcodeScanned')({ data: JSON.stringify(payload) }));
    expect(findByLabel(root, 'Bridge URL').props.value).toBe(expectedUrl);
    expect(findByLabel(root, 'Bridge token').props.value).toBe(expectedToken);
    act(() => result.tree.unmount());
  });

  it.each([
    ['clawdex://pair?bridgeUrl=http%3A%2F%2F127.0.0.1%3A3001&bridgeToken=uri-token', 'http://127.0.0.1:3001', 'uri-token'],
    ['clawdex://pair?url=ws%3A%2F%2F127.0.0.1%3A4001&token=alias-uri', 'http://127.0.0.1:4001', 'alias-uri'],
    ['clawdex://pair?token=token-only', '', 'token-only'],
  ])('accepts pairing URI %s', async (data, expectedUrl, expectedToken) => {
    mockCameraGranted = true;
    const result = await renderOnboarding({ mode: 'add' });
    const root = result.tree.root as Queryable;
    await press(findPressableByText(root, 'Scan QR'));
    const camera = root.findAll((node) => node.type === 'mock-camera-view')[0];
    await act(async () => readHandler<(event: { data: string }) => void>(camera, 'onBarcodeScanned')({ data }));
    expect(findByLabel(root, 'Bridge URL').props.value).toBe(expectedUrl);
    expect(findByLabel(root, 'Bridge token').props.value).toBe(expectedToken);
    act(() => result.tree.unmount());
  });

  it.each([
    '',
    JSON.stringify({ type: 42, bridgeUrl: 42, bridgeToken: 42 }),
    JSON.stringify({ type: 'other', bridgeToken: 'token' }),
    JSON.stringify({ type: 'clawdex-bridge-pair', bridgeToken: '   ' }),
    'https://example.com/?token=nope',
    'clawdex://pair',
  ])('rejects invalid QR form %p', async (data) => {
    mockCameraGranted = true;
    const result = await renderOnboarding({ mode: 'add' });
    const root = result.tree.root as Queryable;
    await press(findPressableByText(root, 'Scan QR'));
    const camera = root.findAll((node) => node.type === 'mock-camera-view')[0];
    await act(async () => readHandler<(event: { data: string }) => void>(camera, 'onBarcodeScanned')({ data }));
    expect(hasText(root, 'QR code is not a valid Clawdex bridge pairing code.')).toBe(true);
    act(() => result.tree.unmount());
  });

  it('locks duplicate scans until the invalid scan delay expires', async () => {
    mockCameraGranted = true;
    const result = await renderOnboarding({ mode: 'add' });
    const root = result.tree.root as Queryable;
    await press(findPressableByText(root, 'Scan QR'));
    const camera = root.findAll((node) => node.type === 'mock-camera-view')[0];
    await act(async () => readHandler<(event: { data: string }) => void>(camera, 'onBarcodeScanned')({ data: 'invalid' }));
    expect(camera.props.onBarcodeScanned).toBeUndefined();
    act(() => jest.advanceTimersByTime(1200));
    const unlockedCamera = root.findAll((node) => node.type === 'mock-camera-view')[0];
    await act(async () => readHandler<(event: { data: string }) => void>(unlockedCamera, 'onBarcodeScanned')({ data: 'clawdex://pair?token=unlocked' }));
    expect(findByLabel(root, 'Bridge token').props.value).toBe('unlocked');
    act(() => result.tree.unmount());
  });

  it('times out the native probes, aborts fetch, and leaves controls busy while pending', async () => {
    const abort = jest.spyOn(AbortController.prototype, 'abort');
    (global.fetch as jest.Mock).mockImplementation(() => new Promise(() => {}));
    const result = await renderOnboarding({
      mode: 'add', initialBridgeUrl: 'http://127.0.0.1:3001', initialBridgeToken: 'token', allowQueryTokenAuth: true,
    });
    const root = result.tree.root as Queryable;
    let checkPromise: Promise<void> | undefined;
    act(() => {
      checkPromise = (findPressableByText(root, 'Test Connection').props.onPress as () => Promise<void>)();
    });
    expect(findPressableByText(root, 'Test Connection').props.accessibilityState).toEqual(expect.objectContaining({ disabled: true, busy: true }));
    expect(findByLabel(root, 'Continue').props.accessibilityState).toEqual(expect.objectContaining({ disabled: true, busy: true }));
    await act(async () => {
      jest.advanceTimersByTime(7000);
      await checkPromise;
    });
    expect(abort).toHaveBeenCalled();
    expect(hasText(root, 'Connection error.')).toBe(true);
    act(() => result.tree.unmount());
  });

  it('handles fetch rejection, degraded RPC, unexpected RPC, and fallback save errors', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('network down'));
    mockWsRequest.mockResolvedValueOnce({ status: 'degraded' });
    const degraded = await renderOnboarding({ mode: 'add', initialBridgeUrl: 'http://127.0.0.1:3001', initialBridgeToken: 'token' });
    await press(findPressableByText(degraded.tree.root as Queryable, 'Test Connection'));
    expect(hasText(degraded.tree.root as Queryable, 'Authenticated RPC verified')).toBe(true);
    act(() => degraded.tree.unmount());

    mockWsRequest.mockResolvedValueOnce({ status: 'wrong' });
    const unexpected = await renderOnboarding({ mode: 'add', initialBridgeUrl: 'http://127.0.0.1:3001', initialBridgeToken: 'token' });
    await press(findPressableByText(unexpected.tree.root as Queryable, 'Test Connection'));
    expect(hasText(unexpected.tree.root as Queryable, 'Connection error.')).toBe(true);
    act(() => unexpected.tree.unmount());

    mockWsRequest.mockRejectedValueOnce(new Error('save probe failed'));
    const failedSaveProbe = await renderOnboarding({ mode: 'add', initialBridgeUrl: 'http://127.0.0.1:3001', initialBridgeToken: 'token' });
    await press(findByLabel(failedSaveProbe.tree.root as Queryable, 'Continue'));
    expect(failedSaveProbe.onSave).not.toHaveBeenCalled();
    act(() => failedSaveProbe.tree.unmount());

    const fallback = await renderOnboarding({
      mode: 'add', initialBridgeUrl: 'http://127.0.0.1:3001', initialBridgeToken: 'token',
      onSave: jest.fn().mockRejectedValue({ message: '' }),
    });
    await press(findByLabel(fallback.tree.root as Queryable, 'Continue'));
    expect(hasText(fallback.tree.root as Queryable, 'Saving the connection failed.')).toBe(true);
    act(() => fallback.tree.unmount());
  });

  it('copies commands and shares the guide on iOS and Android, including rejected shares', async () => {
    const share = jest.spyOn(Share, 'share');
    const result = await renderOnboarding({ mode: 'add' });
    const root = result.tree.root as Queryable;
    await press(findPressableByText(root, 'Copy'));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('npm install -g clawdex-mobile@latest\nclawdex init');
    expect(hasText(root, 'Copied')).toBe(true);
    act(() => jest.advanceTimersByTime(1400));
    expect(hasText(root, 'Copy')).toBe(true);

    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    await press(findByLabel(root, 'Share bridge setup guide'));
    expect(share).toHaveBeenLastCalledWith(expect.objectContaining({ url: 'https://getclawdex.com/bridge-setup/' }));
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    share.mockRejectedValueOnce(new Error('cancelled'));
    await press(findByLabel(root, 'Share bridge setup guide'));
    expect(share).toHaveBeenLastCalledWith(expect.objectContaining({ message: expect.stringContaining('https://getclawdex.com/bridge-setup/') }));
    act(() => result.tree.unmount());
  });

  it('submits from both inputs and clears prior status when values change', async () => {
    const result = await renderOnboarding({ mode: 'add', initialBridgeUrl: 'http://127.0.0.1:3001', initialBridgeToken: 'token' });
    const root = result.tree.root as Queryable;
    await act(async () => readHandler<() => void>(findByLabel(root, 'Bridge URL'), 'onSubmitEditing')());
    expect(result.onSave).toHaveBeenCalledTimes(1);
    act(() => readHandler<(value: string) => void>(findByLabel(root, 'Bridge URL'), 'onChangeText')('bad'));
    expect(hasText(root, 'Connected. URL and token both verified.')).toBe(false);
    act(() => readHandler<(value: string) => void>(findByLabel(root, 'Bridge URL'), 'onChangeText')('http://127.0.0.1:3001'));
    await act(async () => readHandler<() => void>(findByLabel(root, 'Bridge token'), 'onSubmitEditing')());
    expect(result.onSave).toHaveBeenCalledTimes(2);
    act(() => readHandler<(value: string) => void>(findByLabel(root, 'Bridge token'), 'onChangeText')('next-token'));
    expect(hasText(root, 'Connected. URL and token both verified.')).toBe(false);
    act(() => result.tree.unmount());
  });

  it('reacts to mode and initial credential prop changes', async () => {
    const result = await renderOnboarding();
    expect(hasText(result.tree.root as Queryable, 'Private connection')).toBe(true);
    await result.rerender({ mode: 'edit', initialBridgeUrl: 'http://127.0.0.1:4999', initialBridgeToken: 'rerender-token' });
    const root = result.tree.root as Queryable;
    expect(findByLabel(root, 'Bridge URL').props.value).toBe('http://127.0.0.1:4999');
    expect(findByLabel(root, 'Bridge token').props.value).toBe('rerender-token');
    expect(findByLabel(root, 'Save URL')).toBeTruthy();
    await result.rerender({ mode: 'initial', initialBridgeUrl: null, initialBridgeToken: null });
    expect(hasText(root, 'Private connection')).toBe(true);
    act(() => result.tree.unmount());
  });

  it('covers warning visibility permutations', async () => {
    const allowed = await renderOnboarding({ mode: 'add', initialBridgeUrl: 'http://example.com', allowInsecureRemoteBridge: true });
    expect(hasText(allowed.tree.root as Queryable, 'plain HTTP over a non-private host')).toBe(false);
    act(() => readHandler<(value: string) => void>(findByLabel(allowed.tree.root as Queryable, 'Bridge URL'), 'onChangeText')('https://example.com'));
    expect(hasText(allowed.tree.root as Queryable, 'plain HTTP over a non-private host')).toBe(false);
    act(() => allowed.tree.unmount());
  });

  it('renders the native form and status styling with the light theme', async () => {
    const result = await renderOnboarding({
      mode: 'add',
      initialBridgeUrl: 'http://example.com',
      initialBridgeToken: 'token',
      themeMode: 'light',
    });
    const root = result.tree.root as Queryable;
    expect(findByLabel(root, 'Bridge URL')).toBeTruthy();
    await press(findPressableByText(root, 'Test Connection'));
    expect(hasText(root, 'Connected. URL and token both verified.')).toBe(true);
    act(() => result.tree.unmount());
  });

  it('opens after newly granted permission and covers every modal close path', async () => {
    mockRequestCameraPermission.mockResolvedValueOnce({ granted: true });
    const result = await renderOnboarding({ mode: 'add' });
    const root = result.tree.root as Queryable;
    await press(findPressableByText(root, 'Scan QR'));
    expect(hasText(root, 'Scan Pairing QR')).toBe(true);
    expect(hasText(root, 'Camera permission is required to scan the pairing QR.')).toBe(true);
    const modal = root.findAll((node) => node.type === Modal)[0];
    act(() => readHandler<() => void>(modal, 'onRequestClose')());
    expect(hasText(root, 'Scan Pairing QR')).toBe(false);

    mockCameraGranted = true;
    await result.rerender({ mode: 'add' });
    await press(findPressableByText(root, 'Scan QR'));
    await press(findPressableByText(root, 'Cancel'));
    expect(hasText(root, 'Scan Pairing QR')).toBe(false);

    await press(findPressableByText(root, 'Scan QR'));
    const sheet = root.findAll((node) => node.props.accessibilityRole === 'none')[0];
    const stopPropagation = jest.fn();
    act(() => readHandler<(event: { stopPropagation: () => void }) => void>(sheet, 'onPress')({ stopPropagation }));
    expect(stopPropagation).toHaveBeenCalled();
    const backdrop = root.findAll((node) =>
      node.props.accessibilityLabel === 'Close QR scanner' && typeof node.props.onPress === 'function'
    )[0];
    await press(backdrop);
    expect(hasText(root, 'Scan Pairing QR')).toBe(false);
    act(() => result.tree.unmount());
  });
});