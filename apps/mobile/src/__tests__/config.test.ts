const CONFIG_ENV_KEYS = [
  'EXPO_PUBLIC_HOST_BRIDGE_URL',
  'EXPO_PUBLIC_MAC_BRIDGE_URL',
  'EXPO_PUBLIC_HOST_BRIDGE_TOKEN',
  'EXPO_PUBLIC_MAC_BRIDGE_TOKEN',
  'EXPO_PUBLIC_ALLOW_QUERY_TOKEN_AUTH',
  'EXPO_PUBLIC_ALLOW_INSECURE_REMOTE_BRIDGE',
  'EXPO_PUBLIC_PRIVACY_POLICY_URL',
  'EXPO_PUBLIC_TERMS_OF_SERVICE_URL',
  'EXPO_PUBLIC_REVENUECAT_IOS_API_KEY',
  'EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY',
  'EXPO_PUBLIC_REVENUECAT_TEST_STORE_API_KEY',
  'EXPO_PUBLIC_REVENUECAT_TIPS_OFFERING_ID',
  'EXPO_PUBLIC_EXTERNAL_STATUS_FULL_SYNC_DEBOUNCE_MS',
] as const;

const originalEnvironment = Object.fromEntries(
  CONFIG_ENV_KEYS.map((key) => [key, process.env[key]])
);

interface ConfigEnvironment {
  legacyHostBridgeUrl: string | null;
  hostBridgeToken: string | null;
  allowWsQueryTokenAuth: boolean;
  allowInsecureRemoteBridge: boolean;
  externalStatusFullSyncDebounceMs: number;
  privacyPolicyUrl: string;
  termsOfServiceUrl: string;
  revenueCatIosApiKey: string | null;
  revenueCatAndroidApiKey: string | null;
  revenueCatTestStoreApiKey: string | null;
  revenueCatTipsOfferingId: string | null;
}

function loadEnvironment(
  overrides: Partial<Record<(typeof CONFIG_ENV_KEYS)[number], string>>
): ConfigEnvironment {
  for (const key of CONFIG_ENV_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, overrides);

  let loaded: ConfigEnvironment | undefined;
  jest.isolateModules(() => {
    loaded = jest.requireActual<{ env: ConfigEnvironment }>('../config').env;
  });
  return loaded!;
}

afterAll(() => {
  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('mobile environment configuration', () => {
  it('uses safe defaults when optional values are absent', () => {
    expect(loadEnvironment({})).toEqual(
      expect.objectContaining({
        legacyHostBridgeUrl: null,
        hostBridgeToken: null,
        allowWsQueryTokenAuth: false,
        allowInsecureRemoteBridge: false,
        externalStatusFullSyncDebounceMs: 450,
        privacyPolicyUrl: 'https://mohit-patil.github.io/clawdex-mobile/privacy/',
        termsOfServiceUrl: 'https://mohit-patil.github.io/clawdex-mobile/terms/',
        revenueCatIosApiKey: null,
        revenueCatAndroidApiKey: null,
        revenueCatTestStoreApiKey: null,
        revenueCatTipsOfferingId: null,
      })
    );
  });

  it('normalizes legacy aliases, flags, URLs, purchase keys, and debounce values', () => {
    expect(
      loadEnvironment({
        EXPO_PUBLIC_MAC_BRIDGE_URL: ' ws://localhost:8787/rpc/ ',
        EXPO_PUBLIC_MAC_BRIDGE_TOKEN: ' token ',
        EXPO_PUBLIC_ALLOW_QUERY_TOKEN_AUTH: ' TRUE ',
        EXPO_PUBLIC_ALLOW_INSECURE_REMOTE_BRIDGE: 'true',
        EXPO_PUBLIC_PRIVACY_POLICY_URL: ' https://example.com/privacy ',
        EXPO_PUBLIC_TERMS_OF_SERVICE_URL: ' https://example.com/terms ',
        EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: ' ios-key ',
        EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY: ' android-key ',
        EXPO_PUBLIC_REVENUECAT_TEST_STORE_API_KEY: ' test-key ',
        EXPO_PUBLIC_REVENUECAT_TIPS_OFFERING_ID: ' tips ',
        EXPO_PUBLIC_EXTERNAL_STATUS_FULL_SYNC_DEBOUNCE_MS: ' 0 ',
      })
    ).toEqual(
      expect.objectContaining({
        legacyHostBridgeUrl: 'http://localhost:8787/rpc',
        hostBridgeToken: 'token',
        allowWsQueryTokenAuth: true,
        allowInsecureRemoteBridge: true,
        externalStatusFullSyncDebounceMs: 0,
        privacyPolicyUrl: 'https://example.com/privacy',
        termsOfServiceUrl: 'https://example.com/terms',
        revenueCatIosApiKey: 'ios-key',
        revenueCatAndroidApiKey: 'android-key',
        revenueCatTestStoreApiKey: 'test-key',
        revenueCatTipsOfferingId: 'tips',
      })
    );
  });

  it.each(['', 'invalid', '-1'])('falls back for invalid debounce value %p', (value) => {
    expect(
      loadEnvironment({
        EXPO_PUBLIC_EXTERNAL_STATUS_FULL_SYNC_DEBOUNCE_MS: value,
      }).externalStatusFullSyncDebounceMs
    ).toBe(450);
  });

  it('warns when an insecure remote fallback URL is not explicitly allowed', () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    loadEnvironment({ EXPO_PUBLIC_HOST_BRIDGE_URL: 'http://bridge.example.com:8787' });
    expect(warning).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });
});
