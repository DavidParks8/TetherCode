import { getAgentLabel, selectAgentId, validAgentIconUri } from '../agents';
import type { BridgeCapabilities } from '../api/types';
import iconPolicyFixture from '../../../../contracts/agent-icon-policy.json';

function capabilities(): BridgeCapabilities {
  return {
    protocolVersion: 2,
    streamId: 'stream',
    preferredAgentId: 'agent-beta',
    activeAgentId: 'agent-beta',
    agents: [
      { agentId: 'agent-alpha', displayName: 'Alpha', icon: 'invalid', version: '1', provenance: 'local', lifecycle: 'unavailable', lastError: 'redacted', capabilities: null },
      { agentId: 'agent-beta', displayName: 'Beta', icon: null, version: '2', provenance: 'registry', lifecycle: 'ready', lastError: null, capabilities: { sessionList: true, sessionLoad: true, sessionResume: true, sessionSteer: false } },
    ],
    agUiEvents: true,
    supports: support(),
    supportsByAgent: { 'agent-alpha': support(), 'agent-beta': support() },
  };
}

function support() {
  return { reviewStart: false, turnSteer: false, commandOutputDelta: false, browserPreview: false, genericUiSurface: true };
}

test('selects saved ready agent, then bridge preferred, then first ready descriptor', () => {
  const value = capabilities();
  expect(selectAgentId('agent-beta', value)).toBe('agent-beta');
  expect(selectAgentId('agent-alpha', value)).toBe('agent-beta');
  expect(selectAgentId('missing-agent', value)).toBe('agent-beta');
});

test('uses descriptor labels and generic unknown fallback', () => {
  const value = capabilities();
  expect(getAgentLabel(value.agents, 'agent-beta')).toBe('Beta');
  expect(getAgentLabel(value.agents, 'missing-agent')).toBe('Unknown agent');
});

test('accepts image URIs and rejects invalid descriptor icons', () => {
  for (const policyCase of iconPolicyFixture.cases) {
    expect(validAgentIconUri(policyCase.value)).toBe(policyCase.valid ? policyCase.value : null);
  }
  expect(validAgentIconUri(`https://example.test/${'x'.repeat(iconPolicyFixture.maximumBytes)}`)).toBeNull();
});