import type * as AppStatePersistenceModule from '../appStatePersistence';

describe('appStatePersistence', () => {
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it('stores the canonical document and imports legacy profile storage on web', async () => {
    const getItem = jest.fn((key: string) =>
      key === 'clawdex.bridge-profiles.v1' ? '{"profiles":[]}' : null
    );
    const setItem = jest.fn();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem, setItem },
    });
    jest.doMock('react-native', () => ({ Platform: { OS: 'web' } }));
    jest.doMock('expo-secure-store', () => ({}));
    jest.doMock('expo-file-system/legacy', () => ({
      documentDirectory: 'file:///documents/',
      readAsStringAsync: jest.fn().mockResolvedValue('{"version":11}'),
    }));

    let module!: typeof AppStatePersistenceModule;
    jest.isolateModules(() => {
      module = jest.requireActual('../appStatePersistence') as typeof AppStatePersistenceModule;
    });
    const persistence = module.createAppStatePersistence();

    expect(await persistence.readCurrent()).toBeNull();
    expect(await persistence.readLegacy()).toEqual({
      settingsRaw: '{"version":11}',
      bridgeProfilesRaw: '{"profiles":[]}',
    });
    await persistence.writeCurrent('{"version":1}');

    expect(setItem).toHaveBeenCalledWith('clawdex.app-state.v1', '{"version":1}');
  });

  it('uses secure storage for the canonical document on native platforms', async () => {
    const secureStore = {
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock',
      getItemAsync: jest.fn().mockResolvedValue('{"version":1}'),
      setItemAsync: jest.fn().mockResolvedValue(undefined),
    };
    jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }));
    jest.doMock('expo-secure-store', () => secureStore);
    jest.doMock('expo-file-system/legacy', () => ({
      documentDirectory: null,
      readAsStringAsync: jest.fn(),
    }));

    let module!: typeof AppStatePersistenceModule;
    jest.isolateModules(() => {
      module = jest.requireActual('../appStatePersistence') as typeof AppStatePersistenceModule;
    });
    const persistence = module.createAppStatePersistence();

    expect(await persistence.readCurrent()).toBe('{"version":1}');
    await persistence.writeCurrent('{"version":1}');
    expect(secureStore.setItemAsync).toHaveBeenCalledWith(
      'clawdex.app-state.v1',
      '{"version":1}',
      { keychainAccessible: 'after-first-unlock' }
    );
  });
});
