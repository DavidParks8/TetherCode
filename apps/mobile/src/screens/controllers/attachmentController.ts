import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

import type { HostBridgeApiClient } from '../../api/client';
import type { Chat, LocalImageInput, MentionInput } from '../../api/types';
import {
  type AttachmentMenuAction,
  type ComposerAttachmentChip,
  draftContainsMentionLabel,
  normalizeAttachmentPath,
  normalizeWorkspacePath,
  replaceActiveMentionQueryWithSelection,
  scheduleIdleTask,
  toAttachmentPathSuggestions,
  toMentionInput,
  toPathBasename,
} from '../mainScreenHelpers';

type AttachmentApi = Pick<HostBridgeApiClient, 'execTerminal' | 'uploadAttachment'>;

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_LABEL = '20 MB';
const IMAGE_MAX_DIMENSION = 2048;
const IMAGE_COMPRESSION = 0.8;

export interface PreparedAttachment {
  id: string;
  uri: string;
  fileName?: string;
  mimeType?: string;
  kind: 'file' | 'image';
  sizeBytes: number;
  status: 'uploading' | 'failed';
}

export function attachmentSizeError(sizeBytes: number): string | null {
  return sizeBytes > ATTACHMENT_MAX_BYTES
    ? `Attachment exceeds the ${ATTACHMENT_MAX_LABEL} limit`
    : null;
}

export function retainFailedPreparedAttachment(
  attachments: PreparedAttachment[],
  id: string
): PreparedAttachment[] {
  return attachments.map((attachment) =>
    attachment.id === id ? { ...attachment, status: 'failed' } : attachment
  );
}

export function addUniqueAttachmentPath(paths: string[], rawPath: string): string[] | null {
  const normalized = normalizeAttachmentPath(rawPath);
  if (!normalized) return null;
  return paths.some((path) => path.toLowerCase() === normalized.toLowerCase())
    ? paths
    : [...paths, normalized];
}

export interface AttachmentController {
  attachmentModalVisible: boolean;
  attachmentMenuVisible: boolean;
  attachmentPathDraft: string;
  setAttachmentPathDraft: React.Dispatch<React.SetStateAction<string>>;
  pendingMentionPaths: string[];
  pendingLocalImagePaths: string[];
  fileCandidates: string[];
  loadingFileCandidates: boolean;
  pickerBusy: boolean;
  uploading: boolean;
  hasFailedUploads: boolean;
  composerAttachments: ComposerAttachmentChip[];
  pathSuggestions: string[];
  mentionSuggestions: (query: string) => string[];
  openMenu: () => void;
  closeMenu: () => void;
  requestMenuAction: (action: Exclude<AttachmentMenuAction, null>) => void;
  closePathModal: () => void;
  submitPath: () => void;
  selectPathSuggestion: (path: string) => void;
  selectMentionSuggestion: (path: string) => void;
  removeComposerAttachment: (id: string) => void;
  removeMentionPath: (path: string) => void;
  retryFailedUploads: () => void;
  clearPending: () => void;
  beginSubmission: () => void;
  finishSubmission: (succeeded: boolean, restoringDraft?: boolean) => void;
  clear: () => void;
  toTurnInputs: (cwd?: string | null) => {
    mentions: MentionInput[];
    localImages: LocalImageInput[];
  };
}

