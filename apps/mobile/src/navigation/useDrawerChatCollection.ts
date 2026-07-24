import { useCallback, useRef, useState } from 'react';
import type { HostBridgeApiClient } from '../api/client';
import type { ChatSummary } from '../api/types';
import {
  areDrawerChatListsEquivalent,
  dedupeChatsById,
  mergeDrawerChatBatch,
  sortChats,
} from './drawerContentHelpers';
import {
  reconcileDrawerRunIndicatorsWithChats,
  type DrawerRunIndicatorMap,
} from './drawerRuntimeIndicators';

export function useDrawerChatCollection(
  api: HostBridgeApiClient,
  onChatsApplied: () => void
) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [runIndicatorsByThread, setRunIndicatorsByThread] =
    useState<DrawerRunIndicatorMap>({});
  const chatsRef = useRef<ChatSummary[]>([]);
  const hasHydratedOnceRef = useRef(false);
  const lastLoadedAtRef = useRef(0);

  const applyChats = useCallback((rawChats: ChatSummary[], cacheLimit?: number) => {
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
      api.rememberChats(nextChats, { includeSubAgents: true, limit: cacheKeyLimit });
    }
    hasHydratedOnceRef.current = true;
    lastLoadedAtRef.current = Date.now();
    onChatsApplied();
    setRunIndicatorsByThread((previous) =>
      reconcileDrawerRunIndicatorsWithChats(previous, nextChats)
    );
  }, [api, onChatsApplied]);

  return {
    applyChats,
    chats,
    chatsRef,
    hasHydratedOnceRef,
    lastLoadedAtRef,
    runIndicatorsByThread,
    setRunIndicatorsByThread,
  };
}
