import * as mockReact from 'react';
import { Modal, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { HostBridgeApiClient } from '../../api/client';
import type { BridgeCapabilities, BrowserPreviewSession } from '../../api/types';
import { AppThemeProvider, createAppTheme } from '../../theme';
import { BrowserScreen, type BrowserScreenHandle } from '../BrowserScreen';

const mockWebViewMethods = {
  reload: jest.fn(),
  goBack: jest.fn(),
  goForward: jest.fn(),
  injectJavaScript: jest.fn(),
};

jest.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => name }));
jest.mock('react-native-webview', () => {
  return {
    WebView: mockReact.forwardRef(function MockWebView(props: Record<string, unknown>, ref) {
      mockReact.useImperativeHandle(ref, () => mockWebViewMethods);
      return mockReact.createElement('mock-web-view', props);
    }),
  };
});

type Queryable = ReactTestInstance & {
  children: unknown[];
  parent: Queryable | null;
  type: unknown;
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByType(type: unknown): Queryable[];
};

type PropHandler = (...args: never[]) => unknown;

function readHandler<Handler extends PropHandler>(node: Queryable, property: string): Handler {
  const handler = node.props[property];
  if (typeof handler !== 'function') throw new Error(`Missing handler: ${property}`);
  return handler as Handler;
}

const theme = createAppTheme('dark');
const capabilities: BridgeCapabilities = {
  protocolVersion: 2,
  streamId: 'stream',
  preferredAgentId: 'codex',
  activeAgentId: 'codex',
  agents: [],
  supportsByAgent: {},
  agUiEvents: true,
  supports: {
    reviewStart: true,
    turnSteer: true,
    commandOutputDelta: true,
    selfUpdate: true,
    browserPreview: true,
    genericUiSurface: true,
  },
};
const session: BrowserPreviewSession = {
  sessionId: 'session-1',
  targetUrl: 'http://127.0.0.1:3000',
  previewPort: 4173,
  previewBaseUrl: 'http://bridge:4173',
  bootstrapPath: '/preview/session-1',
  createdAt: '2026-07-20T00:00:00.000Z',
  lastAccessedAt: '2026-07-20T00:00:00.000Z',
  expiresAt: '2026-07-20T01:00:00.000Z',
};

function createApi(options: {
  capabilities?: BridgeCapabilities | Error;
  discoveryError?: boolean;
  createError?: Error;
} = {}): HostBridgeApiClient {
  return {
    readBridgeCapabilities: jest.fn().mockImplementation(() => {
      const value = options.capabilities ?? capabilities;
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }),
    discoverBrowserPreviewTargets: jest.fn().mockImplementation(() =>
      options.discoveryError
        ? Promise.reject(new Error('scan failed'))
        : Promise.resolve({
            scannedAt: '2026-07-20T00:00:00.000Z',
            suggestions: [{ targetUrl: 'http://127.0.0.1:5173', port: 5173, label: 'Vite' }],
          })
    ),
    createBrowserPreviewSession: jest.fn().mockImplementation(() =>
      options.createError ? Promise.reject(options.createError) : Promise.resolve(session)
    ),
    closeBrowserPreviewSession: jest.fn().mockResolvedValue(true),
  } as unknown as HostBridgeApiClient;
}

function setPlatform(os: typeof Platform.OS): void {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
}

function hasText(root: Queryable, text: string): boolean {
  return root.findAll((node) => node.children.map(String).join('').includes(text)).length > 0;
}

function exercisePressableStyles(root: Queryable): void {
  for (const node of root.findAll((candidate) => typeof candidate.props.style === 'function')) {
    const style = node.props.style as (state: { pressed: boolean }) => unknown;
    style({ pressed: false });
    style({ pressed: true });
  }
}

function findByLabel(root: Queryable, label: string): Queryable {
  const node = root.findAll((candidate) => candidate.props.accessibilityLabel === label)[0];
  if (!node) throw new Error(`Missing label: ${label}`);
  return node;
}

function findPressableByText(root: Queryable, text: string): Queryable {
  const textNode = root.findAll((node) => node.children.map(String).join('') === text)[0];
  let current: Queryable | null = textNode ?? null;
  while (current && typeof current.props.onPress !== 'function') {
    current = current.parent;
  }
  if (!current) throw new Error(`Missing pressable: ${text}`);
  return current;
}

