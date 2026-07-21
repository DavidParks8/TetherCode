import type { AgentDescriptor, AgentId, BridgeCapabilities } from './api/types';

export const UNKNOWN_AGENT_LABEL = 'Unknown agent';

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
  return findAgentDescriptor(agents, agentId)?.displayName.trim() || UNKNOWN_AGENT_LABEL;
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