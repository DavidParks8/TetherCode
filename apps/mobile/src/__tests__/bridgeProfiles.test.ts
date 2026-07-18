import {
  createEmptyBridgeProfileStore,
  deriveBridgeProfileName,
  parseBridgeProfileStore,
  removeBridgeProfile,
  renameBridgeProfile,
  setActiveBridgeProfile,
  upsertBridgeProfile,
} from '../bridgeProfiles';

describe('bridgeProfiles', () => {
  it('derives a profile name from the bridge hostname when omitted', () => {
    expect(deriveBridgeProfileName(null, 'http://192.168.1.39:8787')).toBe('192.168.1.39');
  });

  it('upserts and activates profiles', () => {
    const empty = createEmptyBridgeProfileStore();
    const created = upsertBridgeProfile(empty, {
      name: 'Office Mac',
      bridgeUrl: 'http://192.168.1.39:8787',
      bridgeToken: 'secret-one',
      activate: true,
    }).store;

    expect(created.profiles).toHaveLength(1);
    expect(created.activeProfileId).toBe(created.profiles[0]?.id);

    const updated = upsertBridgeProfile(created, {
      id: created.profiles[0]?.id,
      name: 'Office Mac Mini',
      bridgeUrl: 'http://192.168.1.39:8787',
      bridgeToken: 'secret-two',
      activate: true,
    }).store;

    expect(updated.profiles).toHaveLength(1);
    expect(updated.profiles[0]?.name).toBe('Office Mac Mini');
    expect(updated.profiles[0]?.bridgeToken).toBe('secret-two');
  });

  it('parses stores and drops invalid active ids', () => {
    const parsed = parseBridgeProfileStore(
      JSON.stringify({
        activeProfileId: 'missing',
        profiles: [
          {
            id: 'profile-1',
            name: 'Server A',
            bridgeUrl: 'http://10.0.0.1:8787',
            bridgeToken: 'token-a',
          },
        ],
      })
    );

    expect(parsed.activeProfileId).toBeNull();
    expect(parsed.profiles).toHaveLength(1);
  });

  it('parses legacy auth fields without exposing them on profiles', () => {
    const parsed = parseBridgeProfileStore(
      JSON.stringify({
        activeProfileId: 'profile-1',
        profiles: [
          {
            id: 'profile-1',
            name: 'Legacy profile',
            bridgeUrl: 'http://10.0.0.1:8787',
            bridgeToken: 'gho_old',
            authMode: 'githubOAuth',
          },
        ],
      })
    );

    expect(parsed.activeProfileId).toBe('profile-1');
    expect(parsed.profiles).toHaveLength(1);
    expect(parsed.profiles[0]).not.toHaveProperty('authMode');
  });

  it('changes the active profile without altering saved entries', () => {
    const base = parseBridgeProfileStore(
      JSON.stringify({
        activeProfileId: 'profile-1',
        profiles: [
          {
            id: 'profile-1',
            name: 'Server A',
            bridgeUrl: 'http://10.0.0.1:8787',
            bridgeToken: 'token-a',
          },
          {
            id: 'profile-2',
            name: 'Server B',
            bridgeUrl: 'http://10.0.0.2:8787',
            bridgeToken: 'token-b',
          },
        ],
      })
    );

    const switched = setActiveBridgeProfile(base, 'profile-2');

    expect(switched.activeProfileId).toBe('profile-2');
    expect(switched.profiles).toHaveLength(2);
  });

  it('renames a saved profile without touching its bridge config', () => {
    const base = parseBridgeProfileStore(
      JSON.stringify({
        activeProfileId: 'profile-1',
        profiles: [
          {
            id: 'profile-1',
            name: 'Server A',
            bridgeUrl: 'http://10.0.0.1:8787',
            bridgeToken: 'token-a',
          },
        ],
      })
    );

    const renamed = renameBridgeProfile(base, 'profile-1', 'Office Bridge');

    expect(renamed.profiles[0]?.name).toBe('Office Bridge');
    expect(renamed.profiles[0]?.bridgeUrl).toBe('http://10.0.0.1:8787');
    expect(renamed.profiles[0]?.bridgeToken).toBe('token-a');
  });

  it('removes the active profile and promotes another saved profile', () => {
    const base = parseBridgeProfileStore(
      JSON.stringify({
        activeProfileId: 'profile-1',
        profiles: [
          {
            id: 'profile-1',
            name: 'Server A',
            bridgeUrl: 'http://10.0.0.1:8787',
            bridgeToken: 'token-a',
          },
          {
            id: 'profile-2',
            name: 'Server B',
            bridgeUrl: 'http://10.0.0.2:8787',
            bridgeToken: 'token-b',
          },
        ],
      })
    );

    const next = removeBridgeProfile(base, 'profile-1');

    expect(next.activeProfileId).toBe('profile-2');
    expect(next.profiles).toHaveLength(1);
    expect(next.profiles[0]?.id).toBe('profile-2');
  });
});
