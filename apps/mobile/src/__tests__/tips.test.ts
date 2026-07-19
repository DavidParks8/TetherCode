const mockPurchases = {
  configure: jest.fn(),
  getOfferings: jest.fn(),
  purchasePackage: jest.fn(),
  setLogLevel: jest.fn(),
};
const mockPresentPaywall = jest.fn();
const mockPlatform = { OS: 'ios' };
const mockEnv: {
  revenueCatIosApiKey: string | null;
  revenueCatAndroidApiKey: string | null;
  revenueCatTestStoreApiKey: string | null;
  revenueCatTipsOfferingId: string | null;
} = {
  revenueCatIosApiKey: 'ios-key',
  revenueCatAndroidApiKey: 'android-key',
  revenueCatTestStoreApiKey: null as string | null,
  revenueCatTipsOfferingId: null as string | null,
};

jest.mock('react-native', () => ({ Platform: mockPlatform }));
jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: mockPurchases,
  LOG_LEVEL: { ERROR: 'ERROR' },
  PRODUCT_CATEGORY: { NON_SUBSCRIPTION: 'NON_SUBSCRIPTION' },
  PRODUCT_TYPE: { CONSUMABLE: 'CONSUMABLE', NON_CONSUMABLE: 'NON_CONSUMABLE' },
  PURCHASES_ERROR_CODE: { PURCHASE_CANCELLED_ERROR: 'PURCHASE_CANCELLED_ERROR' },
}));
jest.mock('react-native-purchases-ui', () => ({
  __esModule: true,
  default: { presentPaywall: mockPresentPaywall },
  PAYWALL_RESULT: {
    PURCHASED: 'PURCHASED',
    RESTORED: 'RESTORED',
    CANCELLED: 'CANCELLED',
    NOT_PRESENTED: 'NOT_PRESENTED',
  },
}));
jest.mock('../config', () => ({ env: mockEnv }));

interface TipsModule {
  isTipJarAvailable(): boolean;
  isTipPaywallTemplateAvailable(): boolean;
  getTipJarUnavailableReason(): string;
  configureRevenueCatIfNeeded(): Promise<boolean>;
  loadTipOffering(): Promise<{ packages: Array<{ identifier: string }> }>;
  purchaseTipPackage(aPackage: never): Promise<void>;
  presentTipPaywall(offering?: never): Promise<string>;
  isRevenueCatPurchaseCancelled(error: unknown): boolean;
  getTipTierTitle(aPackage: never): string;
  getTipTierDescription(aPackage: never): string;
  getTipTierMeta(aPackage: never): string;
  getTipOfferingSummary(offering: never, count: number): string;
}

function loadTips(): TipsModule {
  let loaded: TipsModule | undefined;
  jest.isolateModules(() => {
    loaded = jest.requireActual<TipsModule>('../tips');
  });
  return loaded!;
}