async function invoke(node: Queryable, property = 'onPress', value?: unknown): Promise<void> {
  await act(async () => {
    readHandler<(argument?: unknown) => void>(node, property)(value);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderBrowser(options: {
  api?: HostBridgeApiClient;
  recentTargetUrls?: string[];
  pendingTargetUrl?: string | null;
  handlePendingTarget?: boolean;
  bottomInset?: number;
} = {}): Promise<{
  tree: ReactTestRenderer;
  api: HostBridgeApiClient;
  ref: { current: BrowserScreenHandle | null };
  onRecentTargetUrlsChange: jest.Mock;
  onPendingTargetHandled: jest.Mock;
}> {
  const api = options.api ?? createApi();
  const ref = { current: null as BrowserScreenHandle | null };
  const onRecentTargetUrlsChange = jest.fn();
  const onPendingTargetHandled = jest.fn();
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: options.bottomInset ?? 34 } }}>
        <AppThemeProvider theme={theme}>
          <BrowserScreen
            ref={ref}
            api={api}
            bridgeUrl="http://bridge:3001"
            onOpenDrawer={jest.fn()}
            recentTargetUrls={options.recentTargetUrls ?? []}
            onRecentTargetUrlsChange={onRecentTargetUrlsChange}
            pendingTargetUrl={options.pendingTargetUrl}
            onPendingTargetHandled={options.handlePendingTarget === false ? undefined : onPendingTargetHandled}
          />
        </AppThemeProvider>
      </SafeAreaProvider>
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!tree) throw new Error('Expected BrowserScreen tree');
  return { tree, api, ref, onRecentTargetUrlsChange, onPendingTargetHandled };
}

