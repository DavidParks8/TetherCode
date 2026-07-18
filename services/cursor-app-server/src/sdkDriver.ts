import {
  Agent,
  Cursor,
  getDefaultSdkStateRoot,
  type AgentOptions,
  type LocalAgentStore,
  type ModelListItem,
  type Run,
  type SDKAgent,
  type SDKAgentInfo,
} from '@cursor/sdk';
import { SqliteLocalAgentStore } from '@cursor/sdk/sqlite';

import type {
  CursorAgentHandle,
  CursorAgentInfo,
  CursorAgentMessage,
  CursorDriver,
  CursorModelListItem,
  CursorRunInfo,
  CursorRunHandle,
  CursorStreamMessage,
  ModelSelection,
} from './types.js';

export class CursorSdkDriver implements CursorDriver {
  private readonly localStores = new Map<string, Promise<LocalAgentStore>>();

  async createAgent(options: {
    agentId?: string;
    cwd: string;
    apiKey: string;
    name?: string;
    model?: ModelSelection;
  }): Promise<CursorAgentHandle> {
    const store = await this.localStore(options.cwd);
    return wrapAgent(
      await Agent.create({
        agentId: options.agentId,
        apiKey: options.apiKey,
        name: options.name,
        model: options.model,
        ...buildLocalCursorAgentOptions({ cwd: options.cwd, store }),
      })
    );
  }

  async resumeAgent(
    agentId: string,
    options: { cwd: string; storeCwd?: string; apiKey: string; model?: ModelSelection }
  ): Promise<CursorAgentHandle> {
    const storeCwd = options.storeCwd ?? options.cwd;
    const store = await this.localStore(storeCwd);
    return wrapAgent(
      await Agent.resume(agentId, {
        apiKey: options.apiKey,
        model: options.model,
        ...buildLocalCursorAgentOptions({
          cwd: options.cwd,
          store,
        }),
      })
    );
  }

  async listAgents(options: {
    cwd: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ items: CursorAgentInfo[]; nextCursor?: string }> {
    const store = await this.localStore(options.cwd);
    const result = await Agent.list({
      runtime: 'local',
      cwd: options.cwd,
      store,
      limit: options.limit,
      cursor: options.cursor,
    });
    return {
      items: result.items.map(toAgentInfo),
      nextCursor: result.nextCursor,
    };
  }

  async getAgent(agentId: string, options: { cwd: string; apiKey?: string }): Promise<CursorAgentInfo> {
    const store = await this.localStore(options.cwd);
    return toAgentInfo(
      await Agent.get(agentId, { cwd: options.cwd, store, apiKey: options.apiKey })
    );
  }

  async listMessages(
    agentId: string,
    options: { cwd: string; limit?: number; offset?: number }
  ): Promise<CursorAgentMessage[]> {
    const store = await this.localStore(options.cwd);
    return (await Agent.messages.list(agentId, {
      runtime: 'local',
      cwd: options.cwd,
      store,
      limit: options.limit,
      offset: options.offset,
    })) as CursorAgentMessage[];
  }

  async listRuns(
    agentId: string,
    options: { cwd: string; limit?: number; cursor?: string }
  ): Promise<{ items: CursorRunInfo[]; nextCursor?: string }> {
    const store = await this.localStore(options.cwd);
    const result = await Agent.listRuns(agentId, {
      runtime: 'local',
      cwd: options.cwd,
      store,
      limit: options.limit,
      cursor: options.cursor,
    });
    return {
      items: result.items.map(toRunInfo),
      nextCursor: result.nextCursor,
    };
  }

  async listModels(options: { apiKey: string }): Promise<CursorModelListItem[]> {
    return (await Cursor.models.list({ apiKey: options.apiKey })).map(toModelListItem);
  }

  private localStore(cwd: string): Promise<LocalAgentStore> {
    const existing = this.localStores.get(cwd);
    if (existing) {
      return existing;
    }

    const store = SqliteLocalAgentStore.open({
      workspaceRef: cwd,
      stateRoot: localCursorAgentStoreRoot(cwd),
    });
    this.localStores.set(cwd, store);
    void store.catch(() => {
      if (this.localStores.get(cwd) === store) {
        this.localStores.delete(cwd);
      }
    });
    return store;
  }
}

export function buildLocalCursorAgentOptions(options: {
  cwd: string;
  store: LocalAgentStore;
}): Pick<AgentOptions, 'local'> {
  return {
    local: {
      cwd: options.cwd,
      store: options.store,
    },
  };
}

export function localCursorAgentStoreRoot(cwd: string): string {
  return getDefaultSdkStateRoot(cwd);
}

function wrapAgent(agent: SDKAgent): CursorAgentHandle {
  return {
    agentId: agent.agentId,
    get model() {
      return agent.model;
    },
    send: async (message, options) =>
      wrapRun(await agent.send(message, { model: options?.model })),
    close: () => agent.close(),
  };
}

function wrapRun(run: Run): CursorRunHandle {
  return {
    id: run.id,
    agentId: run.agentId,
    get status() {
      return run.status;
    },
    stream: () => run.stream() as AsyncGenerator<CursorStreamMessage, void>,
    wait: () => run.wait(),
    conversation: () => run.conversation() as Promise<unknown[]>,
    cancel: () => run.cancel(),
  };
}

function toAgentInfo(info: SDKAgentInfo): CursorAgentInfo {
  return {
    agentId: info.agentId,
    name: info.name,
    summary: info.summary,
    lastModified: info.lastModified,
    createdAt: info.createdAt,
    status: info.status,
    runtime: info.runtime,
    cwd: info.runtime === 'local' ? info.cwd : undefined,
  };
}

function toModelListItem(model: ModelListItem): CursorModelListItem {
  const contextWindow = modelDefaultContextWindow(model);
  return {
    id: model.id,
    displayName: model.displayName,
    description: model.description,
    providerId: 'cursor',
    providerName: 'Cursor',
    contextWindow,
    isDefault: model.variants?.some((variant) => variant.isDefault === true) ?? false,
  };
}

function modelDefaultContextWindow(model: ModelListItem): number | undefined {
  const defaultVariant =
    model.variants?.find((variant) => variant.isDefault === true) ??
    (model.variants?.length === 1 ? model.variants[0] : undefined);
  const variantContext = defaultVariant?.params.find((param) => param.id === 'context');
  const parsedVariantContext = parseContextWindowValue(variantContext?.value);
  if (parsedVariantContext) {
    return parsedVariantContext;
  }

  const contextParameter = model.parameters?.find((parameter) => parameter.id === 'context');
  const contextValues = new Set<number>();
  for (const value of contextParameter?.values ?? []) {
    const parsed = parseContextWindowValue(value.value);
    if (parsed) {
      contextValues.add(parsed);
    }
  }

  if (contextValues.size === 1) {
    return [...contextValues][0];
  }
  return undefined;
}

function parseContextWindowValue(value: string | undefined): number | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const match = /^([0-9]+(?:\.[0-9]+)?)([km])?$/.exec(normalized);
  if (!match) {
    return undefined;
  }

  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }

  const multiplier = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1;
  return Math.floor(numeric * multiplier);
}

function toRunInfo(run: Run): CursorRunInfo {
  return {
    id: run.id,
    status: run.status,
    model: run.model,
    createdAt: run.createdAt,
  };
}
