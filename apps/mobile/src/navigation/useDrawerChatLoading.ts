import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostBridgeApiClient } from '../api/client';
import type { HostBridgeWsClient } from '../api/ws';
import { DRAWER_CHAT_CACHE_TTL_MS, DRAWER_DEEP_CHAT_CACHE_TTL_MS, DRAWER_DEEP_CHAT_PAGE_LIMIT,
  DRAWER_DEEP_LOAD_DELAY_MS, DRAWER_EVENT_REFRESH_DEBOUNCE_MS, DRAWER_FAST_CHAT_LIST_LIMIT,
  DRAWER_FULL_CHAT_LIST_LIMIT, DRAWER_OPEN_STALE_REFRESH_MS, DRAWER_STREAM_BATCH_DELAY_MS,
  DRAWER_STREAM_CHAT_LIST_LIMITS, type DrawerChatLoadingState } from './drawerChatLoadingConfig';
import { useDrawerPrioritySessionHydration } from './useDrawerPrioritySessionHydration';
import { useDrawerChatCollection } from './useDrawerChatCollection';
import { useDrawerLoadedChatHydration } from './useDrawerLoadedChatHydration';
import { useDrawerChatLiveSync } from './useDrawerChatLiveSync';

export function useDrawerChatLoading(
  api: HostBridgeApiClient,
  ws: HostBridgeWsClient,
  active: boolean,
  priorityThreadIds: readonly string[] = []
): DrawerChatLoadingState {
  const [loading, setLoading] = useState(true);
  const [loadingOlderChats, setLoadingOlderChats] = useState(false);
  const [deepHistoryDiagnostics, setDeepHistoryDiagnostics] = useState<string[]>([]);
  const [hydrationDiagnostics, setHydrationDiagnostics] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [wsConnected, setWsConnected] = useState(ws.isConnected);
  const handleChatsApplied = useCallback(() => {
    setLoading(false);
  }, []);
  const {
    applyChats,
    chats,
    chatsRef,
    hasHydratedOnceRef,
    lastLoadedAtRef,
    runIndicatorsByThread,
    setRunIndicatorsByThread,
  } = useDrawerChatCollection(api, handleChatsApplied);
  const loadChatsInFlightRef = useRef<Promise<void> | null>(null);
  const queuedLoadChatsRef = useRef<{ showRefresh: boolean; forceRefresh: boolean } | null>(
    null
  );
  const scheduledLoadChatsRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduledLoadChatsForceRefreshRef = useRef(false);
  const scheduledDeepLoadChatsRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatListStreamRef = useRef<{ cancel: () => void } | null>(null);
  const deepLoadInFlightRef = useRef<Promise<void> | null>(null);
  const hasLoadedDeepChatListRef = useRef(false);
  const activeRef = useRef(active);
  const hydrateLoadedChats = useDrawerLoadedChatHydration({
    activeRef,
    api,
    applyChats,
    setDiagnostics: setHydrationDiagnostics,
  });
  const cancelChatListStream = useCallback(() => {
    chatListStreamRef.current?.cancel();
    chatListStreamRef.current = null;
    if (scheduledDeepLoadChatsRef.current) {
      clearTimeout(scheduledDeepLoadChatsRef.current);
      scheduledDeepLoadChatsRef.current = null;
    }
  }, []);

  const loadChatsNow = useCallback(
    async (showRefresh = false, forceRefresh = false) => {
      if (showRefresh) {
        setRefreshing(true);
      }

      const applyCachedDeepChats = () => {
        const cachedDeepChats = api.peekAllChats({ includeSubAgents: true });
        if (!cachedDeepChats) {
          return false;
        }

        hasLoadedDeepChatListRef.current = true;
        if (activeRef.current) {
          setLoadingOlderChats(false);
        }
        applyChats(cachedDeepChats);
        return true;
      };

      const loadDeepChatsOnce = async (forceDeepRefresh = false) => {
        if (hasLoadedDeepChatListRef.current || deepLoadInFlightRef.current) {
          return;
        }
        if (!forceDeepRefresh && applyCachedDeepChats()) {
          return;
        }

        const request = api
          .listAllChats({
            includeSubAgents: true,
            pageLimit: DRAWER_DEEP_CHAT_PAGE_LIMIT,
            cacheTtlMs: DRAWER_DEEP_CHAT_CACHE_TTL_MS,
            forceRefresh: forceDeepRefresh,
            onPage: (loadedChats) => {
              if (activeRef.current) {
                applyChats(loadedChats);
              }
            },
          })
          .then((result) => {
            hasLoadedDeepChatListRef.current = true;
            if (activeRef.current) {
              applyChats(result.chats);
              void hydrateLoadedChats(result.chats);
              setDeepHistoryDiagnostics(result.partial ? result.diagnostics : []);
            }
          })
          .catch(() => {})
          .finally(() => {
            deepLoadInFlightRef.current = null;
            if (activeRef.current) {
              setLoadingOlderChats(false);
            }
          });

        if (activeRef.current) {
          setLoadingOlderChats(true);
        }
        deepLoadInFlightRef.current = request;
        await request;
      };

      const scheduleDeepLoadChatsOnce = () => {
        if (deepLoadInFlightRef.current) {
          if (activeRef.current) {
            setLoadingOlderChats(true);
          }
          return;
        }
        if (
          hasLoadedDeepChatListRef.current ||
          scheduledDeepLoadChatsRef.current
        ) {
          return;
        }
        if (applyCachedDeepChats()) {
          return;
        }

        scheduledDeepLoadChatsRef.current = setTimeout(() => {
          scheduledDeepLoadChatsRef.current = null;
          if (activeRef.current) {
            void loadDeepChatsOnce();
          }
        }, DRAWER_DEEP_LOAD_DELAY_MS);
      };

      retryDeepChatListRef.current = async () => {
        hasLoadedDeepChatListRef.current = false;
        await loadDeepChatsOnce(true);
      };

      let streamStarted = false;
      let streamFinished = false;
      if (!activeRef.current) {
        try {
          await api.listChats({
            includeSubAgents: true,
            limit: DRAWER_FAST_CHAT_LIST_LIMIT,
            cacheTtlMs: DRAWER_CHAT_CACHE_TTL_MS,
            forceRefresh,
          });
        } catch {
          // Hidden drawer priming is best effort.
        }
        return;
      }

      try {
        const hasCachedDeepChats = applyCachedDeepChats();
        if (hasCachedDeepChats) {
          try {
            const latestChats = await api.listChats({
              includeSubAgents: true,
              limit: showRefresh ? DRAWER_FULL_CHAT_LIST_LIMIT : DRAWER_FAST_CHAT_LIST_LIMIT,
              cacheTtlMs: DRAWER_CHAT_CACHE_TTL_MS,
              forceRefresh,
            });
            if (activeRef.current) {
              applyChats(
                latestChats,
                showRefresh ? DRAWER_FULL_CHAT_LIST_LIMIT : DRAWER_FAST_CHAT_LIST_LIMIT
              );
            }
          } catch {
            // The cached full list is already visible; newest-chat refresh is best effort.
          }
          return;
        }

        const cachedFullChats = api.peekChats({
          includeSubAgents: true,
          limit: DRAWER_FULL_CHAT_LIST_LIMIT,
        });
        const cachedFastChats = cachedFullChats
          ? null
          : api.peekChats({
              includeSubAgents: true,
              limit: DRAWER_FAST_CHAT_LIST_LIMIT,
            });
        if (cachedFullChats) {
          applyChats(cachedFullChats, DRAWER_FULL_CHAT_LIST_LIMIT);
        } else if (cachedFastChats) {
          applyChats(cachedFastChats, DRAWER_FAST_CHAT_LIST_LIMIT);
        }

        cancelChatListStream();
        const stream = await api.startChatListStream(
          {
            includeSubAgents: true,
            limits: DRAWER_STREAM_CHAT_LIST_LIMITS,
            delayMs: DRAWER_STREAM_BATCH_DELAY_MS,
          },
          (batch) => {
            if (batch.done) {
              streamFinished = true;
              chatListStreamRef.current = null;
            }
            if (!activeRef.current) {
              return;
            }
            applyChats(batch.chats, batch.limit);
            if (showRefresh) {
              setRefreshing(false);
            }
            if (batch.done) {
              void hydrateLoadedChats(batch.chats, batch.limit);
              scheduleDeepLoadChatsOnce();
            }
          },
          () => {
            streamFinished = true;
            chatListStreamRef.current = null;
            if (showRefresh) {
              setRefreshing(false);
            }
            setLoading(false);
          }
        );
        streamStarted = true;
        if (!activeRef.current) {
          stream.cancel();
          streamFinished = true;
          chatListStreamRef.current = null;
          return;
        }
        if (!streamFinished) {
          chatListStreamRef.current = stream;
        }
      } catch {
        try {
          const fastListedChats = await api.listChats({
            includeSubAgents: true,
            limit: DRAWER_FAST_CHAT_LIST_LIMIT,
            cacheTtlMs: DRAWER_CHAT_CACHE_TTL_MS,
            forceRefresh,
          });
          if (activeRef.current) {
            applyChats(fastListedChats, DRAWER_FAST_CHAT_LIST_LIMIT);
          }

          const fullListedChats = await api.listChats({
            includeSubAgents: true,
            limit: DRAWER_FULL_CHAT_LIST_LIMIT,
            cacheTtlMs: DRAWER_CHAT_CACHE_TTL_MS,
            forceRefresh,
          });
          if (activeRef.current) {
            applyChats(fullListedChats, DRAWER_FULL_CHAT_LIST_LIMIT);
            void hydrateLoadedChats(fullListedChats, DRAWER_FULL_CHAT_LIST_LIMIT);
            scheduleDeepLoadChatsOnce();
          }
        } catch {
          // silently fail
        }
      } finally {
        if (!streamStarted || streamFinished) {
          if (showRefresh) {
            setRefreshing(false);
          }
          setLoading(false);
        }
      }
    },
    [api, applyChats, cancelChatListStream, hydrateLoadedChats]
  );

  const loadChats = useCallback(
    (showRefresh = false, forceRefresh = false) => {
      if (!active && hasHydratedOnceRef.current) {
        return Promise.resolve();
      }

      if (chatListStreamRef.current && !showRefresh) {
        return Promise.resolve();
      }

      if (showRefresh && scheduledLoadChatsRef.current) {
        clearTimeout(scheduledLoadChatsRef.current);
        scheduledLoadChatsRef.current = null;
      }

      if (loadChatsInFlightRef.current) {
        queuedLoadChatsRef.current = {
          showRefresh: showRefresh || queuedLoadChatsRef.current?.showRefresh === true,
          forceRefresh: forceRefresh || queuedLoadChatsRef.current?.forceRefresh === true,
        };
        return loadChatsInFlightRef.current;
      }

      const promise = loadChatsNow(showRefresh, forceRefresh).finally(() => {
        loadChatsInFlightRef.current = null;
        const queuedRequest = queuedLoadChatsRef.current;
        queuedLoadChatsRef.current = null;
        if (queuedRequest && !(chatListStreamRef.current && !queuedRequest.showRefresh)) {
          void loadChats(queuedRequest.showRefresh, queuedRequest.forceRefresh);
        }
      });

      loadChatsInFlightRef.current = promise;
      return promise;
    },
    [active, loadChatsNow]
  );
  const retryDeepChatListRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    activeRef.current = active;
    return () => {
      activeRef.current = false;
    };
  }, [active]);

  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);

  useDrawerPrioritySessionHydration({
    active,
    api,
    applyChats,
    chats,
    chatsRef,
    priorityThreadIds,
    setDiagnostics: setHydrationDiagnostics,
  });

  const scheduleLoadChats = useCallback(
    (delay = DRAWER_EVENT_REFRESH_DEBOUNCE_MS, forceRefresh = false) => {
      if (!active) {
        return;
      }

      if (scheduledLoadChatsRef.current) {
        scheduledLoadChatsForceRefreshRef.current =
          scheduledLoadChatsForceRefreshRef.current || forceRefresh;
        return;
      }

      scheduledLoadChatsForceRefreshRef.current = forceRefresh;
      scheduledLoadChatsRef.current = setTimeout(() => {
        scheduledLoadChatsRef.current = null;
        const shouldForceRefresh = scheduledLoadChatsForceRefreshRef.current;
        scheduledLoadChatsForceRefreshRef.current = false;
        void loadChats(false, shouldForceRefresh);
      }, delay);
    },
    [active, loadChats]
  );

  useEffect(() => {
    setWsConnected(ws.isConnected);
    const shouldPrimeHiddenDrawer = !hasHydratedOnceRef.current;
    const shouldRefreshVisibleDrawer =
      active && Date.now() - lastLoadedAtRef.current > DRAWER_OPEN_STALE_REFRESH_MS;
    if (!shouldPrimeHiddenDrawer && !shouldRefreshVisibleDrawer) {
      return;
    }

    void loadChats(false, shouldRefreshVisibleDrawer);
  }, [active, loadChats, ws]);

  useDrawerChatLiveSync({
    active,
    scheduleLoadChats,
    setRunIndicators: setRunIndicatorsByThread,
    setWsConnected,
    ws,
    wsConnected,
  });

  useEffect(() => {
    if (active) {
      return;
    }

    if (scheduledLoadChatsRef.current) {
      clearTimeout(scheduledLoadChatsRef.current);
      scheduledLoadChatsRef.current = null;
    }
    scheduledLoadChatsForceRefreshRef.current = false;
    cancelChatListStream();
    queuedLoadChatsRef.current = null;
    setRefreshing(false);
    setLoadingOlderChats(false);
  }, [active, cancelChatListStream]);

  useEffect(() => {
    return () => {
      if (scheduledLoadChatsRef.current) {
        clearTimeout(scheduledLoadChatsRef.current);
        scheduledLoadChatsRef.current = null;
      }
      scheduledLoadChatsForceRefreshRef.current = false;
      cancelChatListStream();
    };
  }, [cancelChatListStream]);

  const partialHistoryDiagnostics = useMemo(
    () => Array.from(new Set([...deepHistoryDiagnostics, ...hydrationDiagnostics])),
    [deepHistoryDiagnostics, hydrationDiagnostics]
  );
  return { chats, loading, loadingOlderChats, partialHistoryDiagnostics, refreshing,
    runIndicatorsByThread, wsConnected, loadChats, retryDeepChatListRef, cancelChatListStream,
    scheduleLoadChats, setRunIndicatorsByThread };
}
