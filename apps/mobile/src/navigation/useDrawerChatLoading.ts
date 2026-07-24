import { useCallback, useEffect, useRef, useState } from 'react'; import type { HostBridgeApiClient } from '../api/client';
import type { ChatSummary, RpcNotification } from '../api/types';
import type { HostBridgeWsClient } from '../api/ws';
import { pruneStaleDrawerRunIndicators, reconcileDrawerRunIndicatorsWithChats,
  updateDrawerRunIndicatorsForEvent, type DrawerRunIndicatorMap } from './drawerRuntimeIndicators';
import { areDrawerChatListsEquivalent, dedupeChatsById, mergeDrawerChatBatch, sortChats } from './drawerContentHelpers';
import { DRAWER_CHAT_CACHE_TTL_MS, DRAWER_DEEP_CHAT_CACHE_TTL_MS, DRAWER_DEEP_CHAT_PAGE_LIMIT,
  DRAWER_DEEP_LOAD_DELAY_MS, DRAWER_EVENT_REFRESH_DEBOUNCE_MS, DRAWER_FAST_CHAT_LIST_LIMIT,
  DRAWER_FULL_CHAT_LIST_LIMIT, DRAWER_OPEN_STALE_REFRESH_MS, DRAWER_REFRESH_CONNECTED_MS,
  DRAWER_REFRESH_DISCONNECTED_MS, DRAWER_STREAM_BATCH_DELAY_MS, DRAWER_STREAM_CHAT_LIST_LIMITS,
  drawerEventRequiresRefresh, type DrawerChatLoadingState } from './drawerChatLoadingConfig';

export function useDrawerChatLoading(api: HostBridgeApiClient, ws: HostBridgeWsClient, active: boolean): DrawerChatLoadingState {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlderChats, setLoadingOlderChats] = useState(false);
  const [partialHistoryDiagnostics, setPartialHistoryDiagnostics] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [runIndicatorsByThread, setRunIndicatorsByThread] = useState<DrawerRunIndicatorMap>({});
  const [wsConnected, setWsConnected] = useState(ws.isConnected);
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
  const hasHydratedOnceRef = useRef(false);
  const lastLoadedAtRef = useRef(0);
  const activeRef = useRef(active);
  const chatsRef = useRef<ChatSummary[]>([]);
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

      const applyChats = (rawChats: ChatSummary[], cacheLimit?: number) => {
        const incomingChats = sortChats(dedupeChatsById(rawChats));
        const shouldPreserveExisting =
          hasHydratedOnceRef.current || chatsRef.current.length > incomingChats.length;
        const nextChats = shouldPreserveExisting
          ? mergeDrawerChatBatch(chatsRef.current, incomingChats)
          : incomingChats;
        chatsRef.current = nextChats;
        setChats((previous) =>
          areDrawerChatListsEquivalent(previous, nextChats) ? previous : nextChats
        );
        if (cacheLimit) {
          const cacheKeyLimit = Math.max(cacheLimit, Math.min(nextChats.length, 200));
          api.rememberChats(nextChats, { limit: cacheKeyLimit });
        }
        hasHydratedOnceRef.current = true;
        lastLoadedAtRef.current = Date.now();
        setLoading(false);

        setRunIndicatorsByThread((prev) => reconcileDrawerRunIndicatorsWithChats(prev, nextChats));
      };

      const hydrateLoadedChats = async (listedChats: ChatSummary[], cacheLimit?: number) => {
        const listedChatIds = new Set(listedChats.map((chat) => chat.id));
        try {
          const loadedIds = await api.listLoadedChatIds();
          const missingIds = loadedIds.filter((threadId) => !listedChatIds.has(threadId));
          if (missingIds.length === 0) {
            return;
          }

          const loadedChats = await api.getChatSummaries(missingIds);
          if (loadedChats.length > 0 && activeRef.current) {
            applyChats([...listedChats, ...loadedChats], cacheLimit);
          }
        } catch {
          // Keep the drawer usable if loaded-thread hydration fails.
        }
      };

      const applyCachedDeepChats = () => {
        const cachedDeepChats = api.peekAllChats();
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
              setPartialHistoryDiagnostics(result.partial ? result.diagnostics : []);
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

        const cachedFullChats = api.peekChats({ limit: DRAWER_FULL_CHAT_LIST_LIMIT });
        const cachedFastChats = cachedFullChats
          ? null
          : api.peekChats({ limit: DRAWER_FAST_CHAT_LIST_LIMIT });
        if (cachedFullChats) {
          applyChats(cachedFullChats, DRAWER_FULL_CHAT_LIST_LIMIT);
        } else if (cachedFastChats) {
          applyChats(cachedFastChats, DRAWER_FAST_CHAT_LIST_LIMIT);
        }

        cancelChatListStream();
        const stream = await api.startChatListStream(
          {
            limits: DRAWER_STREAM_CHAT_LIST_LIMITS,
            delayMs: DRAWER_STREAM_BATCH_DELAY_MS,
          },
          (batch) => {
            if (!activeRef.current) {
              return;
            }
            applyChats(batch.chats, batch.limit);
            if (showRefresh) {
              setRefreshing(false);
            }
            if (batch.done) {
              streamFinished = true;
              chatListStreamRef.current = null;
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
        if (!streamFinished) {
          chatListStreamRef.current = stream;
        }
      } catch {
        try {
          const fastListedChats = await api.listChats({
            limit: DRAWER_FAST_CHAT_LIST_LIMIT,
            cacheTtlMs: DRAWER_CHAT_CACHE_TTL_MS,
            forceRefresh,
          });
          if (activeRef.current) {
            applyChats(fastListedChats, DRAWER_FAST_CHAT_LIST_LIMIT);
          }

          const fullListedChats = await api.listChats({
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
    [api, cancelChatListStream]
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
  }, [active]);

  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);

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

  useEffect(() => {
    return ws.onEvent((event: RpcNotification) => {
      if (event.method === 'bridge/events/snapshotRequired') {
        setRunIndicatorsByThread({});
        scheduleLoadChats(0, true);
        return;
      }

      setRunIndicatorsByThread((prev) => updateDrawerRunIndicatorsForEvent(prev, event));
      if (drawerEventRequiresRefresh(event)) {
        scheduleLoadChats(DRAWER_EVENT_REFRESH_DEBOUNCE_MS, true);
      }
    });
  }, [scheduleLoadChats, ws]);

  useEffect(() => {
    return ws.onStatus((connected) => {
      setWsConnected(connected);
      if (connected) {
        scheduleLoadChats(DRAWER_EVENT_REFRESH_DEBOUNCE_MS, true);
      }
    });
  }, [scheduleLoadChats, ws]);

  useEffect(() => {
    const timer = setInterval(() => {
      setRunIndicatorsByThread((prev) => pruneStaleDrawerRunIndicators(prev));
    }, 5000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!active) {
      return;
    }

    const timer = setInterval(() => {
      scheduleLoadChats();
    }, wsConnected ? DRAWER_REFRESH_CONNECTED_MS : DRAWER_REFRESH_DISCONNECTED_MS);

    return () => clearInterval(timer);
  }, [active, scheduleLoadChats, wsConnected]);

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

  return { chats, loading, loadingOlderChats, partialHistoryDiagnostics, refreshing,
    runIndicatorsByThread, wsConnected, loadChats, retryDeepChatListRef, cancelChatListStream,
    scheduleLoadChats, setRunIndicatorsByThread };
}
