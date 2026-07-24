import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { HostBridgeApiClient } from '../api/client';
import type { ChatSummary } from '../api/types';

const PRIORITY_SESSION_HYDRATION_DIAGNOSTIC =
  'Some pending request sessions could not be loaded.';

interface DrawerPrioritySessionHydrationOptions {
  active: boolean;
  api: HostBridgeApiClient;
  applyChats: (chats: ChatSummary[]) => void;
  chats: ChatSummary[];
  chatsRef: { current: ChatSummary[] };
  priorityThreadIds: readonly string[];
  setDiagnostics: Dispatch<SetStateAction<string[]>>;
}

export function useDrawerPrioritySessionHydration({
  active,
  api,
  applyChats,
  chats,
  chatsRef,
  priorityThreadIds,
  setDiagnostics,
}: DrawerPrioritySessionHydrationOptions): void {
  useEffect(() => {
    if (!active) {
      return;
    }
    const currentChatIds = new Set(chats.map((chat) => chat.id));
    const missingThreadIds = Array.from(
      new Set(priorityThreadIds.map((threadId) => threadId.trim()).filter(Boolean))
    ).filter((threadId) => !currentChatIds.has(threadId));
    const updateDiagnostic = (show: boolean) => {
      setDiagnostics((previous) => {
        const remaining = previous.filter(
          (message) => message !== PRIORITY_SESSION_HYDRATION_DIAGNOSTIC
        );
        return show
          ? [...remaining, PRIORITY_SESSION_HYDRATION_DIAGNOSTIC]
          : remaining;
      });
    };
    if (missingThreadIds.length === 0) {
      updateDiagnostic(false);
      return;
    }

    let cancelled = false;
    void api.getChatSummaries(missingThreadIds)
      .then((summaries) => {
        if (cancelled) {
          return;
        }
        if (summaries.length > 0) {
          applyChats(summaries);
        }
        const loadedIds = new Set(chatsRef.current.map((chat) => chat.id));
        updateDiagnostic(missingThreadIds.some((threadId) => !loadedIds.has(threadId)));
      })
      .catch(() => {
        if (!cancelled) {
          const loadedIds = new Set(chatsRef.current.map((chat) => chat.id));
          updateDiagnostic(missingThreadIds.some((threadId) => !loadedIds.has(threadId)));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, api, applyChats, chats, chatsRef, priorityThreadIds, setDiagnostics]);
}