function tipPackage(overrides: Record<string, unknown> = {}) {
  return {
    identifier: 'small_tip',
    product: {
      title: 'Small Tip (Clawdex)',
      description: 'Thanks',
      productCategory: 'NON_SUBSCRIPTION',
      productType: 'CONSUMABLE',
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPlatform.OS = 'ios';
  mockEnv.revenueCatIosApiKey = 'ios-key';
  mockEnv.revenueCatAndroidApiKey = 'android-key';
  mockEnv.revenueCatTestStoreApiKey = null;
  mockEnv.revenueCatTipsOfferingId = null;
});

describe('tip purchases', () => {
  it('reports platform-specific availability and unavailable reasons', () => {
    let tips = loadTips();
    expect(tips.isTipJarAvailable()).toBe(true);
    expect(tips.isTipPaywallTemplateAvailable()).toBe(true);

    mockPlatform.OS = 'web';
    tips = loadTips();
    expect(tips.isTipJarAvailable()).toBe(false);
    expect(tips.isTipPaywallTemplateAvailable()).toBe(false);
    expect(tips.getTipJarUnavailableReason()).toMatch(/native iPhone and Android/);

    mockPlatform.OS = 'android';
    mockEnv.revenueCatAndroidApiKey = null;
    tips = loadTips();
    expect(tips.getTipJarUnavailableReason()).toMatch(/public API key/);
  });

  it('configures once, tolerates logging failure, and retries configuration failure', async () => {
    mockPurchases.setLogLevel.mockRejectedValueOnce(new Error('logging unavailable'));
    let tips = loadTips();
    await expect(tips.configureRevenueCatIfNeeded()).resolves.toBe(true);
    await expect(tips.configureRevenueCatIfNeeded()).resolves.toBe(true);
    expect(mockPurchases.configure).toHaveBeenCalledTimes(1);

    mockPurchases.configure.mockImplementationOnce(() => {
      throw new Error('configure failed');
    });
    tips = loadTips();
    await expect(tips.configureRevenueCatIfNeeded()).rejects.toThrow('configure failed');
    await expect(tips.configureRevenueCatIfNeeded()).resolves.toBe(true);
  });

  it('loads a requested offering, filters subscriptions, and caps tiers', async () => {
    mockEnv.revenueCatTipsOfferingId = 'tips';
    const validPackages = Array.from({ length: 6 }, (_, index) =>
      tipPackage({ identifier: `tip_${index}` })
    );
    mockPurchases.getOfferings.mockResolvedValue({
      current: null,
      all: {
        tips: {
          identifier: 'tips',
          serverDescription: 'Tips',
          availablePackages: [
            { product: { productCategory: 'SUBSCRIPTION', productType: 'SUBSCRIPTION' } },
            ...validPackages,
          ],
        },
      },
    });

    const snapshot = await loadTips().loadTipOffering();
    expect(snapshot.packages).toHaveLength(5);
    expect(snapshot.packages[0].identifier).toBe('tip_0');
  });

  it('reports missing configuration, offerings, and non-subscription tiers', async () => {
    mockPlatform.OS = 'web';
    await expect(loadTips().loadTipOffering()).rejects.toThrow(/native iPhone/);

    mockPlatform.OS = 'ios';
    mockEnv.revenueCatTipsOfferingId = 'missing';
    mockPurchases.getOfferings.mockResolvedValue({ current: null, all: {} });
    await expect(loadTips().loadTipOffering()).rejects.toThrow(/"missing" was not found/);

    mockEnv.revenueCatTipsOfferingId = null;
    mockPurchases.getOfferings.mockResolvedValue({
      current: { availablePackages: [] },
      all: {},
    });
    await expect(loadTips().loadTipOffering()).rejects.toThrow(/non-subscription tip tiers/);
  });

  it.each([
    ['PURCHASED', 'purchased'],
    ['RESTORED', 'restored'],
    ['CANCELLED', 'cancelled'],
    ['NOT_PRESENTED', 'notPresented'],
  ])('maps paywall result %s to %s', async (result, expected) => {
    mockPresentPaywall.mockResolvedValue(result);
    await expect(loadTips().presentTipPaywall(null as never)).resolves.toBe(expected);
  });

  it('purchases packages and recognizes both cancellation shapes', async () => {
    const aPackage = tipPackage();
    const tips = loadTips();
    await tips.purchaseTipPackage(aPackage as never);
    expect(mockPurchases.purchasePackage).toHaveBeenCalledWith(aPackage);
    expect(tips.isRevenueCatPurchaseCancelled(null)).toBe(false);
    expect(tips.isRevenueCatPurchaseCancelled({ code: 'PURCHASE_CANCELLED_ERROR' })).toBe(true);
    expect(tips.isRevenueCatPurchaseCancelled({ userCancelled: true })).toBe(true);
    expect(tips.isRevenueCatPurchaseCancelled({ code: 'OTHER' })).toBe(false);
  });

  it('formats tier and offering display fallbacks', () => {
    const tips = loadTips();
    expect(tips.getTipTierTitle(tipPackage() as never)).toBe('Small Tip');
    expect(
      tips.getTipTierTitle(
        tipPackage({
          identifier: 'large_tip',
          product: {
            title: ' ',
            description: '',
            productCategory: 'OTHER',
            productType: 'OTHER',
          },
        }) as never
      )
    ).toBe('Large Tip');
    expect(
      tips.getTipTierDescription(
        tipPackage({ product: { ...tipPackage().product, description: ' ' } }) as never
      )
    ).toMatch(/One-time support/);
    expect(tips.getTipTierMeta(tipPackage() as never)).toBe('One-time');
    expect(tips.getTipOfferingSummary(null as never, 2)).toBe('Optional one-time support');
    expect(
      tips.getTipOfferingSummary(
        { identifier: 'support_tips', serverDescription: ' ' } as never,
        1
      )
    ).toBe('Support Tips · 1 tier');
  });
});
