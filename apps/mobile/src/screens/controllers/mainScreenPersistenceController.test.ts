import { MainScreenPersistenceController } from './mainScreenPersistenceController';

describe('mainScreenPersistenceController', () => {
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  afterEach(() => {
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it('supports its default storage and path dependencies', () => {
    expect(new MainScreenPersistenceController()).toBeInstanceOf(MainScreenPersistenceController);
  });

  it('serializes versioned preferences through injected storage', async () => {
    const storage = { read: jest.fn(), write: jest.fn().mockResolvedValue(undefined) };
    const controller = new MainScreenPersistenceController(storage, {
      modelPreferences: () => '/preferences.json',
    });
    await controller.saveModelPreferences({
      thread: { modelId: 'model', effort: null, serviceTier: null, updatedAt: 'now' },
    });
    expect(JSON.parse(storage.write.mock.calls[0][1])).toMatchObject({
      version: 1,
      entries: { thread: { modelId: 'model' } },
    });
  });

  it('persists model preferences through browser storage by default', async () => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: jest.fn((key: string) => values.get(key) ?? null),
        setItem: jest.fn((key: string, value: string) => values.set(key, value)),
      },
    });
    const controller = new MainScreenPersistenceController(undefined, {}, 'web');
    await controller.saveModelPreferences({
      thread: { modelId: 'gpt-5.4', effort: 'high', serviceTier: null, updatedAt: 'now' },
    });
    await expect(controller.loadModelPreferences()).resolves.toMatchObject({
      thread: { modelId: 'gpt-5.4', effort: 'high' },
    });
    expect(values.has('tethercode.main-screen.model-preferences.v1')).toBe(true);
  });

  it('returns an empty collection when storage cannot be read', async () => {
    const controller = new MainScreenPersistenceController({
      read: jest.fn().mockRejectedValue(new Error('missing')),
      write: jest.fn(),
    }, {
      workspaceFavorites: () => '/favorites.json',
    });
    await expect(controller.loadWorkspaceFavorites()).resolves.toEqual([]);
  });

  it('loads and saves every persisted collection', async () => {
    const storage = {
      read: jest.fn()
        .mockResolvedValueOnce(JSON.stringify({ version: 1, entries: { thread: { modelId: 'm' } } }))
        .mockResolvedValueOnce(JSON.stringify({ version: 1, entries: {} }))
        .mockResolvedValueOnce(JSON.stringify({ version: 1, entries: {} }))
        .mockResolvedValueOnce(JSON.stringify({ version: 1, paths: ['/repo'] })),
      write: jest.fn().mockResolvedValue(undefined),
    };
    const paths = {
      modelPreferences: () => '/models', planSnapshots: () => '/plans',
      bridgeUiSurfaces: () => '/surfaces', workspaceFavorites: () => '/favorites',
    };
    const controller = new MainScreenPersistenceController(storage, paths);
    await expect(controller.loadModelPreferences()).resolves.toMatchObject({ thread: { modelId: 'm' } });
    await expect(controller.loadPlanSnapshots()).resolves.toEqual({});
    await expect(controller.loadBridgeUiSurfaces()).resolves.toEqual({});
    await expect(controller.loadWorkspaceFavorites()).resolves.toEqual(['/repo']);
    await controller.savePlanSnapshots({});
    await controller.saveBridgeUiSurfaces({});
    await controller.saveWorkspaceFavorites(['/repo']);
    expect(storage.write).toHaveBeenCalledTimes(3);
  });

  it('skips missing paths and ignores write failures', async () => {
    const storage = {
      read: jest.fn(),
      write: jest.fn().mockRejectedValue(new Error('disk full')),
    };
    const controller = new MainScreenPersistenceController(storage, {
      modelPreferences: () => null,
      planSnapshots: () => '/plans',
    });
    await expect(controller.loadModelPreferences()).resolves.toEqual({});
    await expect(controller.saveModelPreferences({})).resolves.toBeUndefined();
    await expect(controller.savePlanSnapshots({})).resolves.toBeUndefined();
    expect(storage.read).not.toHaveBeenCalled();
    expect(storage.write).toHaveBeenCalledTimes(1);
  });
});
