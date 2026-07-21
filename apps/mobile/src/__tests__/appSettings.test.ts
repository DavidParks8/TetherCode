import { APP_SETTINGS_VERSION, parseAppSettings } from '../appSettings';

test('fresh settings have no preferred agent', () => {
  expect(parseAppSettings('')).toMatchObject({ preferredAgentId: null, agentSettings: {} });
});

test('persists opaque agent IDs without fixed-name migration', () => {
  const parsed = parseAppSettings(JSON.stringify({
    version: APP_SETTINGS_VERSION,
    preferredAgentId: 'agent-alpha',
    agentSettings: { 'agent-alpha': { collaborationMode: 'plan' } },
  }));
  expect(parsed.preferredAgentId).toBe('agent-alpha');
  expect(parsed.agentSettings['agent-alpha']).toEqual({ collaborationMode: 'plan' });
});

test('rejects legacy settings versions instead of migrating obsolete agent state', () => {
  expect(parseAppSettings(JSON.stringify({ version: 12, preferredAgentId: 'legacy' })).preferredAgentId).toBeNull();
});
