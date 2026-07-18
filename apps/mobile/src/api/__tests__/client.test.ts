import { HostBridgeApiClient } from '../client';
import { RpcRequestError, type HostBridgeWsClient } from '../ws';
import * as FileSystem from 'expo-file-system/legacy';

jest.mock('expo-file-system/legacy', () => ({
  uploadAsync: jest.fn(),
  FileSystemUploadType: { MULTIPART: 1 },
  FileSystemSessionType: { FOREGROUND: 1 },
}));

function createWsMock() {
  type WsLike = Pick<HostBridgeWsClient, 'request' | 'waitForTurnCompletion' | 'onEvent'>;
  const onEventMock = jest.fn() as jest.MockedFunction<WsLike['onEvent']>;
  onEventMock.mockReturnValue(jest.fn());
  return {
    request: jest.fn(),
    waitForTurnCompletion: jest.fn().mockResolvedValue(undefined),
    onEvent: onEventMock,
  } as unknown as jest.Mocked<WsLike>;
}

describe('HostBridgeApiClient', () => {
  it('listHarnessAgents() maps sanitized agent metadata', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      data: [
        {
          id: 'security-auditor',
          name: 'security-auditor',
          description: 'Reviews security-sensitive changes',
          mode: 'primary',
          custom: true,
          model: 'anthropic/claude-sonnet',
        },
      ],
    });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });

    await expect(
      client.listHarnessAgents({ engine: 'opencode', cwd: '/repo' })
    ).resolves.toEqual([
      expect.objectContaining({
        name: 'security-auditor',
        mode: 'primary',
        custom: true,
      }),
    ]);
    expect(ws.request).toHaveBeenCalledWith('agent/list', {
      engine: 'opencode',
      threadId: null,
      cwd: '/repo',
    });
  });

  it('health() calls bridge/health/read', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({ status: 'ok', at: '2026-01-01T00:00:00Z', uptimeSec: 10 });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.health();

    expect(ws.request).toHaveBeenCalledWith('bridge/health/read');
    expect(result.status).toBe('ok');
  });

  it('readBridgeStatus() calls bridge/status/read', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      status: 'ok',
      at: '2026-01-01T00:00:00Z',
      uptimeSec: 10,
      connectedClients: 1,
      devices: [
        {
          clientId: 1,
          clientType: 'mobile',
          clientName: 'Mohit iPhone',
          connectedAt: '2026-01-01T00:00:00Z',
          lastSeenAt: '2026-01-01T00:00:01Z',
        },
      ],
      engines: {},
      operational: {
        requests: { total: 1, completed: 1, failed: 0, timedOut: 0, pending: 0 },
        replay: { entries: 0, capacity: 2000 },
      },
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.readBridgeStatus();

    expect(ws.request).toHaveBeenCalledWith('bridge/status/read');
    expect(result.connectedClients).toBe(1);
    expect(result.devices[0].clientName).toBe('Mohit iPhone');
    expect(result.operational.replay.capacity).toBe(2000);
  });

  it('readAccountRateLimits() requests account/rateLimits/read and prefers codex bucket', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          primary: {
            usedPercent: 22,
            windowDurationMins: 300,
            resetsAt: 1_700_000_000,
          },
          secondary: {
            usedPercent: 61,
            windowDurationMins: 10_080,
            resetsAt: 1_700_000_100,
          },
          planType: 'plus',
        },
      },
      rateLimits: {
        limitId: 'legacy',
        primary: {
          usedPercent: 99,
          windowDurationMins: 60,
          resetsAt: 1_700_000_200,
        },
      },
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.readAccountRateLimits();

    expect(ws.request).toHaveBeenCalledWith('account/rateLimits/read', { engine: 'codex' });
    expect(result).toMatchObject({
      limitId: 'codex',
      planType: 'plus',
      primary: {
        usedPercent: 22,
        windowDurationMins: 300,
      },
      secondary: {
        usedPercent: 61,
        windowDurationMins: 10080,
      },
    });
  });

  it('readBridgeRuntime() calls bridge/runtime/read', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      version: '5.0.4',
      installKind: 'publishedCli',
      selfUpdateSupported: true,
      safeRestartSupported: true,
      latestVersion: '5.0.5',
      updaterStatus: null,
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.readBridgeRuntime();

    expect(ws.request).toHaveBeenCalledWith('bridge/runtime/read');
    expect(result.version).toBe('5.0.4');
    expect(result.latestVersion).toBe('5.0.5');
  });

  it('readCursorCredentials() maps Cursor credential status', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      configured: true,
      valid: true,
      source: 'env',
      api_key_name: 'Cursor key',
      user_email: 'mohit@example.com',
      created_at: '2026-05-01T00:00:00Z',
      enabled: true,
      runtime_available: true,
      active: true,
      error: null,
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.readCursorCredentials();

    expect(ws.request).toHaveBeenCalledWith('bridge/cursor/credentials/read');
    expect(result).toEqual({
      configured: true,
      valid: true,
      source: 'env',
      apiKeyName: 'Cursor key',
      userEmail: 'mohit@example.com',
      createdAt: '2026-05-01T00:00:00Z',
      enabled: true,
      runtimeAvailable: true,
      active: true,
      error: null,
    });
  });

  it('startBridgeUpdate() calls bridge/update/start with latest by default', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      ok: true,
      jobId: 'bridge-update-1',
      targetVersion: 'latest',
      message: 'scheduled',
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.startBridgeUpdate();

    expect(ws.request).toHaveBeenCalledWith('bridge/update/start', {
      version: 'latest',
    });
    expect(result.ok).toBe(true);
  });

  it('startBridgeRestart() calls bridge/restart/start', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      ok: true,
      jobId: 'bridge-restart-1',
      message: 'scheduled',
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.startBridgeRestart();

    expect(ws.request).toHaveBeenCalledWith('bridge/restart/start');
    expect(result.ok).toBe(true);
  });

  it('restartCodexAppServer() calls bridge/codex/app-server/restart', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      ok: true,
      message: 'restarted',
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.restartCodexAppServer();

    expect(ws.request).toHaveBeenCalledWith('bridge/codex/app-server/restart');
    expect(result.ok).toBe(true);
  });

  it('readAccountRateLimits() falls back to first populated keyed snapshot with snake_case payloads', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      rate_limits_by_limit_id: {
        empty: {
          limit_id: 'empty',
          primary: null,
          secondary: null,
        },
        shared: {
          limit_id: 'shared',
          limit_name: 'Shared',
          primary: {
            used_percent: '15',
            window_duration_mins: '300',
            resets_at: '1700000000',
          },
          secondary: null,
          plan_type: 'team',
        },
      },
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.readAccountRateLimits();

    expect(result).toMatchObject({
      limitId: 'shared',
      limitName: 'Shared',
      planType: 'team',
      primary: {
        usedPercent: 15,
        windowDurationMins: 300,
        resetsAt: 1700000000,
      },
      secondary: null,
    });
  });

  it('readAccountRateLimits() falls back to top-level rate limits when keyed buckets are unavailable', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          primary: null,
          secondary: null,
        },
      },
      rate_limits: {
        limit_id: 'legacy',
        primary: {
          used_percent: 44,
          window_duration_mins: 60,
          resets_at: 1700001234,
        },
        secondary: null,
        plan_type: 'pro',
      },
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.readAccountRateLimits();

    expect(result).toMatchObject({
      limitId: 'legacy',
      planType: 'pro',
      primary: {
        usedPercent: 44,
        windowDurationMins: 60,
        resetsAt: 1700001234,
      },
    });
  });

  it('readAccount() requests account/read and maps ChatGPT account details', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      account: {
        type: 'chatgpt',
        email: 'mohit@example.com',
        planType: 'plus',
      },
      requiresOpenaiAuth: true,
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.readAccount();

    expect(ws.request).toHaveBeenCalledWith('account/read', {
      refreshToken: false,
      engine: 'codex',
    });
    expect(result).toEqual({
      type: 'chatgpt',
      email: 'mohit@example.com',
      planType: 'plus',
      requiresOpenaiAuth: true,
    });
  });

  it('readAccount() maps API key auth without ChatGPT fields', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      account: {
        type: 'apiKey',
      },
      requires_openai_auth: false,
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.readAccount();

    expect(result).toEqual({
      type: 'apiKey',
      email: null,
      planType: null,
      requiresOpenaiAuth: false,
    });
  });

  it('readAccount() can request a managed auth token refresh', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      account: {
        type: 'chatgpt',
        email: 'mohit@example.com',
        planType: 'pro',
      },
      requiresOpenaiAuth: false,
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.readAccount({ refreshToken: true });

    expect(ws.request).toHaveBeenCalledWith('account/read', {
      refreshToken: true,
      engine: 'codex',
    });
  });

  it('logoutAccount() requests account/logout', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({});

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.logoutAccount();

    expect(ws.request).toHaveBeenCalledWith('account/logout', { engine: 'codex' });
  });

  it('startChatGptAccountLogin() requests account/login/start and maps auth URL details', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      type: 'chatgpt',
      loginId: 'login_123',
      authUrl: 'https://chatgpt.com/auth/start',
      userCode: 'ABCD-EFGH',
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.startChatGptAccountLogin();

    expect(ws.request).toHaveBeenCalledWith('account/login/start', {
      type: 'chatgpt',
      codexStreamlinedLogin: true,
      engine: 'codex',
    });
    expect(result).toEqual({
      type: 'chatgpt',
      loginId: 'login_123',
      authUrl: 'https://chatgpt.com/auth/start',
      userCode: 'ABCD-EFGH',
    });
  });

  it('startChatGptDeviceCodeAccountLogin() requests Codex-managed device login', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      type: 'chatgptDeviceCode',
      loginId: 'login_device_123',
      verificationUrl: 'https://chatgpt.com/activate',
      userCode: 'WXYZ-1234',
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.startChatGptDeviceCodeAccountLogin();

    expect(ws.request).toHaveBeenCalledWith('account/login/start', {
      type: 'chatgptDeviceCode',
      engine: 'codex',
    });
    expect(result).toEqual({
      type: 'chatgptDeviceCode',
      loginId: 'login_device_123',
      verificationUrl: 'https://chatgpt.com/activate',
      userCode: 'WXYZ-1234',
    });
  });

  it('forwardCodexAuthCallback() forwards the loopback callback to the bridge', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      forwarded: true,
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.forwardCodexAuthCallback(
      'http://localhost:1455/auth/callback?code=abc&state=xyz'
    );

    expect(ws.request).toHaveBeenCalledWith('bridge/codex/auth/callback/forward', {
      callbackUrl: 'http://localhost:1455/auth/callback?code=abc&state=xyz',
    });
  });

  it('waitForAccountLoginCompleted() resolves on matching login completion', async () => {
    const ws = createWsMock();
    const unsubscribe = jest.fn();
    ws.onEvent.mockReturnValueOnce(unsubscribe);

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = client.waitForAccountLoginCompleted('login_123', 1_000);

    const listener = ws.onEvent.mock.calls[0][0];
    listener({
      method: 'account/login/completed',
      params: {
        loginId: 'login_123',
        success: true,
        error: null,
      },
    });

    await expect(result).resolves.toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('waitForAccountLoginCompleted() rejects failed matching login completion', async () => {
    const ws = createWsMock();
    const unsubscribe = jest.fn();
    ws.onEvent.mockReturnValueOnce(unsubscribe);

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = client.waitForAccountLoginCompleted('login_123', 1_000);

    const listener = ws.onEvent.mock.calls[0][0];
    listener({
      method: 'account/login/completed',
      params: {
        loginId: 'login_123',
        success: false,
        error: 'browser login expired',
      },
    });

    await expect(result).rejects.toThrow('browser login expired');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('loginWithChatGptAuthTokens() requests token-based ChatGPT login', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      type: 'chatgptAuthTokens',
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.loginWithChatGptAuthTokens({
      accessToken: 'access_123',
      chatgptAccountId: 'acct_123',
      chatgptPlanType: 'plus',
    });

    expect(ws.request).toHaveBeenCalledWith('account/login/start', {
      type: 'chatgptAuthTokens',
      accessToken: 'access_123',
      chatgptAccountId: 'acct_123',
      chatgptPlanType: 'plus',
      engine: 'codex',
    });
    expect(result).toEqual({
      type: 'chatgptAuthTokens',
    });
  });

  it('cancelAccountLogin() requests account/login/cancel', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({});

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.cancelAccountLogin('login_123');

    expect(ws.request).toHaveBeenCalledWith('account/login/cancel', {
      loginId: 'login_123',
      engine: 'codex',
    });
  });

  it('listChats() maps app-server list response', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      data: [
        {
          id: 'thr_1',
          preview: 'hello world',
          createdAt: 1700000000,
          updatedAt: 1700000001,
          status: { type: 'active' },
          turns: [
            {
              status: 'completed',
              items: [],
            },
          ],
        },
      ],
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const chats = await client.listChats();

    expect(ws.request).toHaveBeenCalledWith(
      'thread/list',
      expect.objectContaining({
        sortKey: 'updated_at',
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
      })
    );
    expect(chats).toHaveLength(1);
    expect(chats[0].id).toBe('thr_1');
    expect(chats[0].status).toBe('complete');
    expect(client.peekChatShell('thr_1')).toMatchObject({
      id: 'thr_1',
      title: 'hello world',
      messages: [],
    });
  });

  it('startChatListStream() maps streamed batches and cancels by stream id', async () => {
    const ws = createWsMock();
    type EventHandler = Parameters<HostBridgeWsClient['onEvent']>[0];
    const listenerRef: { current?: EventHandler } = {};
    const unsubscribe = jest.fn();
    ws.onEvent.mockImplementation((nextListener) => {
      listenerRef.current = nextListener;
      return unsubscribe;
    });
    ws.request.mockImplementation((method, params) => {
      if (method === 'bridge/thread/list/stream/start') {
        return Promise.resolve({
          started: true,
          streamId: (params as { streamId?: string } | undefined)?.streamId,
        });
      }
      return Promise.resolve({});
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const batches: unknown[] = [];
    const controller = await client.startChatListStream(
      {
        limits: [5, 20],
        delayMs: 900,
      },
      (batch) => {
        batches.push(batch);
      }
    );

    expect(ws.request).toHaveBeenCalledWith(
      'bridge/thread/list/stream/start',
      expect.objectContaining({
        streamId: controller.streamId,
        limits: [5, 20],
        delayMs: 900,
      })
    );

    expect(listenerRef.current).toBeTruthy();
    const emit = listenerRef.current as EventHandler;
    emit({
      method: 'bridge/thread/list/stream/batch',
      params: {
        streamId: controller.streamId,
        limit: 5,
        done: false,
        data: [
          {
            id: 'thr_stream',
            preview: 'streamed chat',
            createdAt: 1700000000,
            updatedAt: 1700000001,
            status: { type: 'idle' },
            turns: [],
          },
        ],
      },
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      streamId: controller.streamId,
      limit: 5,
      done: false,
      chats: [
        {
          id: 'thr_stream',
          title: 'streamed chat',
        },
      ],
    });
    expect(client.peekChats({ limit: 5 })?.map((chat) => chat.id)).toEqual(['thr_stream']);

    controller.cancel();

    expect(unsubscribe).toHaveBeenCalled();
    expect(ws.request).toHaveBeenLastCalledWith('bridge/thread/list/stream/cancel', {
      streamId: controller.streamId,
    });
  });

  it('listAllChats() follows thread/list pagination until nextCursor is empty', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({
        data: [
          {
            id: 'thr_1',
            preview: 'first page',
            createdAt: 1700000000,
            updatedAt: 1700000002,
            status: { type: 'idle' },
            turns: [],
          },
        ],
        nextCursor: 'cursor_page_2',
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'thr_2',
            preview: 'second page',
            createdAt: 1700000000,
            updatedAt: 1700000001,
            status: { type: 'idle' },
            turns: [],
          },
        ],
        nextCursor: null,
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const pageSnapshots: string[][] = [];
    const chats = await client.listAllChats({
      pageLimit: 50,
      onPage: (loadedChats) => {
        pageSnapshots.push(loadedChats.map((chat) => chat.id));
      },
    });

    expect(ws.request).toHaveBeenNthCalledWith(
      1,
      'thread/list',
      expect.objectContaining({
        cursor: null,
        limit: 50,
      })
    );
    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'thread/list',
      expect.objectContaining({
        cursor: 'cursor_page_2',
        limit: 50,
      })
    );
    expect(chats.map((chat) => chat.id)).toEqual(['thr_1', 'thr_2']);
    expect(pageSnapshots).toEqual([['thr_1'], ['thr_1', 'thr_2']]);

    ws.request.mockClear();
    pageSnapshots.length = 0;
    const cached = await client.listAllChats({
      pageLimit: 50,
      cacheTtlMs: 30_000,
      onPage: (loadedChats) => {
        pageSnapshots.push(loadedChats.map((chat) => chat.id));
      },
    });

    expect(ws.request).not.toHaveBeenCalled();
    expect(cached.map((chat) => chat.id)).toEqual(['thr_1', 'thr_2']);
    expect(pageSnapshots).toEqual([]);
  });

  it('does not let generated Cursor names override summary titles in chat lists', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({
        thread: {
          id: 'cursor:a7f3b2c1',
          engine: 'cursor',
          name: 'Analyzed the Clawdex mobile bridge.',
          title: 'Analyzed the Clawdex mobile bridge.',
          preview: 'Analyzed the Clawdex mobile bridge.',
          createdAt: 1700000000,
          updatedAt: 1700000003,
          status: { type: 'idle' },
          turns: [],
        },
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'cursor:a7f3b2c1',
            engine: 'cursor',
            name: 'Chat cursor:a7f3b2c1',
            title: 'Chat cursor:a7f3b2c1',
            preview: 'Analyzed the Clawdex mobile bridge.',
            createdAt: 1700000000,
            updatedAt: 1700000003,
            status: { type: 'idle' },
            turns: [],
          },
        ],
        nextCursor: null,
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });

    const headerSummary = await client.getChatSummary('cursor:a7f3b2c1');
    const drawerChats = await client.listChats({ forceRefresh: true });

    expect(headerSummary.title).toBe('Analyzed the Clawdex mobile bridge.');
    expect(drawerChats[0]?.title).toBe('Analyzed the Clawdex mobile bridge.');
  });

  it('getChat() includes cached Cursor cwd when reading a thread', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      thread: {
        id: 'cursor:agent_launchkit',
        engine: 'cursor',
        name: 'LaunchKit visuals',
        preview: 'LaunchKit visuals',
        createdAt: 1700000000,
        updatedAt: 1700000002,
        cwd: '/workspace/launchkit',
        status: { type: 'idle' },
        turns: [],
      },
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    client.rememberChats([
      {
        id: 'cursor:agent_launchkit',
        title: 'LaunchKit visuals',
        createdAt: '2023-11-14T22:13:20.000Z',
        updatedAt: '2023-11-14T22:13:22.000Z',
        statusUpdatedAt: '2023-11-14T22:13:22.000Z',
        status: 'complete',
        lastMessagePreview: 'LaunchKit visuals',
        engine: 'cursor',
        cwd: '/workspace/launchkit',
      },
    ]);

    await client.getChat('cursor:agent_launchkit');

    expect(ws.request).toHaveBeenCalledWith('thread/read', {
      threadId: 'cursor:agent_launchkit',
      includeTurns: true,
      cwd: '/workspace/launchkit',
    });
  });

  it('rememberChats() keeps an already-loaded full chat list monotonic', () => {
    const ws = createWsMock();
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });

    client.rememberAllChats([
      {
        id: 'thr_old',
        title: 'old',
        createdAt: '2023-11-14T22:13:20.000Z',
        updatedAt: '2023-11-14T22:13:20.000Z',
        statusUpdatedAt: '2023-11-14T22:13:20.000Z',
        status: 'complete',
        lastMessagePreview: 'old chat',
        engine: 'codex',
      },
    ]);

    expect(client.peekChatShell('thr_old')).toMatchObject({
      id: 'thr_old',
      title: 'old',
      messages: [],
    });

    client.rememberChats(
      [
        {
          id: 'thr_new',
          title: 'new',
          createdAt: '2023-11-14T22:13:21.000Z',
          updatedAt: '2023-11-14T22:13:21.000Z',
          statusUpdatedAt: '2023-11-14T22:13:21.000Z',
          status: 'running',
          lastMessagePreview: 'new chat',
          engine: 'codex',
        },
      ],
      { limit: 5 }
    );

    expect(client.peekAllChats()?.map((chat) => chat.id)).toEqual(['thr_new', 'thr_old']);
  });

  it('getChat() caches full thread snapshots for immediate reuse', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      thread: {
        id: 'thr_cached',
        preview: 'cached chat',
        createdAt: 1700000000,
        updatedAt: 1700000002,
        status: { type: 'idle' },
        turns: [
          {
            id: 'turn_cached',
            items: [
              {
                type: 'userMessage',
                id: 'u_cached',
                content: [{ type: 'text', text: 'Hello cached' }],
              },
              {
                type: 'agentMessage',
                id: 'a_cached',
                text: 'Hi cached',
              },
            ],
          },
        ],
      },
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const chat = await client.getChat('thr_cached');
    expect(chat.messages.map((message) => message.content)).toEqual([
      'Hello cached',
      'Hi cached',
    ]);

    ws.request.mockClear();
    const cached = await client.getChat('thr_cached', { cacheTtlMs: 30_000 });

    expect(ws.request).not.toHaveBeenCalled();
    expect(cached.messages.map((message) => message.content)).toEqual([
      'Hello cached',
      'Hi cached',
    ]);
    expect(client.peekChat('thr_cached')?.messages).toHaveLength(2);
  });

  it('getChat() retries when Codex has created an empty rollout file', async () => {
    jest.useFakeTimers();
    try {
      const ws = createWsMock();
      ws.request
        .mockRejectedValueOnce(
          new RpcRequestError(
            'thread/read',
            -32603,
            'failed to read thread: thread-store internal error: failed to read thread /Users/mohitpatil/.codex/sessions/2026/05/06/rollout-2026-05-06T22-21-30-019dfe33-a320-7ae2-b86b-dd86d35f665b.jsonl: rollout at /Users/mohitpatil/.codex/sessions/2026/05/06/rollout-2026-05-06T22-21-30-019dfe33-a320-7ae2-b86b-dd86d35f665b.jsonl is empty'
          )
        )
        .mockResolvedValueOnce({
          thread: {
            id: 'codex:019dfe33-a320-7ae2-b86b-dd86d35f665b',
            preview: 'ready',
            createdAt: 1700000000,
            updatedAt: 1700000001,
            status: { type: 'idle' },
            turns: [],
          },
        });

      const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
      const chatPromise = client.getChat('codex:019dfe33-a320-7ae2-b86b-dd86d35f665b');

      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(50);
      const chat = await chatPromise;

      expect(chat.id).toBe('codex:019dfe33-a320-7ae2-b86b-dd86d35f665b');
      expect(ws.request).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('getChatSummaries() hydrates loaded threads with bounded concurrency', async () => {
    const ws = createWsMock();
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    ws.request.mockImplementation(async (_method, params) => {
      const threadId = (params as { threadId: string }).threadId;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
      return {
        thread: {
          id: threadId,
          preview: threadId,
          createdAt: 1700000000,
          updatedAt: 1700000001,
          status: { type: 'idle' },
          turns: [],
        },
      };
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const summariesPromise = client.getChatSummaries(['thr_a', 'thr_b', 'thr_a', 'thr_c'], {
      concurrency: 2,
    });

    await Promise.resolve();
    expect(ws.request).toHaveBeenCalledTimes(2);

    releaseGate();
    const summaries = await summariesPromise;

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(summaries.map((summary) => summary.id)).toEqual(['thr_a', 'thr_b', 'thr_c']);
    expect(ws.request).toHaveBeenCalledTimes(3);
  });

  it('listChats() treats idle thread status as complete even with stale inProgress turn', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      data: [
        {
          id: 'thr_idle_with_stale_turn',
          preview: 'done',
          createdAt: 1700000000,
          updatedAt: 1700000001,
          status: { type: 'idle' },
          turns: [
            {
              status: 'inProgress',
              items: [],
            },
          ],
        },
      ],
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const chats = await client.listChats();

    expect(chats).toHaveLength(1);
    expect(chats[0].status).toBe('complete');
  });

  it('listChats() excludes sub-agent source kinds defensively', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      data: [
        {
          id: 'thr_root',
          preview: 'root chat',
          createdAt: 1700000000,
          updatedAt: 1700000001,
          status: { type: 'idle' },
          source: 'appServer',
          turns: [],
        },
        {
          id: 'thr_sub',
          preview: 'spawned worker',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: 'thr_root',
                depth: 1,
              },
            },
          },
          turns: [],
        },
        {
          id: 'thr_sub_legacy',
          preview: 'legacy sub-agent',
          createdAt: 1700000000,
          updatedAt: 1700000003,
          status: { type: 'idle' },
          source: { kind: 'subAgent' },
          turns: [],
        },
      ],
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const chats = await client.listChats();

    expect(chats.map((chat) => chat.id)).toEqual(['thr_root']);
  });

  it('listChats() can include sub-agent source kinds when requested', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      data: [
        {
          id: 'thr_root',
          preview: 'root chat',
          createdAt: 1700000000,
          updatedAt: 1700000001,
          status: { type: 'idle' },
          source: 'appServer',
          turns: [],
        },
        {
          id: 'thr_sub',
          preview: 'spawned worker',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: 'thr_root',
                depth: 1,
              },
            },
          },
          turns: [],
        },
      ],
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const chats = await client.listChats({ includeSubAgents: true });

    expect(ws.request).toHaveBeenCalledWith('thread/list', {
      cursor: null,
      limit: 50,
      sortKey: 'updated_at',
      modelProviders: null,
      sourceKinds: [
        'cli',
        'vscode',
        'exec',
        'appServer',
        'unknown',
        'subAgent',
        'subAgentReview',
        'subAgentCompact',
        'subAgentThreadSpawn',
        'subAgentOther',
      ],
      archived: false,
      cwd: null,
    });
    expect(chats.map((chat) => chat.id)).toEqual(['thr_sub', 'thr_root']);
    expect(chats[0].parentThreadId).toBe('thr_root');
    expect(chats[0].subAgentDepth).toBe(1);
  });

  it('listLoadedChatIds() returns loaded in-memory thread ids', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      data: ['thr_root', 'thr_sub', null, ''],
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const ids = await client.listLoadedChatIds();

    expect(ws.request).toHaveBeenCalledWith('thread/loaded/list', undefined);
    expect(ids).toEqual(['thr_root', 'thr_sub']);
  });

  it('listWorkspaceRoots() requests bridge/workspaces/list and maps workspaces', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      bridgeRoot: '/Users/mohit/work',
      allowOutsideRootCwd: true,
      workspaces: [
        { path: '/Users/mohit/work/app', chatCount: 3, updatedAt: 1700000000 },
        { path: '/Users/mohit/work/docs', chatCount: '1', updatedAt: '1700001000' },
        { path: '', chatCount: 99, updatedAt: 1700002000 },
      ],
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.listWorkspaceRoots();

    expect(ws.request).toHaveBeenCalledWith('bridge/workspaces/list', { limit: 200 });
    expect(result).toEqual({
      bridgeRoot: '/Users/mohit/work',
      allowOutsideRootCwd: true,
      workspaces: [
        {
          path: '/Users/mohit/work/app',
          chatCount: 3,
          updatedAt: new Date(1700000000 * 1000).toISOString(),
        },
        {
          path: '/Users/mohit/work/docs',
          chatCount: 1,
          updatedAt: new Date(1700001000 * 1000).toISOString(),
        },
      ],
    });
  });

  it('listFilesystemEntries() requests bridge/fs/list with directory browsing defaults', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      bridgeRoot: '/Users/mohit/work',
      path: '/Users/mohit/work',
      parentPath: '/Users/mohit',
      truncated: true,
      totalEntries: 3,
      omittedEntries: 2,
      maxEntries: 1,
      entries: [
        {
          name: 'apps',
          path: '/Users/mohit/work/apps',
          kind: 'directory',
          hidden: false,
          selectable: true,
          isGitRepo: false,
        },
      ],
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.listFilesystemEntries({ path: '/Users/mohit/work' });

    expect(ws.request).toHaveBeenCalledWith('bridge/fs/list', {
      path: '/Users/mohit/work',
      includeHidden: false,
      directoriesOnly: true,
    });
    expect(result).toEqual({
      bridgeRoot: '/Users/mohit/work',
      path: '/Users/mohit/work',
      parentPath: '/Users/mohit',
      truncated: true,
      totalEntries: 3,
      omittedEntries: 2,
      maxEntries: 1,
      entries: [
        {
          name: 'apps',
          path: '/Users/mohit/work/apps',
          kind: 'directory',
          hidden: false,
          selectable: true,
          isGitRepo: false,
        },
      ],
    });
  });

  it('createBrowserPreviewSession() requests bridge/browser/session/create', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      sessionId: 'preview-1',
      targetUrl: 'http://127.0.0.1:3000/',
      previewPort: 8788,
      previewBaseUrl: 'https://octocat-8788.app.github.dev',
      bootstrapPath: '/?sid=preview-1&st=secret',
      createdAt: '2026-01-01T00:00:00Z',
      lastAccessedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-01-01T00:30:00Z',
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.createBrowserPreviewSession('http://127.0.0.1:3000/');

    expect(ws.request).toHaveBeenCalledWith('bridge/browser/session/create', {
      targetUrl: 'http://127.0.0.1:3000/',
    });
    expect(result.previewPort).toBe(8788);
    expect(result.previewBaseUrl).toBe('https://octocat-8788.app.github.dev');
    expect(result.bootstrapPath).toBe('/?sid=preview-1&st=secret');
    expect(result.expiresAt).toBe('2026-01-01T00:30:00.000Z');
  });

  it('discoverBrowserPreviewTargets() maps bridge/browser/targets/discover', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      scannedAt: '2026-01-01T00:00:00Z',
      suggestions: [
        {
          targetUrl: 'http://127.0.0.1:3000/',
          port: 3000,
          label: 'Local dev server on :3000',
        },
      ],
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.discoverBrowserPreviewTargets();

    expect(ws.request).toHaveBeenCalledWith('bridge/browser/targets/discover');
    expect(result.suggestions).toEqual([
      {
        targetUrl: 'http://127.0.0.1:3000/',
        port: 3000,
        label: 'Local dev server on :3000',
      },
    ]);
  });

  it('sendChatMessage() starts a turn without waiting for completion', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({}) // thread/resume
      .mockResolvedValueOnce({ turn: { id: 'turn_1' } }) // turn/start
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_1',
          preview: 'final',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn_1',
              items: [
                {
                  type: 'userMessage',
                  id: 'u1',
                  content: [{ type: 'text', text: 'Hello' }],
                },
                {
                  type: 'agentMessage',
                  id: 'a1',
                  text: 'Hi there',
                },
              ],
            },
          ],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const chat = await client.sendChatMessage('thr_1', { content: 'Hello' });

    expect(ws.request).toHaveBeenNthCalledWith(2, 'turn/start', expect.any(Object));
    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'turn/start',
      expect.objectContaining({ approvalPolicy: 'untrusted' })
    );
    expect(ws.waitForTurnCompletion).not.toHaveBeenCalled();
    expect(chat.id).toBe('thr_1');
    expect(chat.messages.length).toBeGreaterThan(0);
  });

  it('sendChatMessage() uses cached Cursor cwd when the request omits cwd', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({}) // thread/resume
      .mockResolvedValueOnce({ turn: { id: 'turn_cursor' } }) // turn/start
      .mockResolvedValueOnce({
        thread: {
          id: 'cursor-agent-launchkit',
          engine: 'cursor',
          preview: 'Hello',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          cwd: '/workspace/launchkit',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn_cursor',
              items: [
                {
                  type: 'userMessage',
                  id: 'u1',
                  content: [{ type: 'text', text: 'Hello' }],
                },
              ],
            },
          ],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    client.rememberChats([
      {
        id: 'cursor-agent-launchkit',
        title: 'LaunchKit',
        createdAt: '2023-11-14T22:13:20.000Z',
        updatedAt: '2023-11-14T22:13:22.000Z',
        statusUpdatedAt: '2023-11-14T22:13:22.000Z',
        status: 'complete',
        lastMessagePreview: 'LaunchKit',
        engine: 'cursor',
        cwd: '/workspace/launchkit',
      },
    ]);

    await client.sendChatMessage('cursor-agent-launchkit', { content: 'Hello' });

    expect(ws.request).toHaveBeenNthCalledWith(
      1,
      'thread/resume',
      expect.objectContaining({ cwd: '/workspace/launchkit' })
    );
    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'turn/start',
      expect.objectContaining({ cwd: '/workspace/launchkit' })
    );
  });

  it('sendChatMessage() retries thread/read until sent user message is materialized', async () => {
    jest.useFakeTimers();
    try {
      const ws = createWsMock();
      ws.request
        .mockResolvedValueOnce({}) // thread/resume
        .mockResolvedValueOnce({ turn: { id: 'turn_retry' } }) // turn/start
        .mockResolvedValueOnce({
          thread: {
            id: 'thr_retry',
            preview: 'stale',
            createdAt: 1700000000,
            updatedAt: 1700000001,
            status: { type: 'idle' },
            turns: [],
          },
        }) // stale thread/read (missing latest user item)
        .mockResolvedValueOnce({
          thread: {
            id: 'thr_retry',
            preview: 'Hello',
            createdAt: 1700000000,
            updatedAt: 1700000002,
            status: { type: 'idle' },
              turns: [
                {
                  id: 'turn_retry',
                  items: [
                    {
                      type: 'userMessage',
                      id: 'u_retry',
                    content: [{ type: 'text', text: 'Hello' }],
                  },
                ],
              },
            ],
          },
        }); // retried thread/read

      const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
      const chatPromise = client.sendChatMessage('thr_retry', { content: 'Hello' });

      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(200);
      const chat = await chatPromise;

      expect(chat.messages.some((message) => message.role === 'user' && message.content === 'Hello')).toBe(true);
      expect(ws.request).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({
          threadId: 'thr_retry',
        })
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('sendChatMessage() keeps a repeated user prompt when the new turn is missing from thread/read', async () => {
    jest.useFakeTimers();
    try {
      const ws = createWsMock();
      const staleReadResponse = {
        thread: {
          id: 'thr_repeat',
          preview: 'repeat',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn_old',
              items: [
                {
                  type: 'userMessage',
                  id: 'u_old_repeat',
                  content: [{ type: 'text', text: 'repeat' }],
                },
                {
                  type: 'agentMessage',
                  id: 'a_old_repeat',
                  text: 'old answer',
                },
              ],
            },
          ],
        },
      };

      ws.request
        .mockResolvedValueOnce({}) // thread/resume
        .mockResolvedValueOnce({ turn: { id: 'turn_new_repeat' } }) // turn/start
        .mockResolvedValue(staleReadResponse); // thread/read retries always stale

      const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
      const chatPromise = client.sendChatMessage('thr_repeat', { content: 'repeat' });

      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(2_000);
      const chat = await chatPromise;

      const repeatedUserMessages = chat.messages.filter(
        (message) => message.role === 'user' && message.content === 'repeat'
      );
      expect(repeatedUserMessages.length).toBeGreaterThanOrEqual(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('createChat() forwards selected model to thread/start', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_model',
          preview: '',
          createdAt: 1700000000,
          updatedAt: 1700000000,
          status: { type: 'idle' },
          turns: [],
        },
      })
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_model',
          preview: '',
          createdAt: 1700000000,
          updatedAt: 1700000000,
          status: { type: 'idle' },
          turns: [],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.createChat({ model: 'gpt-5.3-codex' });

    expect(ws.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        model: 'gpt-5.3-codex',
      })
    );
  });

  it('createChat() forwards selected engine to thread/start', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValueOnce({
      thread: {
        id: 'opencode:ses_new',
        preview: '',
        createdAt: 1700000000,
        updatedAt: 1700000000,
        status: { type: 'idle' },
        turns: [],
      },
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.createChat({ engine: 'opencode' });

    expect(ws.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        engine: 'opencode',
      })
    );
  });

  it('createChat() forwards Cursor as a selected engine to thread/start', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValueOnce({
      thread: {
        id: 'cursor:agt_new',
        preview: '',
        createdAt: 1700000000,
        updatedAt: 1700000000,
        status: { type: 'idle' },
        turns: [],
      },
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.createChat({ engine: 'cursor' });

    expect(ws.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        engine: 'cursor',
      })
    );
  });

  it('createChat() forwards selected approval policy to thread/start', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValueOnce({
      thread: {
        id: 'thr_policy',
        preview: '',
        createdAt: 1700000000,
        updatedAt: 1700000000,
        status: { type: 'idle' },
        turns: [],
      },
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.createChat({ approvalPolicy: 'never' });

    expect(ws.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        approvalPolicy: 'never',
      })
    );
  });

  it('createChat() sends untrusted approval policy when none is selected', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValueOnce({
      thread: {
        id: 'thr_default_policy',
        preview: '',
        createdAt: 1700000000,
        updatedAt: 1700000000,
        status: { type: 'idle' },
        turns: [],
      },
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.createChat({});

    expect(ws.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({ approvalPolicy: 'untrusted' })
    );
  });

  it('createChat() requests danger-full-access sandbox by default', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValueOnce({
      thread: {
        id: 'thr_sandbox',
        preview: '',
        createdAt: 1700000000,
        updatedAt: 1700000000,
        status: { type: 'idle' },
        turns: [],
      },
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.createChat({});

    expect(ws.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        sandbox: 'danger-full-access',
      })
    );
  });

  it('createChat() forwards service tier in thread/start config', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValueOnce({
      thread: {
        id: 'thr_fast',
        preview: '',
        createdAt: 1700000000,
        updatedAt: 1700000000,
        status: { type: 'idle' },
        turns: [],
      },
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.createChat({ serviceTier: 'fast' });

    expect(ws.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        config: {
          service_tier: 'fast',
        },
      })
    );
  });

  it('forkChat() forwards service tier in thread/fork config', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValueOnce({
      thread: {
        id: 'thr_fork_fast',
        preview: '',
        createdAt: 1700000000,
        updatedAt: 1700000000,
        status: { type: 'idle' },
        turns: [],
      },
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.forkChat('thr_parent', { serviceTier: 'fast' });

    expect(ws.request).toHaveBeenCalledWith(
      'thread/fork',
      expect.objectContaining({
        threadId: 'thr_parent',
        approvalPolicy: 'untrusted',
        config: {
          service_tier: 'fast',
        },
      })
    );
  });

  it('compactChat() calls thread/compact/start with the thread id', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({});

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.compactChat('opencode:session-1');

    expect(ws.request).toHaveBeenCalledWith('thread/compact/start', {
      threadId: 'opencode:session-1',
    });
  });

  it('reviewChat() resumes with an explicit policy before starting review', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({});

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.reviewChat('thr_review');

    expect(ws.request).toHaveBeenNthCalledWith(
      1,
      'thread/resume',
      expect.objectContaining({
        threadId: 'thr_review',
        approvalPolicy: 'untrusted',
      })
    );
    expect(ws.request).toHaveBeenNthCalledWith(2, 'review/start', {
      threadId: 'thr_review',
      target: { type: 'uncommittedChanges' },
      delivery: 'inline',
    });
  });

  it('reviewChat() preserves explicitly selected YOLO policy', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({});

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.reviewChat('thr_review_yolo', 'never');

    expect(ws.request).toHaveBeenNthCalledWith(
      1,
      'thread/resume',
      expect.objectContaining({ approvalPolicy: 'never' })
    );
  });

  it('forkChat() requests danger-full-access sandbox by default', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValueOnce({
      thread: {
        id: 'thr_fork_sandbox',
        preview: '',
        createdAt: 1700000000,
        updatedAt: 1700000000,
        status: { type: 'idle' },
        turns: [],
      },
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.forkChat('thr_parent');

    expect(ws.request).toHaveBeenCalledWith(
      'thread/fork',
      expect.objectContaining({
        threadId: 'thr_parent',
        sandbox: 'danger-full-access',
      })
    );
  });

  it('renameChat() retries with threadName when name payload is rejected', async () => {
    const ws = createWsMock();
    ws.request
      .mockRejectedValueOnce(
        new RpcRequestError('thread/name/set', -32602, 'missing field `threadName`')
      )
      .mockResolvedValueOnce({}) // thread/name/set retry with threadName
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_rename',
          preview: '',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          name: 'Renamed Chat',
          turns: [],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const renamed = await client.renameChat('thr_rename', 'Renamed Chat');

    expect(ws.request).toHaveBeenNthCalledWith(1, 'thread/name/set', {
      threadId: 'thr_rename',
      name: 'Renamed Chat',
    });
    expect(ws.request).toHaveBeenNthCalledWith(2, 'thread/name/set', {
      threadId: 'thr_rename',
      threadName: 'Renamed Chat',
    });
    expect(ws.request).toHaveBeenCalledTimes(3);
    expect(renamed.title).toBe('Renamed Chat');
  });

  it('renameChat() does not repeat a successful name update', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        thread: {
          id: 'opencode:session-1',
          preview: '',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          name: 'Renamed Chat',
          turns: [],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.renameChat('opencode:session-1', 'Renamed Chat');

    expect(ws.request).toHaveBeenCalledTimes(2);
    expect(ws.request).toHaveBeenNthCalledWith(1, 'thread/name/set', {
      threadId: 'opencode:session-1',
      name: 'Renamed Chat',
    });
  });

  it('sendChatMessage() forwards selected model/effort to turn/start', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({}) // thread/resume
      .mockResolvedValueOnce({ turn: { id: 'turn_model' } }) // turn/start
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_model',
          preview: 'done',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn_model',
              items: [
                {
                  type: 'userMessage',
                  id: 'u1',
                  content: [{ type: 'text', text: 'hello' }],
                },
                {
                  type: 'agentMessage',
                  id: 'a1',
                  text: 'ok',
                },
              ],
            },
          ],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.sendChatMessage('thr_model', {
      content: 'hello',
      model: 'gpt-5.3-codex',
      effort: 'high',
    });

    expect(ws.request).toHaveBeenNthCalledWith(1, 'thread/resume', expect.any(Object));
    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'turn/start',
      expect.objectContaining({
        model: 'gpt-5.3-codex',
        effort: 'high',
      })
    );
  });

  it('sendChatMessage() forwards service tier to turn/start', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({}) // thread/resume
      .mockResolvedValueOnce({ turn: { id: 'turn_fast' } }) // turn/start
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_fast',
          preview: 'done',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn_fast',
              items: [
                {
                  type: 'userMessage',
                  id: 'u_fast',
                  content: [{ type: 'text', text: 'hello' }],
                },
                {
                  type: 'agentMessage',
                  id: 'a_fast',
                  text: 'ok',
                },
              ],
            },
          ],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.sendChatMessage('thr_fast', {
      content: 'hello',
      serviceTier: 'fast',
    });

    expect(ws.request).toHaveBeenNthCalledWith(1, 'thread/resume', expect.any(Object));
    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'turn/start',
      expect.objectContaining({
        serviceTier: 'fast',
      })
    );
  });

  it('steerChatTurn() forwards expected turn id and structured input', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValueOnce({});

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.steerChatTurn('thr_steer', 'turn_steer', {
      content: 'continue with this direction',
      mentions: [{ path: '/tmp/src', name: 'src' }],
      localImages: [{ path: '/tmp/screenshot.png' }],
    });

    expect(ws.request).toHaveBeenCalledWith(
      'turn/steer',
      expect.objectContaining({
        threadId: 'thr_steer',
        expectedTurnId: 'turn_steer',
        input: [
          {
            type: 'text',
            text: 'continue with this direction',
            text_elements: [],
          },
          {
            type: 'mention',
            path: '/tmp/src',
            name: 'src',
          },
          {
            type: 'localImage',
            path: '/tmp/screenshot.png',
          },
        ],
      })
    );
  });

  it('readThreadQueue() requests bridge/thread/queue/read', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValueOnce({
      threadId: 'thr_queue',
      items: [{ id: 'queue_1', createdAt: '2026-04-08T00:00:00.000Z', content: 'hello' }],
      lastError: null,
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.readThreadQueue('thr_queue');

    expect(ws.request).toHaveBeenCalledWith('bridge/thread/queue/read', {
      threadId: 'thr_queue',
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.content).toBe('hello');
  });

  it('sendOrQueueChatMessage() queues through bridge when runtime is busy', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({}) // thread/resume
      .mockResolvedValueOnce({
        disposition: 'queued',
        queue: {
          threadId: 'thr_queue',
          items: [
            {
              id: 'queue_1',
              createdAt: '2026-04-08T00:00:00.000Z',
              content: 'hello',
            },
          ],
          lastError: null,
        },
        turnId: null,
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.sendOrQueueChatMessage('thr_queue', {
      content: 'hello',
      mentions: [{ path: '/tmp/src', name: 'src' }],
      localImages: [{ path: '/tmp/screenshot.png' }],
    });

    expect(ws.request).toHaveBeenNthCalledWith(1, 'thread/resume', expect.any(Object));
    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'bridge/thread/queue/send',
      expect.objectContaining({
        threadId: 'thr_queue',
        content: 'hello',
        turnStart: expect.objectContaining({
          threadId: 'thr_queue',
          approvalPolicy: 'untrusted',
          input: [
            {
              type: 'text',
              text: 'hello',
              text_elements: [],
            },
            {
              type: 'mention',
              path: '/tmp/src',
              name: 'src',
            },
            {
              type: 'localImage',
              path: '/tmp/screenshot.png',
            },
          ],
        }),
      })
    );
    expect(result).toMatchObject({
      disposition: 'queued',
      turnId: null,
      chat: null,
    });
    expect(result.queue.items).toHaveLength(1);
  });

  it('sendOrQueueChatMessage() can skip thread resume for known-local queued sends', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValueOnce({
      disposition: 'queued',
      queue: {
        threadId: 'thr_queue',
        items: [
          {
            id: 'queue_1',
            createdAt: '2026-04-08T00:00:00.000Z',
            content: 'hello',
          },
        ],
        lastError: null,
      },
      turnId: null,
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.sendOrQueueChatMessage(
      'thr_queue',
      {
        content: 'hello',
        cwd: '/tmp/project',
        model: 'gpt-5.4',
        effort: 'medium',
        approvalPolicy: 'untrusted',
        collaborationMode: 'default',
      },
      {
        skipResume: true,
      }
    );

    expect(ws.request).toHaveBeenCalledTimes(1);
    expect(ws.request).toHaveBeenCalledWith(
      'bridge/thread/queue/send',
      expect.objectContaining({
        threadId: 'thr_queue',
        content: 'hello',
        turnStart: expect.objectContaining({
          threadId: 'thr_queue',
          approvalPolicy: 'untrusted',
          cwd: '/tmp/project',
          model: 'gpt-5.4',
          effort: 'medium',
        }),
      })
    );
    expect(result.disposition).toBe('queued');
  });

  it('sendOrQueueChatMessage() returns chat when bridge starts a turn immediately', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({}) // thread/resume
      .mockResolvedValueOnce({
        disposition: 'sent',
        queue: {
          threadId: 'thr_sent',
          items: [],
          lastError: null,
        },
        turnId: 'turn_sent',
      })
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_sent',
          preview: 'done',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn_sent',
              items: [
                {
                  type: 'userMessage',
                  id: 'u_sent',
                  content: [{ type: 'text', text: 'hello' }],
                },
                {
                  type: 'agentMessage',
                  id: 'a_sent',
                  text: 'ok',
                },
              ],
            },
          ],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const result = await client.sendOrQueueChatMessage('thr_sent', {
      content: 'hello',
    });

    expect(ws.request).toHaveBeenNthCalledWith(1, 'thread/resume', expect.any(Object));
    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'bridge/thread/queue/send',
      expect.objectContaining({
        threadId: 'thr_sent',
      })
    );
    expect(ws.request).toHaveBeenNthCalledWith(3, 'thread/read', {
      threadId: 'thr_sent',
      includeTurns: true,
    });
    expect(result.disposition).toBe('sent');
    expect(result.turnId).toBe('turn_sent');
    expect(result.chat?.messages[0]?.content).toBe('hello');
  });

  it('queued message actions call bridge queue endpoints', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({ ok: true, queue: { threadId: 'thr_queue', items: [], lastError: null } })
      .mockResolvedValueOnce({ ok: true, queue: { threadId: 'thr_queue', items: [], lastError: null } });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.steerQueuedThreadMessage('thr_queue', 'queue_1');
    await client.cancelQueuedThreadMessage('thr_queue', 'queue_1');

    expect(ws.request).toHaveBeenNthCalledWith(1, 'bridge/thread/queue/steer', {
      threadId: 'thr_queue',
      itemId: 'queue_1',
    });
    expect(ws.request).toHaveBeenNthCalledWith(2, 'bridge/thread/queue/cancel', {
      threadId: 'thr_queue',
      itemId: 'queue_1',
    });
  });

  it('sendChatMessage() forwards selected approval policy to resume and turn/start', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({}) // thread/resume
      .mockResolvedValueOnce({ turn: { id: 'turn_policy' } }) // turn/start
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_policy_turn',
          preview: 'done',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn_policy',
              items: [
                {
                  type: 'userMessage',
                  id: 'u_policy',
                  content: [{ type: 'text', text: 'hello' }],
                },
              ],
            },
          ],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.sendChatMessage('thr_policy_turn', {
      content: 'hello',
      approvalPolicy: 'never',
    });

    expect(ws.request).toHaveBeenNthCalledWith(
      1,
      'thread/resume',
      expect.objectContaining({
        approvalPolicy: 'never',
      })
    );
    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'turn/start',
      expect.objectContaining({
        approvalPolicy: 'never',
      })
    );
  });

  it('resumeThread() does not retry invalid current-contract parameters', async () => {
    const ws = createWsMock();
    const invalidParamsError = new RpcRequestError(
      'thread/resume',
      -32602,
      'unknown field `experimentalRawEvents`'
    );
    ws.request.mockRejectedValueOnce(invalidParamsError);

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await expect(client.resumeThread('thr_resume')).rejects.toBe(invalidParamsError);

    expect(ws.request).toHaveBeenCalledWith(
      'thread/resume',
      expect.objectContaining({
        threadId: 'thr_resume',
        experimentalRawEvents: true,
        approvalPolicy: 'untrusted',
        sandbox: 'danger-full-access',
      })
    );
    expect(ws.request).toHaveBeenCalledTimes(1);
  });

  it('sendChatMessage() aborts before turn/start when resume fails', async () => {
    const ws = createWsMock();
    const backendError = new RpcRequestError(
      'thread/resume',
      -32603,
      'app-server unavailable',
      { backend: 'codex' }
    );
    ws.request.mockRejectedValueOnce(backendError);

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await expect(
      client.sendChatMessage('thr_resume_failure', {
        content: 'do not weaken policy',
        approvalPolicy: 'never',
      })
    ).rejects.toBe(backendError);

    expect(ws.request).toHaveBeenCalledWith(
      'thread/resume',
      expect.objectContaining({
        threadId: 'thr_resume_failure',
        approvalPolicy: 'never',
      })
    );
    expect(ws.request).toHaveBeenCalledTimes(1);
  });

  it('resumeThread() does not retry backend failures as compatibility errors', async () => {
    const ws = createWsMock();
    const backendError = new RpcRequestError(
      'thread/resume',
      -32603,
      'app-server unavailable',
      { backend: 'codex' }
    );
    ws.request.mockRejectedValueOnce(backendError);

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });

    await expect(client.resumeThread('thr_backend_failure')).rejects.toBe(backendError);
    expect(ws.request).toHaveBeenCalledTimes(1);
  });

  it('sendChatMessage() forwards mention and local-image attachments to turn/start input', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({}) // thread/resume
      .mockResolvedValueOnce({ turn: { id: 'turn_mentions' } }) // turn/start
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_mentions',
          preview: 'done',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn_mentions',
              items: [
                {
                  type: 'userMessage',
                  id: 'u_mentions',
                  content: [
                    { type: 'text', text: 'review these files' },
                    {
                      type: 'mention',
                      path: 'apps/mobile/src/screens/MainScreen.tsx',
                      name: 'MainScreen.tsx',
                    },
                    {
                      type: 'mention',
                      path: 'apps/mobile/src/api/client.ts',
                      name: 'client.ts',
                    },
                    {
                      type: 'localImage',
                      path: '.clawdex-mobile-attachments/example.png',
                    },
                  ],
                },
              ],
            },
          ],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.sendChatMessage('thr_mentions', {
      content: 'review these files',
      mentions: [
        { path: 'apps/mobile/src/screens/MainScreen.tsx' },
        { path: 'apps/mobile/src/api/client.ts', name: 'client.ts' },
      ],
      localImages: [{ path: '.clawdex-mobile-attachments/example.png' }],
    });

    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'turn/start',
      expect.objectContaining({
        input: expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: 'review these files',
          }),
          expect.objectContaining({
            type: 'mention',
            path: 'apps/mobile/src/screens/MainScreen.tsx',
            name: 'MainScreen.tsx',
          }),
          expect.objectContaining({
            type: 'mention',
            path: 'apps/mobile/src/api/client.ts',
            name: 'client.ts',
          }),
          expect.objectContaining({
            type: 'localImage',
            path: '.clawdex-mobile-attachments/example.png',
          }),
        ]),
      })
    );
  });

  it('uploadAttachment() uses authenticated file-backed multipart upload', async () => {
    const ws = createWsMock();
    const uploadAsync = FileSystem.uploadAsync as jest.MockedFunction<typeof FileSystem.uploadAsync>;
    uploadAsync.mockResolvedValue({
      status: 201,
      headers: {},
      mimeType: 'application/json',
      body: JSON.stringify({
        path: '.clawdex-mobile-attachments/file.txt',
        fileName: 'file.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        kind: 'file',
      }),
    });

    const client = new HostBridgeApiClient({
      ws: ws as unknown as HostBridgeWsClient,
      bridgeUrl: 'http://bridge:8787/',
      authToken: 'secret',
    });
    const uploaded = await client.uploadAttachment({
      uri: 'file:///cache/file.txt',
      fileName: 'file.txt',
      mimeType: 'text/plain',
      kind: 'file',
    });

    expect(uploadAsync).toHaveBeenCalledWith('http://bridge:8787/attachments', 'file:///cache/file.txt', {
      fieldName: 'file',
      headers: { Authorization: 'Bearer secret' },
      httpMethod: 'POST',
      mimeType: 'text/plain',
      parameters: { fileName: 'file.txt', kind: 'file', mimeType: 'text/plain' },
      sessionType: 1,
      uploadType: 1,
    });
    expect(ws.request).not.toHaveBeenCalled();
    expect(uploaded.path).toBe('.clawdex-mobile-attachments/file.txt');
  });

  it('interruptTurn() calls turn/interrupt with thread and turn id', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({});

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.interruptTurn('thr_stop', 'turn_stop');

    expect(ws.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thr_stop',
      turnId: 'turn_stop',
    });
  });

  it('interruptLatestTurn() resolves and interrupts the latest active turn', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_active',
          preview: 'working',
          createdAt: 1700000000,
          updatedAt: 1700000001,
          status: { type: 'active' },
          turns: [
            {
              id: 'turn_done',
              status: 'completed',
              items: [],
            },
            {
              id: 'turn_live',
              status: 'inProgress',
              items: [],
            },
          ],
        },
      })
      .mockResolvedValueOnce({});

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const turnId = await client.interruptLatestTurn('thr_active');

    expect(turnId).toBe('turn_live');
    expect(ws.request).toHaveBeenNthCalledWith(1, 'thread/read', {
      threadId: 'thr_active',
      includeTurns: true,
    });
    expect(ws.request).toHaveBeenNthCalledWith(2, 'turn/interrupt', {
      threadId: 'thr_active',
      turnId: 'turn_live',
    });
  });

  it('interruptLatestTurn() returns null when there is no active turn', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValueOnce({
      thread: {
        id: 'thr_idle',
        preview: 'done',
        createdAt: 1700000000,
        updatedAt: 1700000001,
        status: { type: 'idle' },
        turns: [
          {
            id: 'turn_done',
            status: 'completed',
            items: [],
          },
        ],
      },
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const turnId = await client.interruptLatestTurn('thr_idle');

    expect(turnId).toBeNull();
    expect(ws.request).toHaveBeenCalledTimes(1);
    expect(ws.request).toHaveBeenNthCalledWith(1, 'thread/read', {
      threadId: 'thr_idle',
      includeTurns: true,
    });
  });

  it('sendChatMessage() sends structured collaborationMode for plan mode', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({}) // thread/resume
      .mockResolvedValueOnce({ turn: { id: 'turn_plan' } }) // turn/start
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_plan',
          preview: 'done',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn_plan',
              items: [
                {
                  type: 'userMessage',
                  id: 'u_plan',
                  content: [{ type: 'text', text: 'hello' }],
                },
              ],
            },
          ],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.sendChatMessage('thr_plan', {
      content: 'hello',
      model: 'gpt-5.3-codex',
      effort: 'high',
      collaborationMode: 'plan',
    });

    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'turn/start',
      expect.objectContaining({
        approvalPolicy: 'untrusted',
        model: 'gpt-5.3-codex',
        effort: 'high',
        collaborationMode: {
          mode: 'plan',
          settings: {
            model: 'gpt-5.3-codex',
            reasoning_effort: 'high',
            developer_instructions: null,
          },
        },
      })
    );
  });

  it('sendChatMessage() sends structured collaborationMode for default mode using resumed thread settings', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({
        model: 'gpt-5.3-codex',
        reasoningEffort: 'medium',
      }) // thread/resume
      .mockResolvedValueOnce({ turn: { id: 'turn_default' } }) // turn/start
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_default',
          preview: 'done',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn_default',
              items: [
                {
                  type: 'userMessage',
                  id: 'u_default',
                  content: [{ type: 'text', text: 'implement it' }],
                },
              ],
            },
          ],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.sendChatMessage('thr_default', {
      content: 'implement it',
      collaborationMode: 'default',
    });

    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'turn/start',
      expect.objectContaining({
        model: 'gpt-5.3-codex',
        effort: 'medium',
        collaborationMode: {
          mode: 'default',
          settings: {
            model: 'gpt-5.3-codex',
            reasoning_effort: 'medium',
            developer_instructions: null,
          },
        },
      })
    );
  });

  it('sendChatMessage() sends Cursor ask mode for cached Cursor chats', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({}) // thread/resume
      .mockResolvedValueOnce({ turn: { id: 'turn_ask' } }) // turn/start
      .mockResolvedValueOnce({
        thread: {
          id: 'cursor-agent-ask',
          engine: 'cursor',
          preview: 'done',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          cwd: '/workspace/launchkit',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn_ask',
              items: [
                {
                  type: 'userMessage',
                  id: 'u_ask',
                  content: [{ type: 'text', text: 'what does this do?' }],
                },
              ],
            },
          ],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    client.rememberChats([
      {
        id: 'cursor-agent-ask',
        title: 'Cursor ask',
        createdAt: '2023-11-14T22:13:20.000Z',
        updatedAt: '2023-11-14T22:13:22.000Z',
        statusUpdatedAt: '2023-11-14T22:13:22.000Z',
        status: 'complete',
        lastMessagePreview: 'Cursor ask',
        engine: 'cursor',
        cwd: '/workspace/launchkit',
      },
    ]);

    await client.sendChatMessage('cursor-agent-ask', {
      content: 'what does this do?',
      model: 'composer-2',
      collaborationMode: 'ask',
    });

    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'turn/start',
      expect.objectContaining({
        model: 'composer-2',
        cwd: '/workspace/launchkit',
        collaborationMode: {
          mode: 'ask',
          settings: {
            model: 'composer-2',
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
      })
    );
  });

  it('sendChatMessage() resolves default model before plan mode turn when model is unset', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({}) // thread/resume
      .mockResolvedValueOnce({
        data: [
          {
            id: 'gpt-5.3-codex',
            displayName: 'GPT-5.3 Codex',
            isDefault: true,
          },
        ],
      }) // model/list fallback
      .mockResolvedValueOnce({ turn: { id: 'turn_plan_fallback' } }) // turn/start
      .mockResolvedValueOnce({
        thread: {
          id: 'thr_plan_fallback',
          preview: 'done',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn_plan_fallback',
              items: [
                {
                  type: 'userMessage',
                  id: 'u_plan_fallback',
                  content: [{ type: 'text', text: 'hello' }],
                },
              ],
            },
          ],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.sendChatMessage('thr_plan_fallback', {
      content: 'hello',
      collaborationMode: 'plan',
    });

    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'model/list',
      expect.objectContaining({
        includeHidden: false,
        threadId: 'thr_plan_fallback',
      })
    );
    expect(ws.request).toHaveBeenNthCalledWith(
      3,
      'turn/start',
      expect.objectContaining({
        model: 'gpt-5.3-codex',
        collaborationMode: {
          mode: 'plan',
          settings: {
            model: 'gpt-5.3-codex',
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
      })
    );
  });

  it('sendChatMessage() resolves plan-mode defaults from the cached chat engine', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({}) // thread/resume
      .mockResolvedValueOnce({
        data: [
          {
            id: 'composer-2',
            displayName: 'Composer 2',
            providerId: 'cursor',
            isDefault: true,
          },
        ],
      }) // model/list fallback
      .mockResolvedValueOnce({ turn: { id: 'turn_cursor_plan' } }) // turn/start
      .mockResolvedValueOnce({
        thread: {
          id: 'cursor-agent-plan',
          engine: 'cursor',
          preview: 'done',
          createdAt: 1700000000,
          updatedAt: 1700000002,
          cwd: '/workspace/launchkit',
          status: { type: 'idle' },
          turns: [
            {
              id: 'turn_cursor_plan',
              items: [
                {
                  type: 'userMessage',
                  id: 'u_cursor_plan',
                  content: [{ type: 'text', text: 'plan this' }],
                },
              ],
            },
          ],
        },
      });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    client.rememberChats([
      {
        id: 'cursor-agent-plan',
        title: 'Cursor plan',
        createdAt: '2023-11-14T22:13:20.000Z',
        updatedAt: '2023-11-14T22:13:22.000Z',
        statusUpdatedAt: '2023-11-14T22:13:22.000Z',
        status: 'complete',
        lastMessagePreview: 'Cursor plan',
        engine: 'cursor',
        cwd: '/workspace/launchkit',
      },
    ]);

    await client.sendChatMessage('cursor-agent-plan', {
      content: 'plan this',
      collaborationMode: 'plan',
    });

    expect(ws.request).toHaveBeenNthCalledWith(
      2,
      'model/list',
      expect.objectContaining({
        includeHidden: false,
        threadId: 'cursor-agent-plan',
        engine: 'cursor',
      })
    );
    expect(ws.request).toHaveBeenNthCalledWith(
      3,
      'turn/start',
      expect.objectContaining({
        model: 'composer-2',
        cwd: '/workspace/launchkit',
      })
    );
  });

  it('listModels() maps model/list response', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      data: [
        {
          id: 'gpt-5.3-codex',
          displayName: 'GPT-5.3 Codex',
          description: 'Default coding model',
          providerId: 'openai',
          providerName: 'OpenAI',
          contextWindow: '1m',
          connected: true,
          authRequired: false,
          hidden: false,
          supportsPersonality: true,
          isDefault: true,
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Lower latency' },
            { reasoningEffort: 'medium', description: 'Balanced' },
            { reasoningEffort: 'high', description: 'Higher depth' },
          ],
        },
      ],
    });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const models = await client.listModels();

    expect(ws.request).toHaveBeenCalledWith(
      'model/list',
      expect.objectContaining({
        includeHidden: false,
      })
    );
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('gpt-5.3-codex');
    expect(models[0].providerId).toBe('openai');
    expect(models[0].providerName).toBe('OpenAI');
    expect(models[0].contextWindow).toBe(1_000_000);
    expect(models[0].connected).toBe(true);
    expect(models[0].authRequired).toBe(false);
    expect(models[0].isDefault).toBe(true);
    expect(models[0].defaultReasoningEffort).toBe('medium');
    expect(models[0].reasoningEffort?.map((option) => option.effort)).toEqual([
      'low',
      'medium',
      'high',
    ]);
  });

  it('listModels() can request models for the selected chat engine', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({ data: [] });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.listModels(false, { threadId: 'opencode:ses_123' });

    expect(ws.request).toHaveBeenCalledWith(
      'model/list',
      expect.objectContaining({
        includeHidden: false,
        threadId: 'opencode:ses_123',
      })
    );
  });

  it('listModels() can request models for a pending new-chat engine', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({ data: [] });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.listModels(false, { engine: 'opencode' });

    expect(ws.request).toHaveBeenCalledWith(
      'model/list',
      expect.objectContaining({
        includeHidden: false,
        engine: 'opencode',
      })
    );
  });

  it('listModels() can request Cursor models for a pending new chat', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({ data: [] });

    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await client.listModels(false, { engine: 'cursor' });

    expect(ws.request).toHaveBeenCalledWith(
      'model/list',
      expect.objectContaining({
        includeHidden: false,
        engine: 'cursor',
      })
    );
  });

  it('forwards simple bridge, push, approval, UI, terminal, and git operations', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({ ok: true });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });

    await client.readBridgeCapabilities();
    await client.registerPushDevice({ profileId: 'p', registrationId: 'r', token: 't', platform: 'ios', deviceName: 'phone', events: { turnCompleted: true, approvalRequested: false } });
    await client.unregisterPushDevice({ profileId: 'p', registrationId: 'r' });
    await client.resolveApproval('approval', 'accept', 'resolution');
    await client.resolveUserInput('input', { answers: { question: { answers: ['yes'] } } });
    await client.resolveBridgeUiSurface('ui', { threadId: 'thr', actionId: 'accept' });
    await client.dismissBridgeUiSurface('ui');
    await client.execTerminal({ command: 'pwd' });
    await client.gitStatus(' /repo ');
    await client.gitDiff();
    await client.gitHistory('/repo', 4);
    await client.gitBranches();
    await client.gitStageAll();
    await client.gitUnstageAll('/repo');
    await client.gitCommit({ message: 'test', cwd: ' /repo ' });
    await client.gitPush();

    expect(ws.request).toHaveBeenCalledWith('bridge/capabilities/read');
    expect(ws.request).toHaveBeenCalledWith('bridge/git/status', { cwd: '/repo' });
    expect(ws.request).toHaveBeenCalledWith('bridge/git/diff', { cwd: null });
    expect(ws.request).toHaveBeenCalledWith('bridge/ui/dismiss', { id: 'ui', threadId: null });
  });

  it('normalizes GitHub grants and validates git mutation inputs', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({ installed: true });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });

    await client.installGitHubAuth({ accessToken: ' token ', repositories: [' a/b ', ''] });
    await client.installGitHubAuth({ grants: [{ accessToken: ' second ', repositories: undefined }, { accessToken: ' ', repositories: [] }] });
    expect(ws.request).toHaveBeenNthCalledWith(1, 'bridge/github/auth/install', { grants: [{ accessToken: 'token', repositories: ['a/b'] }] });
    expect(ws.request).toHaveBeenNthCalledWith(2, 'bridge/github/auth/install', { grants: [{ accessToken: 'second', repositories: [] }] });

    await expect(client.installGitHubAuth({ grants: [] })).rejects.toThrow('At least one');
    await expect(client.gitClone({ url: '', parentPath: '', directoryName: 'repo' })).rejects.toThrow('url must');
    await expect(client.gitClone({ url: 'url', parentPath: '', directoryName: '' })).rejects.toThrow('directoryName');
    await expect(client.gitStage({ path: ' ', cwd: '' })).rejects.toThrow('path must');
    await expect(client.gitUnstage({ path: '', cwd: '' })).rejects.toThrow('path must');
    await expect(client.gitSwitch({ branch: '', cwd: '' })).rejects.toThrow('branch must');

    await client.gitClone({ url: ' url ', parentPath: ' /parent ', directoryName: ' repo ' });
    await client.gitStage({ path: ' a.ts ', cwd: ' /repo ' });
    await client.gitUnstage({ path: ' a.ts ', cwd: undefined });
    await client.gitSwitch({ branch: ' main ', cwd: '/repo' });
    expect(ws.request).toHaveBeenCalledWith('bridge/git/clone', { url: 'url', parentPath: '/parent', directoryName: 'repo' });
  });

  it('covers account-rate-limit caching, force refresh, and in-flight deduplication', async () => {
    const ws = createWsMock();
    let resolveRequest: (value: unknown) => void = () => {};
    ws.request.mockImplementationOnce(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    expect(client.peekAccountRateLimits()).toBeNull();
    const first = client.readAccountRateLimits();
    const second = client.readAccountRateLimits();
    expect(ws.request).toHaveBeenCalledTimes(1);
    resolveRequest({ rateLimits: { primary: { usedPercent: 2 } } });
    await expect(first).resolves.toMatchObject({ primary: { usedPercent: 2 } });
    await expect(second).resolves.toMatchObject({ primary: { usedPercent: 2 } });
    expect(await client.primeAccountRateLimits()).toMatchObject({ primary: { usedPercent: 2 } });
    expect(ws.request).toHaveBeenCalledTimes(1);
    ws.request.mockResolvedValueOnce({ rateLimits: { primary: { usedPercent: 3 } } });
    expect(await client.readAccountRateLimits({ forceRefresh: true })).toMatchObject({ primary: { usedPercent: 3 } });
  });

  it('covers chat cache misses, clones, updates, expiry, and in-flight reads', async () => {
    const ws = createWsMock();
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    expect(client.peekChats()).toBeNull();
    expect(client.peekAllChats()).toBeNull();
    expect(client.peekChat('missing')).toBeNull();
    expect(client.peekChatSummary(' ')).toBeNull();
    expect(client.peekChatSummary('missing')).toBeNull();
    expect(client.peekChatShell('missing')).toBeNull();

    const summary = {
      id: 'cached', title: 'Cached', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', statusUpdatedAt: '2026-01-01T00:00:00Z', status: 'idle' as const, lastMessagePreview: '', engine: 'codex' as const,
    };
    client.rememberChats([summary]);
    client.rememberAllChats([summary]);
    client.rememberChat({ ...summary, title: 'Updated', messages: [], latestPlan: null, latestTurnPlan: null, latestTurnStatus: null, activeTurnId: null });
    expect(client.peekChats()?.[0].title).toBe('Updated');
    expect(client.peekAllChats()?.[0].title).toBe('Updated');

    let resolveRead: (value: unknown) => void = () => {};
    ws.request.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    const read1 = client.getChat('new');
    const read2 = client.getChat('new');
    expect(ws.request).toHaveBeenCalledTimes(1);
    resolveRead({ thread: { id: 'new', turns: [] } });
    await expect(read1).resolves.toMatchObject({ id: 'new' });
    await expect(read2).resolves.toMatchObject({ id: 'new' });
  });

  it('deduplicates list requests and supports forced and cached refreshes', async () => {
    const ws = createWsMock();
    let resolveList: (value: unknown) => void = () => {};
    ws.request.mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve; }));
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const list1 = client.listChats({ limit: 1 });
    const list2 = client.listChats({ limit: 1 });
    resolveList({ data: [{ id: 'one', updatedAt: 2, turns: [] }] });
    await expect(list1).resolves.toHaveLength(1);
    await expect(list2).resolves.toHaveLength(1);
    expect(ws.request).toHaveBeenCalledTimes(1);
    await client.primeChats({ limit: 1 });
    expect(ws.request).toHaveBeenCalledTimes(1);
    ws.request.mockResolvedValueOnce({ data: [] });
    await client.listChats({ limit: 1, forceRefresh: true });
    expect(ws.request).toHaveBeenCalledTimes(2);
  });

  it('handles stream filtering, completion, errors, invalid starts, and cancel idempotence', async () => {
    const ws = createWsMock();
    let listener: Parameters<HostBridgeWsClient['onEvent']>[0] = () => {};
    const unsubscribe = jest.fn();
    ws.onEvent.mockImplementation((next) => { listener = next; return unsubscribe; });
    ws.request.mockImplementation((method, params) => Promise.resolve(method.endsWith('/start') ? { started: true, streamId: (params as { streamId: string }).streamId } : {}));
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const onBatch = jest.fn();
    const onError = jest.fn();
    const controller = await client.startChatListStream({ limits: [0, 5, 5, 300], delayMs: Number.NaN }, onBatch, onError);
    listener({ method: 'other', params: { streamId: controller.streamId } });
    listener({ method: 'bridge/thread/list/stream/batch', params: { streamId: 'other' } });
    listener({ method: 'bridge/thread/list/stream/batch', params: { streamId: controller.streamId, done: true, data: [] } });
    controller.cancel();
    expect(onBatch).toHaveBeenCalledWith(expect.objectContaining({ done: true }));
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    const errorController = await client.startChatListStream({}, jest.fn(), onError);
    listener({ method: 'bridge/thread/list/stream/error', params: { streamId: errorController.streamId } });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'thread list stream failed' }));

    ws.request.mockResolvedValueOnce({ started: false, streamId: 'wrong' });
    await expect(client.startChatListStream({}, jest.fn())).rejects.toThrow('did not start');
  });

  it('validates browser payloads and lists only valid sessions', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ sessions: [null, { sessionId: 's', targetUrl: 'url', previewPort: '5', bootstrapPath: '/b', createdAt: 1, expiresAt: 2 }] })
      .mockResolvedValueOnce({ closed: false });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await expect(client.createBrowserPreviewSession('url')).rejects.toThrow('invalid session');
    await expect(client.listBrowserPreviewSessions()).resolves.toHaveLength(1);
    await expect(client.closeBrowserPreviewSession('s')).resolves.toBe(false);
  });

  it('covers create, fork, rename, workspace, interrupt, and empty-message validation', async () => {
    const ws = createWsMock();
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    ws.request.mockResolvedValueOnce({ thread: {} });
    await expect(client.createChat({})).rejects.toThrow('did not return a chat id');
    ws.request.mockResolvedValueOnce({});
    await expect(client.createChatIdempotent({}, 'submission')).rejects.toThrow('did not return a chat');
    ws.request.mockResolvedValueOnce({});
    await expect(client.forkChat('thr')).rejects.toThrow('did not return a chat payload');
    await expect(client.renameChat('thr', ' ')).rejects.toThrow('cannot be empty');
    await expect(client.setChatWorkspace('thr', ' ')).rejects.toThrow('cannot be empty');
    await expect(client.resumeThread(' ')).rejects.toThrow('thread id is required');
    await expect(client.interruptTurn('', 'turn')).rejects.toThrow('required');
    await expect(client.interruptLatestTurn(' ')).rejects.toThrow('threadId is required');
    await expect(client.readThreadQueue(' ')).resolves.toEqual({ threadId: '', items: [], lastError: null });

    ws.request.mockResolvedValueOnce({ thread: { id: 'empty', turns: [] } });
    await expect(client.sendChatMessage('empty', { content: ' ' })).resolves.toMatchObject({ id: 'empty' });
    await expect(client.steerChatTurn('', '', { content: '' })).resolves.toBeUndefined();
    await expect(client.sendChatMessage('thr', { content: 'x', role: 'assistant' })).rejects.toThrow('Only user role');
  });

  it('handles sent-message and upload failures', async () => {
    const ws = createWsMock();
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    ws.request.mockResolvedValueOnce({}).mockResolvedValueOnce({ turn: {} });
    await expect(client.sendChatMessage('thr', { content: 'x' })).rejects.toThrow('did not return turn id');
    ws.request.mockResolvedValueOnce({}).mockResolvedValueOnce({ disposition: 'sent', queue: { threadId: 'thr', items: [], lastError: null }, turnId: ' ' });
    await expect(client.sendOrQueueChatMessage('thr', { content: 'x' })).rejects.toThrow('did not return turn id');
    await expect(client.uploadAttachment({ uri: 'file://x', kind: 'file' })).rejects.toThrow('Bridge URL is required');

    const uploadAsync = FileSystem.uploadAsync as jest.MockedFunction<typeof FileSystem.uploadAsync>;
    uploadAsync.mockResolvedValueOnce({ status: 500, headers: {}, mimeType: 'text/plain', body: 'not json' });
    const uploadClient = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient, bridgeUrl: 'http://bridge' });
    await expect(uploadClient.uploadAttachment({ uri: 'file://x', kind: 'image', threadId: ' thr ' })).rejects.toThrow('Attachment upload failed (500)');
    uploadAsync.mockResolvedValueOnce({ status: 400, headers: {}, mimeType: 'application/json', body: JSON.stringify({ message: 'too large' }) });
    await expect(uploadClient.uploadAttachment({ uri: 'file://x', kind: 'file' })).rejects.toThrow('too large');
  });

  it('maps model and agent malformed variants', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValueOnce({ data: [null, {}, { model: 'fallback', providerID: 'p', model_context_window: 2048, reasoningEffort: ['low', 'bad', null] }] });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await expect(client.listModels(true, { threadId: ' ', engine: 'bad' as never })).resolves.toEqual([
      expect.objectContaining({ id: 'fallback', displayName: 'fallback', providerId: 'p', contextWindow: 2048, reasoningEffort: [{ effort: 'low' }] }),
    ]);
    ws.request.mockResolvedValueOnce({ data: [null, { name: '', mode: 'primary' }, { name: 'bad', mode: 'secondary' }, { name: 'all-agent', mode: ' ALL ', color: 'blue' }] });
    await expect(client.listHarnessAgents()).resolves.toEqual([expect.objectContaining({ id: 'all-agent', mode: 'all', color: 'blue' })]);
  });

  it('handles account login completion filtering, timeout, and default errors', async () => {
    jest.useFakeTimers();
    try {
      const ws = createWsMock();
      let listener: Parameters<HostBridgeWsClient['onEvent']>[0] = () => {};
      const unsubscribe = jest.fn();
      ws.onEvent.mockImplementation((next) => { listener = next; return unsubscribe; });
      const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
      const result = client.waitForAccountLoginCompleted('target', 50);
      const expectation = expect(result).rejects.toThrow('Codex login did not complete.');
      listener({ method: 'other', params: {} });
      listener({ method: 'account/login/completed', params: {} });
      listener({ method: 'account/login/completed', params: { login_id: 'other', success: true } });
      listener({ method: 'account/login/completed', params: { login_id: 'target', success: false } });
      await expectation;
      listener({ method: 'account/login/completed', params: { login_id: 'target', success: true } });
      expect(unsubscribe).toHaveBeenCalledTimes(1);

      const timeout = client.waitForAccountLoginCompleted(null, 50);
      const timeoutExpectation = expect(timeout).rejects.toThrow('Codex login did not finish');
      await jest.advanceTimersByTimeAsync(50);
      await timeoutExpectation;
    } finally {
      jest.useRealTimers();
    }
  });

  it('supports all-chat in-flight deduplication and empty summary hydration', async () => {
    const ws = createWsMock();
    let resolveList: (value: unknown) => void = () => {};
    ws.request.mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve; }));
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const first = client.listAllChats();
    const second = client.listAllChats();
    resolveList({ data: [], next_cursor: null, backwards_cursor: 'back' });
    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toEqual([]);
    expect(ws.request).toHaveBeenCalledTimes(1);
    await expect(client.getChatSummaries([])).resolves.toEqual([]);
  });

  it('filters invalid chat list entries and normalizes list options', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({ data: [null, {}, { id: 'valid', updatedAt: 1, turns: [] }] });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await expect(client.listChats({ limit: Number.NaN })).resolves.toEqual([expect.objectContaining({ id: 'valid' })]);
    expect(ws.request).toHaveBeenCalledWith('thread/list', expect.objectContaining({ limit: 20, cursor: null }));
  });

  it('maps filesystem optional fields and filters malformed entries', async () => {
    const ws = createWsMock();
    ws.request.mockResolvedValue({
      bridgeRoot: 1,
      path: '/repo',
      entries: [null, { name: '', path: '/bad' }, { name: 'file', path: '/repo/file', kind: null, hidden: true, selectable: false, isGitRepo: true }],
    });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await expect(client.listFilesystemEntries({ includeHidden: true, directoriesOnly: false, includeGitRepo: true })).resolves.toMatchObject({
      bridgeRoot: '',
      parentPath: null,
      entries: [{ name: 'file', path: '/repo/file', kind: 'directory', hidden: true, selectable: false, isGitRepo: true }],
    });
    expect(ws.request).toHaveBeenCalledWith('bridge/fs/list', { path: null, includeHidden: true, directoriesOnly: false, includeGitRepo: true });
  });

  it('maps workspace and browser discovery fallback shapes', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({ workspaces: [null, { path: '/repo', chatCount: {}, updatedAt: 'bad' }] })
      .mockResolvedValueOnce({ suggestions: [null, { targetUrl: '', label: 'bad', port: 1 }, { targetUrl: 'url', label: 'label', port: '7' }], scannedAt: 'bad' });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await expect(client.listWorkspaceRoots()).resolves.toMatchObject({ bridgeRoot: '', allowOutsideRootCwd: false, workspaces: [{ path: '/repo', chatCount: 0 }] });
    await expect(client.discoverBrowserPreviewTargets()).resolves.toEqual({ scannedAt: '1970-01-01T00:00:00.000Z', suggestions: [{ targetUrl: 'url', label: 'label', port: 7 }] });
  });

  it('maps create initial prompts, idempotent responses, summary failures, and workspace updates', async () => {
    const ws = createWsMock();
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    ws.request
      .mockResolvedValueOnce({ thread: { id: 'initial' } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ turn: { id: 'turn-initial' } })
      .mockResolvedValueOnce({ thread: { id: 'initial', cwd: '/repo', turns: [{ id: 'turn-initial', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'hello' }] }] }] } });
    await expect(client.createChat({ message: ' hello ', cwd: '/repo' })).resolves.toMatchObject({ id: 'initial' });

    ws.request.mockResolvedValueOnce({ thread: { id: 'created', turns: [] } });
    await expect(client.createChatIdempotent({}, 'submission')).resolves.toMatchObject({ id: 'created' });
    ws.request.mockResolvedValueOnce({ thread: {} });
    await expect(client.getChatSummary('bad')).rejects.toThrow('chat id missing');

    ws.request.mockResolvedValueOnce({}).mockResolvedValueOnce({ thread: { id: 'workspace', cwd: '/old', turns: [] } });
    await expect(client.setChatWorkspace('workspace', '/new')).resolves.toMatchObject({ cwd: '/new' });
  });

  it('covers queue empty-content and idempotent queued-message paths', async () => {
    const ws = createWsMock();
    ws.request
      .mockResolvedValueOnce({ threadId: 'thr', items: [], lastError: null })
      .mockResolvedValueOnce({ thread: { id: 'thr', turns: [] } });
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    await expect(client.sendOrQueueChatMessage('thr', { content: ' ' })).resolves.toMatchObject({ disposition: 'sent', turnId: '' });

    ws.request
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ disposition: 'queued', queue: { threadId: 'thr', items: [], lastError: null }, turnId: null })
      .mockResolvedValueOnce({ thread: { id: 'thr', turns: [] } });
    await expect(client.sendChatMessageIdempotent('thr', { content: 'x' }, 'submission')).resolves.toMatchObject({ id: 'thr' });
  });

  it('maps service-tier preferences and invalid normalization branches', async () => {
    const ws = createWsMock();
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    ws.request.mockResolvedValueOnce({ config: { service_tier: ' FLEX ' } });
    await expect(client.readServiceTierPreference('codex')).resolves.toBe('flex');
    ws.request.mockResolvedValueOnce({ config: { service_tier: 'slow' } });
    await expect(client.readServiceTierPreference()).resolves.toBeNull();
    ws.request.mockResolvedValueOnce({});
    await client.resumeThread('thr', { model: ' ', approvalPolicy: 'bad' as never });
    expect(ws.request).toHaveBeenLastCalledWith('thread/resume', expect.objectContaining({ model: null, approvalPolicy: 'untrusted' }));
  });

  it('filters invalid attachment entries and preserves synthetic attachment markers', async () => {
    jest.useFakeTimers();
    try {
      const ws = createWsMock();
      const stale = { thread: { id: 'attachments', turns: [{ id: 'old', items: [] }] } };
      ws.request.mockResolvedValueOnce({}).mockResolvedValueOnce({ turn: { id: 'new' } }).mockResolvedValue(stale);
      const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
      const result = client.sendChatMessage('attachments', {
        content: 'see files',
        mentions: [null as never, { path: ' ' }, { path: 'A.ts' }, { path: 'a.ts' }],
        localImages: [null as never, { path: '' }, { path: '/x.png' }, { path: '/X.PNG' }],
      });
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(2_000);
      await expect(result).resolves.toMatchObject({
        messages: expect.arrayContaining([expect.objectContaining({ content: 'see files\n[file: A.ts]\n[local image: /x.png]' })]),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('propagates rename and thread-read errors and falls back for materialization gaps', async () => {
    const ws = createWsMock();
    const client = new HostBridgeApiClient({ ws: ws as unknown as HostBridgeWsClient });
    const backend = new RpcRequestError('thread/name/set', -32603, 'backend');
    ws.request.mockRejectedValueOnce(backend);
    await expect(client.renameChat('thr', 'name')).rejects.toBe(backend);

    ws.request
      .mockRejectedValueOnce(new RpcRequestError('thread/read', -32602, 'includeTurns cannot materialise'))
      .mockResolvedValueOnce({ thread: { id: 'fallback', turns: [] } });
    await expect(client.getChat('fallback')).resolves.toMatchObject({ id: 'fallback' });

    const readError = new RpcRequestError('thread/read', -32603, 'other failure');
    ws.request.mockRejectedValueOnce(readError);
    await expect(client.getChat('error')).rejects.toBe(readError);
  });
});
