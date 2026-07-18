import { MainScreenPersistenceController } from '../mainScreenPersistenceController';

describe('mainScreenPersistenceController', () => {
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