export function useAttachmentController({
  api,
  chat,
  workspace,
  draft,
  setDraft,
  setError,
}: {
  api: AttachmentApi;
  chat: Chat | null;
  workspace: string | null;
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}): AttachmentController {
  const [attachmentModalVisible, setAttachmentModalVisible] = useState(false);
  const [attachmentMenuVisible, setAttachmentMenuVisible] = useState(false);
  const [attachmentPathDraft, setAttachmentPathDraft] = useState('');
  const [pendingAction, setPendingAction] = useState<AttachmentMenuAction>(null);
  const [pendingMentionPaths, setPendingMentionPaths] = useState<string[]>([]);
  const [pendingLocalImagePaths, setPendingLocalImagePaths] = useState<string[]>([]);
  const [fileCandidates, setFileCandidates] = useState<string[]>([]);
  const [loadingFileCandidates, setLoadingFileCandidates] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [preparedAttachments, setPreparedAttachments] = useState<PreparedAttachment[]>([]);
  const uploading = preparedAttachments.some((attachment) => attachment.status === 'uploading');
  const cacheRef = useRef<Record<string, string[]>>({});
  const inFlightRef = useRef<Partial<Record<string, Promise<string[]>>>>({});
  const workspaceRef = useRef<string | null>(workspace);
  const pickerInProgressRef = useRef(false);
  const submissionPendingRef = useRef(false);
  const skipNextDraftReconcileRef = useRef(false);
  workspaceRef.current = workspace;

  const addMention = useCallback(
    (rawPath: string) => {
      const normalized = normalizeAttachmentPath(rawPath);
      if (!normalized) {
        setError('Enter a file path to attach');
        return false;
      }
      setPendingMentionPaths((current) => addUniqueAttachmentPath(current, normalized) ?? current);
      setError(null);
      return true;
    },
    [setError]
  );

  const addImage = useCallback(
    (rawPath: string) => {
      const normalized = normalizeAttachmentPath(rawPath);
      if (!normalized) {
        setError('Image path is invalid');
        return false;
      }
      setPendingLocalImagePaths((current) =>
        addUniqueAttachmentPath(current, normalized) ?? current
      );
      setError(null);
      return true;
    },
    [setError]
  );

  const fetchCandidates = useCallback(
    async (cwd: string): Promise<string[]> => {
      try {
        const response = await api.execTerminal({
          command: 'git ls-files --cached --others --exclude-standard',
          cwd,
          timeoutMs: 15_000,
        });
        if (response.code !== 0) return [];
        return response.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 8_000);
      } catch {
        return [];
      }
    },
    [api]
  );

  const loadCandidates = useCallback(
    async (override?: string | null) => {
      const cwd = normalizeWorkspacePath(override ?? workspace);
      if (!cwd) {
        if (!workspaceRef.current) {
          setFileCandidates([]);
          setLoadingFileCandidates(false);
        }
        return [];
      }
      const cached = cacheRef.current[cwd];
      if (cached) {
        if (workspaceRef.current === cwd) setFileCandidates(cached);
        return cached;
      }
      let pending = inFlightRef.current[cwd];
      if (!pending) {
        pending = fetchCandidates(cwd).then((lines) => {
          cacheRef.current[cwd] = lines;
          delete inFlightRef.current[cwd];
          return lines;
        });
        inFlightRef.current[cwd] = pending;
      }
      if (workspaceRef.current === cwd) setLoadingFileCandidates(true);
      const lines = await pending;
      if (workspaceRef.current === cwd) {
        setFileCandidates(lines);
        setLoadingFileCandidates(false);
      }
      return lines;
    },
    [fetchCandidates, workspace]
  );

  const upload = useCallback(
    async ({
      uri,
      fileName,
      mimeType,
      kind,
      knownSize,
    }: {
      uri: string;
      fileName?: string;
      mimeType?: string;
      kind: 'file' | 'image';
      knownSize?: number;
    }) => {
      const normalizedUri = normalizeAttachmentPath(uri);
      if (!normalizedUri) {
        setError('Unable to read attachment from this device');
        return;
      }
      let preparedId: string | null = null;
      try {
        const info = await FileSystem.getInfoAsync(normalizedUri);
        if (!info.exists || info.isDirectory) throw new Error('Unable to read attachment from this device');
        const sizeBytes = knownSize ?? info.size;
        if (sizeBytes <= 0) throw new Error('Attachment is empty');
        const sizeError = attachmentSizeError(sizeBytes);
        if (sizeError) throw new Error(sizeError);
        preparedId = `${kind}:${normalizedUri}`;
        const prepared: PreparedAttachment = {
          id: preparedId,
          uri: normalizedUri,
          fileName,
          mimeType,
          kind,
          sizeBytes,
          status: 'uploading',
        };
        setPreparedAttachments((current) => [
          ...current.filter((entry) => entry.id !== prepared.id),
          prepared,
        ]);
        const uploaded = await api.uploadAttachment({
          uri: normalizedUri,
          fileName,
          mimeType,
          threadId: chat?.id,
          kind,
        });
        if (uploaded.kind === 'image') addImage(uploaded.path);
        else addMention(uploaded.path);
        setPreparedAttachments((current) => current.filter((entry) => entry.id !== preparedId));
        setError(null);
      } catch (error) {
        const failedId = preparedId;
        if (failedId) {
          setPreparedAttachments((current) =>
            retainFailedPreparedAttachment(current, failedId)
          );
        }
        setError((error as Error).message);
      }
    },
    [addImage, addMention, api, chat?.id, setError]
  );

  const retryFailedUploads = useCallback(() => {
    const failed = preparedAttachments.filter((attachment) => attachment.status === 'failed');
    for (const attachment of failed) {
      void upload({
        uri: attachment.uri,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        kind: attachment.kind,
        knownSize: attachment.sizeBytes,
      });
    }
  }, [preparedAttachments, upload]);

  const runPicker = useCallback(
    async (picker: () => Promise<void>) => {
      if (pickerInProgressRef.current) return;
      pickerInProgressRef.current = true;
      setPickerBusy(true);
      try {
        await picker();
      } catch (error) {
        setError((error as Error).message);
      } finally {
        pickerInProgressRef.current = false;
        setPickerBusy(false);
      }
    },
    [setError]
  );

  const pickFile = useCallback(
    () =>
      runPicker(async () => {
        const result = await DocumentPicker.getDocumentAsync({
          type: '*/*',
          copyToCacheDirectory: true,
          multiple: false,
        });
        const file = result.canceled ? null : result.assets[0];
        if (file) {
          const sizeError = typeof file.size === 'number' ? attachmentSizeError(file.size) : null;
          if (sizeError) {
            setError(sizeError);
            return;
          }
          await upload({
            uri: file.uri,
            fileName: file.name,
            mimeType: file.mimeType ?? undefined,
            kind: 'file',
            knownSize: file.size,
          });
        }
      }),
    [runPicker, upload]
  );

  const pickImage = useCallback(
    () =>
      runPicker(async () => {
        if (Platform.OS !== 'ios') {
          const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!permission.granted) {
            setError('Photo library permission is required to attach images');
            return;
          }
        }
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'] as ImagePicker.MediaType[],
          quality: 1,
          base64: false,
          allowsMultipleSelection: false,
        });
        const image = result.canceled ? null : result.assets[0];
        if (image) {
          const prepared = await prepareImage(
            image.uri,
            image.width,
            image.height,
            image.fileSize
          );
          await upload({
            uri: prepared.uri,
            fileName: toJpegFileName(image.fileName ?? 'image.jpg'),
            mimeType: 'image/jpeg',
            kind: 'image',
          });
        }
      }),
    [runPicker, setError, upload]
  );

  const captureImage = useCallback(
    () =>
      runPicker(async () => {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          setError('Camera permission is required to take a photo');
          return;
        }
        const result = await ImagePicker.launchCameraAsync({
          mediaTypes: ['images'] as ImagePicker.MediaType[],
          quality: 1,
          base64: false,
          allowsEditing: false,
        });
        const image = result.canceled ? null : result.assets[0];
        if (image) {
          const prepared = await prepareImage(
            image.uri,
            image.width,
            image.height,
            image.fileSize
          );
          await upload({
            uri: prepared.uri,
            fileName: toJpegFileName(image.fileName ?? 'camera-photo.jpg'),
            mimeType: 'image/jpeg',
            kind: 'image',
          });
        }
      }),
    [runPicker, setError, upload]
  );

  const openPathModal = useCallback(() => {
    if (pickerInProgressRef.current) return;
    setAttachmentPathDraft('');
    setAttachmentModalVisible(true);
    setError(null);
    void loadCandidates();
  }, [loadCandidates, setError]);

  useEffect(() => {
    const cwd = normalizeWorkspacePath(workspace);
    if (!cwd) {
      setFileCandidates([]);
      setLoadingFileCandidates(false);
      return;
    }
    const cached = cacheRef.current[cwd];
    setFileCandidates(cached ?? []);
    setLoadingFileCandidates(false);
    if (!cached) void loadCandidates(cwd);
  }, [loadCandidates, workspace]);

  useEffect(() => {
    if (submissionPendingRef.current) return;
    if (skipNextDraftReconcileRef.current) {
      skipNextDraftReconcileRef.current = false;
      return;
    }
    setPendingMentionPaths((current) => {
      const next = current.filter((path) =>
        draftContainsMentionLabel(draft, toPathBasename(path))
      );
      return next.length === current.length ? current : next;
    });
  }, [draft]);

  useEffect(() => {
    if (attachmentMenuVisible || pendingAction === null) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const idle = scheduleIdleTask(() => {
      timeout = setTimeout(() => {
        if (cancelled) return;
        const action = pendingAction;
        setPendingAction(null);
        if (action === 'workspace-path') openPathModal();
        else if (action === 'phone-file') void pickFile();
        else if (action === 'phone-image') void pickImage();
        else if (action === 'phone-camera') void captureImage();
      }, 180);
    });
    return () => {
      cancelled = true;
      idle.cancel();
      if (timeout) clearTimeout(timeout);
    };
  }, [attachmentMenuVisible, captureImage, openPathModal, pendingAction, pickFile, pickImage]);

  const clear = useCallback(() => {
    setAttachmentModalVisible(false);
    setAttachmentMenuVisible(false);
    setAttachmentPathDraft('');
    setPendingMentionPaths([]);
    setPendingLocalImagePaths([]);
    setFileCandidates([]);
    setLoadingFileCandidates(false);
    setPreparedAttachments([]);
  }, []);

  const composerAttachments = useMemo(
    () =>
      [
        ...pendingLocalImagePaths.map((path) => ({
          id: `image:${path}`,
          label: `image · ${toPathBasename(path)}`,
        })),
        ...preparedAttachments.map((attachment) => ({
          id: `prepared:${attachment.id}`,
          label: `${attachment.status === 'failed' ? 'retry' : 'uploading'} · ${attachment.fileName ?? toPathBasename(attachment.uri)}`,
        })),
      ],
    [pendingLocalImagePaths, preparedAttachments]
  );

  return {
    attachmentModalVisible,
    attachmentMenuVisible,
    attachmentPathDraft,
    setAttachmentPathDraft,
    pendingMentionPaths,
    pendingLocalImagePaths,
    fileCandidates,
    loadingFileCandidates,
    pickerBusy,
    uploading,
    hasFailedUploads: preparedAttachments.some((attachment) => attachment.status === 'failed'),
    composerAttachments,
    pathSuggestions: toAttachmentPathSuggestions(
      fileCandidates,
      attachmentPathDraft,
      pendingMentionPaths
    ),
    mentionSuggestions: (query) =>
      toAttachmentPathSuggestions(fileCandidates, query, pendingMentionPaths),
    openMenu: () => {
      if (!pickerInProgressRef.current && !uploading) setAttachmentMenuVisible(true);
    },
    closeMenu: () => setAttachmentMenuVisible(false),
    requestMenuAction: (action) => {
      setAttachmentMenuVisible(false);
      setPendingAction(action);
    },
    closePathModal: () => {
      setAttachmentModalVisible(false);
      setAttachmentPathDraft('');
    },
    submitPath: () => {
      if (addMention(attachmentPathDraft)) {
        setAttachmentPathDraft('');
        setAttachmentModalVisible(false);
      }
    },
    selectPathSuggestion: (path) => {
      if (addMention(path)) {
        setAttachmentPathDraft('');
        setAttachmentModalVisible(false);
      }
    },
    selectMentionSuggestion: (path) => {
      if (addMention(path)) {
        setDraft((current) =>
          replaceActiveMentionQueryWithSelection(current, toPathBasename(path))
        );
      }
    },
    removeComposerAttachment: (id) => {
      if (id.startsWith('prepared:')) {
        setPreparedAttachments((current) =>
          current.filter((entry) => entry.id !== id.slice('prepared:'.length))
        );
      } else if (id.startsWith('file:')) {
        setPendingMentionPaths((current) => current.filter((path) => path !== id.slice(5)));
      } else if (id.startsWith('image:')) {
        setPendingLocalImagePaths((current) => current.filter((path) => path !== id.slice(6)));
      }
    },
    removeMentionPath: (path) => {
      setPendingMentionPaths((current) => current.filter((entry) => entry !== path));
    },
    retryFailedUploads,
    clearPending: () => {
      setPendingMentionPaths([]);
      setPendingLocalImagePaths([]);
    },
    beginSubmission: () => {
      submissionPendingRef.current = true;
    },
    finishSubmission: (succeeded, restoringDraft = false) => {
      submissionPendingRef.current = false;
      skipNextDraftReconcileRef.current = restoringDraft;
      if (succeeded) {
        setPendingMentionPaths([]);
        setPendingLocalImagePaths([]);
      }
    },
    clear,
    toTurnInputs: (cwd) => ({
      mentions: pendingMentionPaths.map((path) => toMentionInput(path, cwd)),
      localImages: pendingLocalImagePaths.map((path) => ({ path })),
    }),
  };
}

