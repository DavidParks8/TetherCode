import * as FileSystem from 'expo-file-system/legacy';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CHAT_DRAFTS_VERSION,
  getChatDraftsPath,
  parseChatDrafts,
} from '../mainScreenHelpers';
import { submissionScopeKey, type SubmissionDraftSnapshot } from './submissionController';

export interface DraftStorage {
  read(path: string): Promise<string>;
  write(path: string, value: string): Promise<void>;
}

const fileDraftStorage: DraftStorage = {
  read: FileSystem.readAsStringAsync,
  write: FileSystem.writeAsStringAsync,
};

export function updateDraftEntries(
  entries: Readonly<Record<string, string>>,
  ownerKey: string,
  draft: string
): Record<string, string> {
  const next = { ...entries };
  if (draft.trim()) {
    next[ownerKey] = draft;
  } else {
    delete next[ownerKey];
  }
  return next;
}

export function serializeDraftEntries(entries: Readonly<Record<string, string>>): string {
  return JSON.stringify({ version: CHAT_DRAFTS_VERSION, entries });
}

export interface DraftController {
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  clearDraft: () => void;
  snapshot: () => SubmissionDraftSnapshot;
}

export function useDraftController(
  profileId: string,
  chatId: string | null,
  storage: DraftStorage = fileDraftStorage
): DraftController {
  const scopeKey = submissionScopeKey({ profileId, threadId: chatId });
  const [draft, setDraftState] = useState('');
  const [ownerKey, setOwnerKey] = useState(scopeKey);
  const [loaded, setLoaded] = useState(false);
  const entriesRef = useRef<Record<string, string>>({});
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef('');
  const scopeKeyRef = useRef(scopeKey);
  const revisionRef = useRef(0);
  if (scopeKeyRef.current !== scopeKey) {
    scopeKeyRef.current = scopeKey;
    revisionRef.current += 1;
  }

  const setDraft = useCallback<React.Dispatch<React.SetStateAction<string>>>((next) => {
    const value = typeof next === 'function' ? next(draftRef.current) : next;
    if (value === draftRef.current) return;
    draftRef.current = value;
    revisionRef.current += 1;
    setDraftState(value);
  }, []);

  const persist = useCallback(
    async (entries: Readonly<Record<string, string>>) => {
      const path = getChatDraftsPath();
      if (!path) return;
      try {
        await storage.write(path, serializeDraftEntries(entries));
      } catch {
        // Draft persistence is best effort.
      }
    },
    [storage]
  );

  useEffect(() => {
    let cancelled = false;
    const path = getChatDraftsPath();
    if (!path) {
      setLoaded(true);
      return;
    }
    void storage
      .read(path)
      .then((raw) => {
        if (!cancelled) entriesRef.current = parseChatDrafts(raw);
      })
      .catch(() => {
        if (!cancelled) entriesRef.current = {};
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [storage]);

  useEffect(() => {
    if (!loaded) return;
    const nextDraft = entriesRef.current[scopeKey] ?? '';
    scopeKeyRef.current = scopeKey;
    draftRef.current = nextDraft;
    revisionRef.current += 1;
    setOwnerKey(scopeKey);
    setDraftState((current) => (current === nextDraft ? current : nextDraft));
  }, [loaded, scopeKey]);

  useEffect(() => {
    if (!loaded) return;
    const previous = entriesRef.current[ownerKey] ?? '';
    if (previous === draft) return;
    entriesRef.current = updateDraftEntries(entriesRef.current, ownerKey, draft);
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      void persist(entriesRef.current);
    }, 180);
  }, [draft, loaded, ownerKey, persist]);

  useEffect(
    () => () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      void persist(entriesRef.current);
    },
    [persist]
  );

  return {
    draft,
    setDraft,
    clearDraft: useCallback(() => setDraft(''), []),
    snapshot: useCallback(
      () => ({
        scopeKey: scopeKeyRef.current,
        value: draftRef.current,
        revision: revisionRef.current,
      }),
      []
    ),
  };
}
