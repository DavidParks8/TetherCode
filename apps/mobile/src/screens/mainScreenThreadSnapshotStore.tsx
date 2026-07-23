import { useCallback, useEffect } from 'react';
import type { BridgeUiSurface } from '../api/types';
import { type ActivePlanState, type ThreadContextUsage, RUN_WATCHDOG_MS, type ChatModelPreference, toRecord, readIntegerLike } from './mainScreenHelpers';
import type { MainScreenLocalTranscriptActionsContext, MainScreenLocalTranscriptActionsResult } from './mainScreenLocalTranscriptActions';






export type MainScreenThreadSnapshotStoreContext = MainScreenLocalTranscriptActionsContext & MainScreenLocalTranscriptActionsResult;

export function useMainScreenThreadSnapshotStore(context: MainScreenThreadSnapshotStoreContext) {
  const {
    api,
    bridgeUiSurfacePersistenceTimeoutRef,
    parentChatCacheRef,
    persistenceController,
    runWatchdogTimerRef,
    runWatchdogUntilRef,
    selectedChat,
    setRunWatchdogNow,
    setSelectedParentChat,
  } = context;


  useEffect(() => {
    const parentThreadId = selectedChat?.parentThreadId?.trim();
    if (!parentThreadId) {
      setSelectedParentChat(null);
      return;
    }

    const cachedParentChat = parentChatCacheRef.current[parentThreadId];
    if (cachedParentChat) {
      setSelectedParentChat(cachedParentChat);
      return;
    }

    let cancelled = false;

    api
      .getChat(parentThreadId)
      .then((parentChat) => {
        parentChatCacheRef.current[parentThreadId] = parentChat;
        if (!cancelled) {
          setSelectedParentChat(parentChat);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedParentChat(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, selectedChat?.id, selectedChat?.parentThreadId]);

  const scheduleRunWatchdogExpiry = useCallback((deadlineMs: number) => {
    const existingTimer = runWatchdogTimerRef.current;
    if (existingTimer) {
      clearTimeout(existingTimer);
      runWatchdogTimerRef.current = null;
    }

    const delayMs = deadlineMs - Date.now();
    if (delayMs <= 0) {
      return;
    }

    runWatchdogTimerRef.current = setTimeout(() => {
      runWatchdogTimerRef.current = null;
      setRunWatchdogNow(Date.now());
    }, delayMs + 16);
  }, []);

  const bumpRunWatchdog = useCallback(
    (durationMs = RUN_WATCHDOG_MS) => {
      const deadlineMs = Math.max(runWatchdogUntilRef.current, Date.now() + durationMs);
      runWatchdogUntilRef.current = deadlineMs;
      setRunWatchdogNow(Date.now());
      scheduleRunWatchdogExpiry(deadlineMs);
    },
    [scheduleRunWatchdogExpiry]
  );

  const clearRunWatchdog = useCallback(() => {
    runWatchdogUntilRef.current = 0;
    const existingTimer = runWatchdogTimerRef.current;
    if (existingTimer) {
      clearTimeout(existingTimer);
      runWatchdogTimerRef.current = null;
    }
    setRunWatchdogNow(Date.now());
  }, []);

  useEffect(() => {
    return () => {
      const existingTimer = runWatchdogTimerRef.current;
      if (existingTimer) {
        clearTimeout(existingTimer);
        runWatchdogTimerRef.current = null;
      }
    };
  }, []);

  const readThreadContextUsage = useCallback(
    (value: unknown): ThreadContextUsage | null => {
      const record = toRecord(value);
      if (!record) {
        return null;
      }

      const turnRecord = toRecord(record.turn);
      const tokenUsageRecord =
        toRecord(record.tokenUsage) ??
        toRecord(record.token_usage) ??
        toRecord(toRecord(record.info)?.tokenUsage) ??
        toRecord(toRecord(record.info)?.token_usage);
      const infoRecord = toRecord(record.info);

      const totalRecord =
        toRecord(tokenUsageRecord?.total) ??
        toRecord(infoRecord?.total_token_usage) ??
        toRecord(infoRecord?.totalTokenUsage);
      const lastRecord =
        toRecord(tokenUsageRecord?.last) ??
        toRecord(infoRecord?.last_token_usage) ??
        toRecord(infoRecord?.lastTokenUsage);

      const totalTokens =
        readIntegerLike(totalRecord?.totalTokens) ??
        readIntegerLike(totalRecord?.total_tokens);

      const lastTokens =
        readIntegerLike(lastRecord?.totalTokens) ??
        readIntegerLike(lastRecord?.total_tokens) ??
        (totalTokens !== null ? 0 : null);
      const modelContextWindow =
        readIntegerLike(record.modelContextWindow) ??
        readIntegerLike(record.model_context_window) ??
        readIntegerLike(turnRecord?.modelContextWindow) ??
        readIntegerLike(turnRecord?.model_context_window) ??
        readIntegerLike(tokenUsageRecord?.modelContextWindow) ??
        readIntegerLike(tokenUsageRecord?.model_context_window) ??
        readIntegerLike(infoRecord?.modelContextWindow) ??
        readIntegerLike(infoRecord?.model_context_window);

      if (totalTokens === null && modelContextWindow === null) {
        return null;
      }

      return {
        totalTokens,
        lastTokens,
        modelContextWindow,
        updatedAtMs: Date.now(),
      };
    },
    []
  );

  const saveChatModelPreferences = useCallback(
    (nextPreferences: Record<string, ChatModelPreference>) =>
      persistenceController.saveModelPreferences(nextPreferences),
    [persistenceController]
  );

  const saveChatPlanSnapshots = useCallback(
    (nextSnapshots: Record<string, ActivePlanState>) =>
      persistenceController.savePlanSnapshots(nextSnapshots),
    [persistenceController]
  );

  const saveBridgeUiSurfaceSnapshots = useCallback(
    (nextSnapshots: Record<string, BridgeUiSurface[]>) =>
      persistenceController.saveBridgeUiSurfaces(nextSnapshots),
    [persistenceController]
  );

  const scheduleBridgeUiSurfaceSnapshotsPersist = useCallback(
    (nextSnapshots: Record<string, BridgeUiSurface[]>) => {
      const existingTimer = bridgeUiSurfacePersistenceTimeoutRef.current;
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      bridgeUiSurfacePersistenceTimeoutRef.current = setTimeout(() => {
        bridgeUiSurfacePersistenceTimeoutRef.current = null;
        void saveBridgeUiSurfaceSnapshots(nextSnapshots);
      }, 180);
    },
    [saveBridgeUiSurfaceSnapshots]
  );

  const saveWorkspaceFavorites = useCallback(
    (paths: string[]) => persistenceController.saveWorkspaceFavorites(paths),
    [persistenceController]
  );

  return {
    scheduleRunWatchdogExpiry,
    bumpRunWatchdog,
    clearRunWatchdog,
    readThreadContextUsage,
    saveChatModelPreferences,
    saveChatPlanSnapshots,
    saveBridgeUiSurfaceSnapshots,
    scheduleBridgeUiSurfaceSnapshotsPersist,
    saveWorkspaceFavorites,
  };
}

export type MainScreenThreadSnapshotStoreResult = ReturnType<typeof useMainScreenThreadSnapshotStore>;
