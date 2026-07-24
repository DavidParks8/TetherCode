import type { AgentDescriptor, AgentId, BridgeCapabilities } from './api/types';

export const UNKNOWN_AGENT_LABEL = 'Agent';

export function findAgentDescriptor(
  agents: readonly AgentDescriptor[],
  agentId: AgentId | null | undefined
): AgentDescriptor | null {
  if (!agentId) return null;
  return agents.find((agent) => agent.agentId === agentId) ?? null;
}

export function getAgentLabel(
  agents: readonly AgentDescriptor[],
  agentId: AgentId | null | undefined
): string {
  return findAgentDescriptor(agents, agentId)?.displayName.trim() ||
    humanizeAgentId(agentId) ||
    UNKNOWN_AGENT_LABEL;
}

function humanizeAgentId(agentId: AgentId | null | undefined): string | null {
  const normalized = agentId?.trim();
  if (!normalized) return null;
  if (normalized.toLowerCase() === 'opencode') return 'OpenCode';
  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || null;
}

export function selectAgentId(
  savedAgentId: AgentId | null | undefined,
  capabilities: BridgeCapabilities
): AgentId | null {
  if (savedAgentId && capabilities.agents.some((agent) => agent.agentId === savedAgentId)) {
    const saved = findAgentDescriptor(capabilities.agents, savedAgentId);
    if (saved?.lifecycle === 'ready') return savedAgentId;
  }
  const preferred = findAgentDescriptor(capabilities.agents, capabilities.preferredAgentId);
  if (preferred?.lifecycle === 'ready') return preferred.agentId;
  const active = findAgentDescriptor(capabilities.agents, capabilities.activeAgentId);
  if (active?.lifecycle === 'ready') return active.agentId;
  return capabilities.agents.find((agent) => agent.lifecycle === 'ready')?.agentId ?? null;
}

export function validAgentIconUri(icon: string | null | undefined): string | null {
  if (!icon || new TextEncoder().encode(icon).length > 2_048) return null;
  try {
    const url = new URL(icon);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password && !url.hash ? icon : null;
  } catch {
    return null;
  }
}