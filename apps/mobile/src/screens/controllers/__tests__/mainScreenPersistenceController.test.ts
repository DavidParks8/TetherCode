import { MainScreenPersistenceController } from '../mainScreenPersistenceController';

describe('mainScreenPersistenceController', () => {
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
});