async function prepareImage(
  uri: string,
  width: number,
  height: number,
  knownSize?: number
) {
  const sourceInfo = await FileSystem.getInfoAsync(uri);
  if (!sourceInfo.exists || sourceInfo.isDirectory) throw new Error('Unable to read image');
  const sourceSizeError = attachmentSizeError(knownSize ?? sourceInfo.size);
  if (sourceSizeError) throw new Error(sourceSizeError);
  const longestSide = Math.max(width, height);
  const context = ImageManipulator.ImageManipulator.manipulate(uri);
  if (longestSide > IMAGE_MAX_DIMENSION) {
    context.resize(
      width >= height ? { width: IMAGE_MAX_DIMENSION } : { height: IMAGE_MAX_DIMENSION }
    );
  }
  const rendered = await context.renderAsync();
  const result = await rendered.saveAsync({
    compress: IMAGE_COMPRESSION,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  const info = await FileSystem.getInfoAsync(result.uri);
  if (!info.exists || info.isDirectory) throw new Error('Unable to prepare image');
  const sizeError = attachmentSizeError(info.size);
  if (sizeError) throw new Error(`Compressed image still exceeds the ${ATTACHMENT_MAX_LABEL} limit`);
  return result;
}

function toJpegFileName(fileName: string): string {
  const stem = fileName.replace(/\.[^./\\]+$/, '').trim() || 'image';
  return `${stem}.jpg`;
}