describe('BrowserScreen behavior', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    setPlatform('ios');
  });

  it('renders discovered, recent, empty, and failed capability states', async () => {
    const populated = await renderBrowser({ recentTargetUrls: ['http://127.0.0.1:8080'] });
    exercisePressableStyles(populated.tree.root as Queryable);
    expect(hasText(populated.tree.root as Queryable, 'Running now')).toBe(true);
    expect(hasText(populated.tree.root as Queryable, 'Vite')).toBe(true);
    expect(hasText(populated.tree.root as Queryable, '127.0.0.1:8080')).toBe(true);
    act(() => populated.tree.unmount());

    const unavailable = await renderBrowser({
      api: createApi({ capabilities: { ...capabilities, supports: { ...capabilities.supports, browserPreview: false } }, discoveryError: true }),
    });
    expect(hasText(unavailable.tree.root as Queryable, 'No local web servers responded right now.')).toBe(true);
    expect(hasText(unavailable.tree.root as Queryable, 'Open one preview and it will appear here.')).toBe(true);
    expect(hasText(unavailable.tree.root as Queryable, 'did not start its preview server')).toBe(true);
    expect(findByLabel(unavailable.tree.root as Queryable, 'Open preview').props.disabled).toBe(true);
    act(() => unavailable.tree.unmount());

    const failed = await renderBrowser({ api: createApi({ capabilities: new Error('capabilities offline') }) });
    expect(hasText(failed.tree.root as Queryable, 'capabilities offline')).toBe(true);
    act(() => failed.tree.unmount());
  });

  it('normalizes, opens, navigates, reloads, and closes a native preview', async () => {
    const result = await renderBrowser();
    const root = result.tree.root as Queryable;
    exercisePressableStyles(root);
    const input = findByLabel(root, 'Preview address');
    act(() => readHandler<(value: string) => void>(input, 'onChangeText')('3000'));
    await invoke(findByLabel(root, 'Open preview'));
    exercisePressableStyles(root);

    expect(result.api.createBrowserPreviewSession).toHaveBeenCalledWith('http://127.0.0.1:3000/');
    expect(result.onRecentTargetUrlsChange).toHaveBeenCalledWith(['http://127.0.0.1:3000/']);
    const webView = root.findAll((node) => node.type === 'mock-web-view')[0];
    if (!webView) throw new Error('Missing WebView');
    expect(result.ref.current?.handleHardwareBackPress()).toBe(false);
    await invoke(webView, 'onNavigationStateChange', {
      url: 'http://bridge:4173/preview/session-1/page',
      title: 'Preview page',
      canGoBack: true,
      canGoForward: true,
      loading: false,
    });
    expect(result.ref.current?.handleHardwareBackPress()).toBe(true);
    expect(mockWebViewMethods.goBack).toHaveBeenCalled();
    await invoke(findByLabel(root, 'Forward'));
    await invoke(findByLabel(root, 'Reload preview'));
    expect(mockWebViewMethods.goForward).toHaveBeenCalled();
    expect(mockWebViewMethods.reload).toHaveBeenCalled();

    const shouldStartLoad = readHandler<(request: { url: string }) => boolean>(webView, 'onShouldStartLoadWithRequest');
    expect(shouldStartLoad({ url: 'about:blank' })).toBe(true);
    expect(shouldStartLoad({ url: 'data:text/plain,ok' })).toBe(true);
    expect(shouldStartLoad({ url: 'https://example.com' })).toBe(false);
    await invoke(webView, 'onError', { nativeEvent: { description: 'preview crashed' } });
    expect(hasText(root, 'preview crashed')).toBe(true);
    await invoke(findByLabel(root, 'Show preview start page'));
    expect(hasText(root, 'Open a local preview')).toBe(true);
    expect(result.api.closeBrowserPreviewSession).toHaveBeenCalledWith(session.sessionId);
    act(() => result.tree.unmount());
  });

  it('handles invalid input, create failures, pending targets, and clear/scan actions', async () => {
    const invalid = await renderBrowser();
    const invalidRoot = invalid.tree.root as Queryable;
    const invalidInput = findByLabel(invalidRoot, 'Preview address');
    act(() => readHandler<(value: string) => void>(invalidInput, 'onChangeText')(''));
    await invoke(findByLabel(invalidRoot, 'Open preview'));
    expect(hasText(invalidRoot, 'Use a loopback URL')).toBe(true);
    act(() => readHandler<(value: string) => void>(invalidInput, 'onChangeText')('3000'));
    await invoke(findByLabel(invalidRoot, 'Clear preview address'));
    expect(findByLabel(invalidRoot, 'Preview address').props.value).toBe('');
    await invoke(findByLabel(invalidRoot, 'Scan for local previews'));
    expect(invalid.api.discoverBrowserPreviewTargets).toHaveBeenCalledTimes(2);
    act(() => invalid.tree.unmount());

    const failed = await renderBrowser({ api: createApi({ createError: new Error('session failed') }) });
    await invoke(findByLabel(failed.tree.root as Queryable, 'Open preview'));
    expect(hasText(failed.tree.root as Queryable, 'session failed')).toBe(true);
    act(() => failed.tree.unmount());

    const pending = await renderBrowser({ pendingTargetUrl: '5173' });
    expect(pending.onPendingTargetHandled).toHaveBeenCalledTimes(1);
    expect(pending.api.createBrowserPreviewSession).toHaveBeenCalledWith('http://127.0.0.1:5173/');
    act(() => pending.tree.unmount());
  });

  it('switches viewport modes and validates custom desktop dimensions', async () => {
    const result = await renderBrowser();
    const root = result.tree.root as Queryable;
    await invoke(findByLabel(root, 'Open preview'));
    await invoke(findByLabel(root, 'Desktop viewport'));
    expect(result.api.createBrowserPreviewSession).toHaveBeenCalledTimes(2);
    await invoke(findByLabel(root, 'Viewport size, 1920×1080'));
    expect(hasText(root, 'Current viewport: 1920×1080')).toBe(true);
    await invoke(findPressableByText(root, 'Custom'));
    const width = findByLabel(root, 'Viewport width');
    const height = findByLabel(root, 'Viewport height');
    act(() => {
      readHandler<(value: string) => void>(width, 'onChangeText')('100');
      readHandler<(value: string) => void>(height, 'onChangeText')('5000');
    });
    const apply = findPressableByText(root, 'Apply');
    await invoke(apply);
    expect(hasText(root, 'between 320 and 4096')).toBe(true);
    act(() => {
      readHandler<(value: string) => void>(findByLabel(root, 'Viewport width'), 'onChangeText')('1440');
      readHandler<(value: string) => void>(findByLabel(root, 'Viewport height'), 'onChangeText')('900');
    });
    await invoke(apply);
    expect(hasText(root, 'between 320 and 4096')).toBe(false);
    act(() => result.tree.unmount());
  });

  it('opens discovered and recent targets and exercises input submission', async () => {
    const result = await renderBrowser({ recentTargetUrls: ['http://127.0.0.1:8080'] });
    const root = result.tree.root as Queryable;
    await invoke(findByLabel(root, '127.0.0.1:5173, Vite'));
    expect(result.api.createBrowserPreviewSession).toHaveBeenCalledWith('http://127.0.0.1:5173/');
    await invoke(findByLabel(root, 'Show preview start page'));
    await invoke(findByLabel(root, '127.0.0.1:8080, http://127.0.0.1:8080'));
    expect(result.api.createBrowserPreviewSession).toHaveBeenLastCalledWith('http://127.0.0.1:8080/');
    await invoke(findByLabel(root, 'Show preview start page'));
    const input = findByLabel(root, 'Preview address');
    act(() => readHandler<(value: string) => void>(input, 'onChangeText')('localhost:9000'));
    await invoke(input, 'onSubmitEditing');
    expect(result.api.createBrowserPreviewSession).toHaveBeenLastCalledWith('http://localhost:9000/');
    act(() => result.tree.unmount());
  });

  it('handles local navigation interception, WebView lifecycle, HTTP errors, and scroll chrome', async () => {
    const result = await renderBrowser();
    const root = result.tree.root as Queryable;
    await invoke(findByLabel(root, 'Open preview'));
    let webView = root.findAll((node) => node.type === 'mock-web-view')[0];
    if (!webView) throw new Error('Missing WebView');
    await act(async () => {
      const shouldStartLoad = readHandler<(request: { url: string }) => boolean>(webView, 'onShouldStartLoadWithRequest');
      expect(shouldStartLoad({ url: 'blob:http://bridge/id' })).toBe(true);
      expect(shouldStartLoad({ url: 'http://bridge:4173/preview/session-1' })).toBe(true);
      expect(shouldStartLoad({ url: 'http://127.0.0.1:5050/page' })).toBe(false);
      jest.runOnlyPendingTimers();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.api.createBrowserPreviewSession).toHaveBeenCalledWith('http://127.0.0.1:5050/page');
    webView = root.findAll((node) => node.type === 'mock-web-view')[0];
    await invoke(webView, 'onLoadStart');
    expect(hasText(root, 'Loading preview')).toBe(true);
    await invoke(webView, 'onLoadEnd');
    webView = root.findAll((node) => node.type === 'mock-web-view')[0];
    await invoke(webView, 'onHttpError', { nativeEvent: { statusCode: 503 } });
    expect(hasText(root, 'Preview returned HTTP 503.')).toBe(true);
    webView = root.findAll((node) => node.type === 'mock-web-view')[0];
    await invoke(webView, 'onContentProcessDidTerminate');
    expect(hasText(root, 'Loading preview')).toBe(true);
    webView = root.findAll((node) => node.type === 'mock-web-view')[0];
    await invoke(webView, 'onScroll', { nativeEvent: { contentOffset: { x: 0, y: 30 } } });
    await invoke(webView, 'onScroll', { nativeEvent: { contentOffset: { x: 0, y: 34 } } });
    await invoke(webView, 'onScroll', { nativeEvent: { contentOffset: { x: 0, y: 12 } } });
    await invoke(webView, 'onScroll', { nativeEvent: { contentOffset: { x: 0, y: 0 } } });
    act(() => result.tree.unmount());
  });

  it('covers desktop native shell messages, commands, layout, and modal dismissal', async () => {
    setPlatform('android');
    const result = await renderBrowser();
    const root = result.tree.root as Queryable;
    await invoke(findByLabel(root, 'Open preview'));
    await invoke(findByLabel(root, 'Desktop Full viewport'));
    exercisePressableStyles(root);
    const viewport = root.findAll((node) => typeof node.props.onLayout === 'function')[0];
    if (!viewport) throw new Error('Missing desktop viewport');
    await invoke(viewport, 'onLayout', { nativeEvent: { layout: { width: 0, height: 0 } } });
    await invoke(viewport, 'onLayout', { nativeEvent: { layout: { width: 360, height: 640 } } });
    await invoke(viewport, 'onLayout', { nativeEvent: { layout: { width: 360, height: 640 } } });
    const webView = root.findAll((node) => node.type === 'mock-web-view')[0];
    if (!webView) throw new Error('Missing desktop WebView');
    await invoke(webView, 'onMessage', { nativeEvent: { data: 'not-json' } });
    await invoke(webView, 'onMessage', { nativeEvent: { data: JSON.stringify({ type: 'other' }) } });
    await invoke(webView, 'onMessage', { nativeEvent: { data: JSON.stringify({ type: 'clawdexDesktopFrameState', shellRequestKey: 'wrong', rawUrl: 'http://bridge:4173/preview/session-1/wrong' }) } });
    await invoke(webView, 'onMessage', { nativeEvent: { data: JSON.stringify({ type: 'clawdexDesktopFrameState', rawUrl: 'http://bridge:4173/preview/session-1/docs', title: 'Docs', canGoBack: true, canGoForward: true }) } });
    expect(result.ref.current?.handleHardwareBackPress()).toBe(true);
    await invoke(findByLabel(root, 'Forward'));
    await invoke(findByLabel(root, 'Reload preview'));
    expect(mockWebViewMethods.injectJavaScript).toHaveBeenCalledWith(expect.stringContaining('goBack'));
    expect(mockWebViewMethods.injectJavaScript).toHaveBeenCalledWith(expect.stringContaining('goForward'));
    expect(mockWebViewMethods.injectJavaScript).toHaveBeenCalledWith(expect.stringContaining('reload'));
    await invoke(webView, 'onContentProcessDidTerminate');
    await invoke(findByLabel(root, 'Viewport size, 1920×1080'));
    exercisePressableStyles(root);
    const modal = root.findAllByType(Modal)[0] as unknown as Queryable;
    act(() => readHandler<() => void>(modal, 'onRequestClose')());
    expect(hasText(root, 'Viewport')).toBe(false);
    act(() => result.tree.unmount());
  });

  it('covers desktop overview messages and viewport reload failures', async () => {
    const api = createApi();
    const result = await renderBrowser({ api });
    const root = result.tree.root as Queryable;
    await invoke(findByLabel(root, 'Open preview'));
    await invoke(findByLabel(root, 'Desktop viewport'));
    let webView = root.findAll((node) => node.type === 'mock-web-view')[0];
    if (!webView) throw new Error('Missing overview WebView');
    const viewport = root.findAll((node) => typeof node.props.onLayout === 'function')[0];
    if (!viewport) throw new Error('Missing overview viewport');
    await invoke(viewport, 'onLayout', { nativeEvent: { layout: { width: 390, height: 700 } } });
    await invoke(viewport, 'onLayout', { nativeEvent: { layout: { width: 390, height: 700 } } });
    await invoke(webView, 'onMessage', { nativeEvent: { data: 'bad-json' } });
    await invoke(webView, 'onMessage', { nativeEvent: { data: JSON.stringify({ type: 'other', height: 2000 }) } });
    await invoke(webView, 'onMessage', { nativeEvent: { data: JSON.stringify({ type: 'clawdexOverviewMetrics', height: 0 }) } });
    await invoke(webView, 'onMessage', { nativeEvent: { data: JSON.stringify({ type: 'clawdexOverviewMetrics', height: 2400 }) } });
    await invoke(webView, 'onMessage', { nativeEvent: { data: JSON.stringify({ type: 'clawdexOverviewMetrics', height: 2400 }) } });
    await invoke(webView, 'onMessage', { nativeEvent: { data: JSON.stringify({ type: 'clawdexOverviewMetrics', height: 2200 }) } });
    act(() => jest.runOnlyPendingTimers());
    webView = root.findAll((node) => node.type === 'mock-web-view')[0];
    await invoke(webView, 'onContentProcessDidTerminate');
    (api.createBrowserPreviewSession as jest.Mock).mockRejectedValueOnce(new Error('viewport reload failed'));
    await invoke(findByLabel(root, 'Mobile viewport'));
    expect(hasText(root, 'viewport reload failed')).toBe(true);
    act(() => result.tree.unmount());
  });

  it('renders web iframe mobile/desktop branches and reloads without native methods', async () => {
    setPlatform('web');
    const result = await renderBrowser();
    const root = result.tree.root as Queryable;
    await invoke(findByLabel(root, 'Open preview'));
    let iframe = root.findAll((node) => node.type === 'iframe')[0];
    if (!iframe) throw new Error('Missing mobile iframe');
    await invoke(iframe, 'onLoad');
    await invoke(findByLabel(root, 'Reload preview'));
    await invoke(findByLabel(root, 'Desktop viewport'));
    iframe = root.findAll((node) => node.type === 'iframe')[0];
    if (!iframe) throw new Error('Missing desktop iframe');
    await invoke(iframe, 'onLoad');
    expect(findByLabel(root, 'Back').props.disabled).toBe(true);
    act(() => result.tree.unmount());
  });

  it('covers custom viewport presets and backdrop close without a preview', async () => {
    const result = await renderBrowser();
    const root = result.tree.root as Queryable;
    await invoke(findByLabel(root, 'Open preview'));
    await invoke(findByLabel(root, 'Viewport size, 1920×1080'));
    await invoke(findPressableByText(root, '1366×768'));
    expect(hasText(root, '1366×768')).toBe(true);
    await invoke(findByLabel(root, 'Viewport size, 1366×768'));
    await invoke(findByLabel(root, 'Close viewport menu'));
    await invoke(findByLabel(root, 'Show preview start page'));
    await invoke(findByLabel(root, 'Scan for local previews'));
    expect(result.api.discoverBrowserPreviewTargets).toHaveBeenCalledTimes(2);
    act(() => result.tree.unmount());
  });

  it('uses non-Error capability and session failure fallbacks', async () => {
    const capabilityApi = createApi();
    (capabilityApi.readBridgeCapabilities as jest.Mock).mockRejectedValueOnce('offline');
    const capability = await renderBrowser({ api: capabilityApi });
    expect(hasText(capability.tree.root as Queryable, 'Could not load bridge capabilities.')).toBe(true);
    act(() => capability.tree.unmount());

    const createApiFallback = createApi();
    (createApiFallback.createBrowserPreviewSession as jest.Mock).mockRejectedValueOnce('failed');
    const create = await renderBrowser({ api: createApiFallback });
    await invoke(findByLabel(create.tree.root as Queryable, 'Open preview'));
    expect(hasText(create.tree.root as Queryable, 'Could not open local preview.')).toBe(true);
    act(() => create.tree.unmount());
  });

  it('renders a session without optional base URL and empty navigation values', async () => {
    const api = createApi();
    (api.createBrowserPreviewSession as jest.Mock).mockResolvedValue({ ...session, previewBaseUrl: null });
    const result = await renderBrowser({ api });
    const root = result.tree.root as Queryable;
    await invoke(findByLabel(root, 'Open preview'));
    let webView = root.findAll((node) => node.type === 'mock-web-view')[0];
    if (!webView) throw new Error('Missing WebView');
    await invoke(webView, 'onNavigationStateChange', { url: '', title: '', canGoBack: false, canGoForward: false, loading: false });
    expect(result.ref.current?.handleHardwareBackPress()).toBe(false);
    webView = root.findAll((node) => node.type === 'mock-web-view')[0];
    await invoke(webView, 'onError', { nativeEvent: { description: '' } });
    expect(hasText(root, 'Could not load preview.')).toBe(true);
    act(() => result.tree.unmount());
  });

  it('handles sparse native shell messages and default HTTP errors', async () => {
    setPlatform('android');
    const result = await renderBrowser();
    const root = result.tree.root as Queryable;
    await invoke(findByLabel(root, 'Open preview'));
    await invoke(findByLabel(root, 'Desktop Full viewport'));
    let webView = root.findAll((node) => node.type === 'mock-web-view')[0];
    if (!webView) throw new Error('Missing shell WebView');
    await invoke(webView, 'onNavigationStateChange', { url: 'ignored', title: 'Ignored', canGoBack: true, canGoForward: true, loading: true });
    await invoke(webView, 'onMessage', { nativeEvent: { data: JSON.stringify({ type: 'clawdexDesktopFrameState', rawUrl: '', title: 42 }) } });
    expect(result.ref.current?.handleHardwareBackPress()).toBe(false);
    webView = root.findAll((node) => node.type === 'mock-web-view')[0];
    await invoke(webView, 'onHttpError', { nativeEvent: { statusCode: 404 } });
    expect(hasText(root, 'Preview returned HTTP 404.')).toBe(true);
    act(() => result.tree.unmount());
  });

  it('changes every viewport mode before a session exists', async () => {
    const result = await renderBrowser();
    const root = result.tree.root as Queryable;
    const input = findByLabel(root, 'Preview address');
    act(() => readHandler<(value: string) => void>(input, 'onChangeText')('not a target'));
    await invoke(findByLabel(root, 'Open preview'));
    await invoke(findByLabel(root, 'Scan for local previews'));
    expect(result.api.createBrowserPreviewSession).not.toHaveBeenCalled();
    act(() => result.tree.unmount());
  });

  it('covers Android mobile preview, zero inset, and missing pending callback', async () => {
    setPlatform('android');
    const result = await renderBrowser({ pendingTargetUrl: '3000', handlePendingTarget: false, bottomInset: 0 });
    const root = result.tree.root as Queryable;
    exercisePressableStyles(root);
    const webView = root.findAll((node) => node.type === 'mock-web-view')[0];
    if (!webView) throw new Error('Missing Android WebView');
    expect(webView.props.contentMode).toBe('mobile');
    expect(webView.props.userAgent).toBeUndefined();
    await invoke(webView, 'onNavigationStateChange', { url: 'https://outside.example/path', title: 'Outside', canGoBack: true, canGoForward: false, loading: false });
    expect(findByLabel(root, 'Preview address').props.value).toBe('https://outside.example/path');
    act(() => result.tree.unmount());
  });

  it('rejects nonnumeric custom viewports and missing bootstrap URLs', async () => {
    const result = await renderBrowser();
    const root = result.tree.root as Queryable;
    await invoke(findByLabel(root, 'Open preview'));
    await invoke(findByLabel(root, 'Viewport size, 1920×1080'));
    await invoke(findPressableByText(root, 'Custom'));
    act(() => {
      readHandler<(value: string) => void>(findByLabel(root, 'Viewport width'), 'onChangeText')('not-a-number');
      readHandler<(value: string) => void>(findByLabel(root, 'Viewport height'), 'onChangeText')('900');
    });
    await invoke(findPressableByText(root, 'Apply'));
    expect(hasText(root, 'between 320 and 4096')).toBe(true);
    exercisePressableStyles(root);
    act(() => result.tree.unmount());

    const api = createApi();
    (api.createBrowserPreviewSession as jest.Mock).mockResolvedValue({ ...session, previewPort: 0, previewBaseUrl: '', bootstrapPath: '' });
    const missing = await renderBrowser({ api });
    await invoke(findByLabel(missing.tree.root as Queryable, 'Open preview'));
    expect(hasText(missing.tree.root as Queryable, 'Could not build preview bootstrap URL.')).toBe(true);
    expect(api.closeBrowserPreviewSession).toHaveBeenCalledWith(session.sessionId);
    act(() => missing.tree.unmount());
  });

  it('renders desktop mode on a native platform without a shell mode', async () => {
    setPlatform('windows');
    const result = await renderBrowser();
    const root = result.tree.root as Queryable;
    await invoke(findByLabel(root, 'Open preview'));
    await invoke(findByLabel(root, 'Desktop viewport'));
    exercisePressableStyles(root);
    const viewport = root.findAll((node) => typeof node.props.onLayout === 'function')[0];
    if (!viewport) throw new Error('Missing native desktop viewport');
    await invoke(viewport, 'onLayout', { nativeEvent: { layout: { width: 800, height: 600 } } });
    const webView = root.findAll((node) => node.type === 'mock-web-view')[0];
    if (!webView) throw new Error('Missing native desktop WebView');
    expect(webView.props.contentMode).toBe('desktop');
    expect(webView.props.userAgent).toContain('Mozilla/5.0');
    await invoke(webView, 'onMessage', { nativeEvent: { data: JSON.stringify({ type: 'clawdexOverviewMetrics', height: 3000 }) } });
    await invoke(webView, 'onContentProcessDidTerminate');
    expect(hasText(root, 'Loading preview')).toBe(true);
    act(() => result.tree.unmount());
  });
});