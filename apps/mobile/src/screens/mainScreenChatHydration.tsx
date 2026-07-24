import { useCallback, useEffect } from 'react';
import type { BridgeUiSurface, ReasoningEffort, ServiceTier } from '../api/types';
import { type ActivePlanState, WORKSPACE_FAVORITES_LIMIT, type ChatModelPreference, normalizeWorkspacePath, normalizeModelId, normalizeReasoningEffort, normalizeServiceTier, toSelectedServiceTier } from './mainScreenHelpers';
import { agentModelPreferenceKey } from './mainScreenHelperPreferences';
import type { MainScreenThreadSnapshotStoreContext, MainScreenThreadSnapshotStoreResult } from './mainScreenThreadSnapshotStore';






export type MainScreenChatHydrationContext = MainScreenThreadSnapshotStoreContext & MainScreenThreadSnapshotStoreResult;

export function useMainScreenChatHydration(context: MainScreenChatHydrationContext) {
  const {
    activeAgentId,
    bridgeUiSurfacePersistenceTimeoutRef,
    bridgeUiSurfaceSnapshotsRef,
    chatIdRef,
    chatModelPreferencesRef,
    chatPlanSnapshotsRef,
    persistenceController,
    saveBridgeUiSurfaceSnapshots,
    saveChatModelPreferences,
    saveChatPlanSnapshots,
    saveWorkspaceFavorites,
    scheduleBridgeUiSurfaceSnapshotsPersist,
    setChatModelPreferencesLoaded,
    setDefaultServiceTier,
    setFavoriteWorkspacePaths,
    setSelectedEffort,
    setSelectedModelId,
    setSelectedServiceTier,
  } = context;


  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const paths = await persistenceController.loadWorkspaceFavorites();
      if (!cancelled) setFavoriteWorkspacePaths(paths);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [persistenceController]);

  const toggleWorkspaceFavorite = useCallback(
    (path: string | null | undefined) => {
      const normalizedPath = normalizeWorkspacePath(path);
      if (!normalizedPath) {
        return;
      }

      setFavoriteWorkspacePaths((current) => {
        const exists = current.includes(normalizedPath);
        const next = exists
          ? current.filter((entry) => entry !== normalizedPath)
          : [
              normalizedPath,
              ...current.filter((entry) => entry !== normalizedPath),
            ].slice(0, WORKSPACE_FAVORITES_LIMIT);
        void saveWorkspaceFavorites(next);
        return next;
      });
    },
    [saveWorkspaceFavorites]
  );

  useEffect(() => {
    return () => {
      const existingTimer = bridgeUiSurfacePersistenceTimeoutRef.current;
      if (existingTimer) {
        clearTimeout(existingTimer);
        bridgeUiSurfacePersistenceTimeoutRef.current = null;
      }
      void saveBridgeUiSurfaceSnapshots(bridgeUiSurfaceSnapshotsRef.current);
    };
  }, [saveBridgeUiSurfaceSnapshots]);

  const rememberChatPlanSnapshot = useCallback(
    (chatId: string, plan: ActivePlanState | null) => {
      const normalizedChatId = chatId.trim();
      if (!normalizedChatId) {
        return;
      }

      const previous = chatPlanSnapshotsRef.current[normalizedChatId] ?? null;
      const unchanged =
        previous?.turnId === plan?.turnId &&
        previous?.explanation === plan?.explanation &&
        previous?.deltaText === plan?.deltaText &&
        previous?.updatedAt === plan?.updatedAt &&
        JSON.stringify(previous?.steps ?? []) === JSON.stringify(plan?.steps ?? []);
      if (unchanged) {
        return;
      }

      const nextSnapshots = { ...chatPlanSnapshotsRef.current };
      if (plan) {
        nextSnapshots[normalizedChatId] = plan;
      } else {
        delete nextSnapshots[normalizedChatId];
      }
      chatPlanSnapshotsRef.current = nextSnapshots;
      void saveChatPlanSnapshots(nextSnapshots);
    },
    [saveChatPlanSnapshots]
  );

  const rememberBridgeUiSurfaceSnapshots = useCallback(
    (
      chatId: string,
      updater: (previous: BridgeUiSurface[]) => BridgeUiSurface[]
    ) => {
      const normalizedChatId = chatId.trim();
      if (!normalizedChatId) {
        return;
      }

      const previous = bridgeUiSurfaceSnapshotsRef.current[normalizedChatId] ?? [];
      const nextSurfaces = updater(previous);
      const nextSnapshots = { ...bridgeUiSurfaceSnapshotsRef.current };
      if (nextSurfaces.length > 0) {
        nextSnapshots[normalizedChatId] = nextSurfaces;
      } else {
        delete nextSnapshots[normalizedChatId];
      }

      bridgeUiSurfaceSnapshotsRef.current = nextSnapshots;
      scheduleBridgeUiSurfaceSnapshotsPersist(nextSnapshots);
    },
    [scheduleBridgeUiSurfaceSnapshotsPersist]
  );

  const rememberChatModelPreference = useCallback(
    (
      chatId: string | null | undefined,
      modelId: string | null | undefined,
      effort: ReasoningEffort | null | undefined,
      serviceTier: ServiceTier | null | undefined
    ) => {
      const normalizedChatId = typeof chatId === 'string' ? chatId.trim() : '';
      if (!normalizedChatId) {
        return;
      }

      const normalizedModelId = normalizeModelId(modelId);
      const normalizedEffort = normalizeReasoningEffort(effort);
      const normalizedServiceTier = toSelectedServiceTier(
        normalizeServiceTier(serviceTier)
      );
      const updatedAt = new Date().toISOString();
      const nextPreference: ChatModelPreference = {
        modelId: normalizedModelId,
        effort: normalizedEffort,
        serviceTier: normalizedServiceTier,
        updatedAt,
      };
      const agentPreferenceKey = activeAgentId
        ? agentModelPreferenceKey(activeAgentId)
        : null;
      const previous = chatModelPreferencesRef.current[normalizedChatId];
      const previousAgent = agentPreferenceKey
        ? chatModelPreferencesRef.current[agentPreferenceKey]
        : null;
      if (
        previous &&
        previous.modelId === normalizedModelId &&
        previous.effort === normalizedEffort &&
        previous.serviceTier === normalizedServiceTier &&
        (!agentPreferenceKey || (
          previousAgent?.modelId === normalizedModelId &&
          previousAgent?.effort === normalizedEffort &&
          previousAgent?.serviceTier === normalizedServiceTier
        ))
      ) {
        return;
      }

      const nextPreferences: Record<string, ChatModelPreference> = {
        ...chatModelPreferencesRef.current,
        [normalizedChatId]: nextPreference,
        ...(agentPreferenceKey ? { [agentPreferenceKey]: nextPreference } : {}),
      };
      chatModelPreferencesRef.current = nextPreferences;
      if (chatIdRef.current === normalizedChatId) {
        setSelectedModelId(normalizedModelId);
        setSelectedEffort(normalizedEffort);
        setSelectedServiceTier(normalizedServiceTier);
      }
      void saveChatModelPreferences(nextPreferences);
    },
    [activeAgentId, saveChatModelPreferences]
  );

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const preferences = await persistenceController.loadModelPreferences();
      if (!cancelled) {
        chatModelPreferencesRef.current = preferences;
        setChatModelPreferencesLoaded(true);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [persistenceController]);

  useEffect(() => {
    setDefaultServiceTier(null);
  }, [activeAgentId]);

  return {
    toggleWorkspaceFavorite,
    rememberChatPlanSnapshot,
    rememberBridgeUiSurfaceSnapshots,
    rememberChatModelPreference,
  };
}

export type MainScreenChatHydrationResult = ReturnType<typeof useMainScreenChatHydration>;
