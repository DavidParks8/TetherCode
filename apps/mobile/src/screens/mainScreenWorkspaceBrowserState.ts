import { useCallback } from 'react';
import type { FileSystemListResponse } from '../api/types';
import { scheduleIdleTask, type WorkspacePickerPurpose, normalizeWorkspacePath, getWorkspaceBrowseCacheKey } from './mainScreenHelpers';
import type { MainScreenCapabilityFlagsContext, MainScreenCapabilityFlagsResult } from './mainScreenCapabilityFlags';






export type MainScreenWorkspaceBrowserStateContext = MainScreenCapabilityFlagsContext & MainScreenCapabilityFlagsResult;

export function useMainScreenWorkspaceBrowserState(context: MainScreenWorkspaceBrowserStateContext) {
  const {
    api,
    gitCheckoutCloning,
    gitCheckoutParentPath,
    onDefaultStartCwdChange,
    preferredStartCwd,
    refreshWorkspaceRoots,
    setGitCheckoutCloning,
    setGitCheckoutDirectoryName,
    setGitCheckoutDirectoryNameEdited,
    setGitCheckoutError,
    setGitCheckoutModalVisible,
    setGitCheckoutParentPath,
    setGitCheckoutRepoUrl,
    setLoadingWorkspaceBrowse,
    setResumeGitCheckoutAfterWorkspacePicker,
    setWorkspaceBridgeRoot,
    setWorkspaceBrowseEntries,
    setWorkspaceBrowseError,
    setWorkspaceBrowseParentPath,
    setWorkspaceBrowsePath,
    setWorkspaceBrowseTruncation,
    setWorkspaceModalVisible,
    setWorkspacePickerPurpose,
    workspaceBridgeRoot,
    workspaceBrowseCacheRef,
    workspaceBrowsePath,
    workspaceBrowseRequestRef,
  } = context;


  const browseWorkspacePath = useCallback(
    async (path: string | null | undefined) => {
      const normalizedRequestPath = normalizeWorkspacePath(path);
      const cacheKey = getWorkspaceBrowseCacheKey(normalizedRequestPath);
      const cached = workspaceBrowseCacheRef.current[cacheKey];
      const requestId = workspaceBrowseRequestRef.current + 1;
      workspaceBrowseRequestRef.current = requestId;
      const applyResponse = (
        response: FileSystemListResponse,
        responseCacheKey = cacheKey
      ) => {
        const normalizedPath = normalizeWorkspacePath(response.path);
        workspaceBrowseCacheRef.current[responseCacheKey] = response;
        if (normalizedPath) {
          workspaceBrowseCacheRef.current[getWorkspaceBrowseCacheKey(normalizedPath)] = response;
        }
        setWorkspaceBridgeRoot((current) => normalizeWorkspacePath(response.bridgeRoot) ?? current);
        setWorkspaceBrowsePath(normalizedPath);
        setWorkspaceBrowseParentPath(normalizeWorkspacePath(response.parentPath));
        setWorkspaceBrowseEntries(response.entries);
        setWorkspaceBrowseTruncation(
          response.truncated
            ? `Showing ${String(response.entries.length)} of ${String(response.totalEntries)} entries.`
            : null
        );
      };

      if (cached) {
        setWorkspaceBridgeRoot((current) => normalizeWorkspacePath(cached.bridgeRoot) ?? current);
        setWorkspaceBrowsePath(normalizeWorkspacePath(cached.path));
        setWorkspaceBrowseParentPath(normalizeWorkspacePath(cached.parentPath));
        setWorkspaceBrowseEntries(cached.entries);
        setWorkspaceBrowseTruncation(
          cached.truncated
            ? `Showing ${String(cached.entries.length)} of ${String(cached.totalEntries)} entries.`
            : null
        );
        setWorkspaceBrowseError(null);
      }

      setLoadingWorkspaceBrowse(true);
      try {
        const response = await api.listFilesystemEntries({
          path: normalizedRequestPath,
          directoriesOnly: true,
        });
        if (workspaceBrowseRequestRef.current !== requestId) {
          return;
        }

        applyResponse(response);
        setWorkspaceBrowseError(null);
      } catch (err) {
        if (workspaceBrowseRequestRef.current !== requestId) {
          return;
        }
        const message = (err as Error).message;
        const missingRequestedWorkspace =
          normalizedRequestPath !== null &&
          /workspace directory is invalid or inaccessible|workspace directory must point to a folder/i.test(
            message
          );

        if (missingRequestedWorkspace) {
          try {
            const rootResponse = await api.listFilesystemEntries({
              path: null,
              directoriesOnly: true,
            });
            if (workspaceBrowseRequestRef.current !== requestId) {
              return;
            }
            applyResponse(
              rootResponse,
              getWorkspaceBrowseCacheKey(normalizeWorkspacePath(rootResponse.path))
            );
            if (normalizedRequestPath === preferredStartCwd) {
              onDefaultStartCwdChange?.(null);
            }
            setWorkspaceBrowseError('Saved workspace was not found. Showing start folder.');
            return;
          } catch {
            // Surface the original invalid path error; it names the path the user needs to fix.
          }
        }

        setWorkspaceBrowseError(message);
      } finally {
        if (workspaceBrowseRequestRef.current === requestId) {
          setLoadingWorkspaceBrowse(false);
        }
      }
    },
    [api, onDefaultStartCwdChange, preferredStartCwd]
  );

  const openWorkspacePicker = useCallback(
    (
      purpose: WorkspacePickerPurpose,
      initialPathOverride?: string | null
    ) => {
      const initialPath =
        normalizeWorkspacePath(initialPathOverride) ??
        preferredStartCwd ??
        workspaceBrowsePath ??
        workspaceBridgeRoot ??
        null;
      setWorkspacePickerPurpose(purpose);
      setWorkspaceModalVisible(true);
      void browseWorkspacePath(initialPath);
      scheduleIdleTask(() => {
        void refreshWorkspaceRoots();
      });
    },
    [
      browseWorkspacePath,
      preferredStartCwd,
      refreshWorkspaceRoots,
      workspaceBridgeRoot,
      workspaceBrowsePath,
    ]
  );

  const openWorkspaceModal = useCallback(() => {
    setResumeGitCheckoutAfterWorkspacePicker(false);
    openWorkspacePicker('default-start');
  }, [openWorkspacePicker]);

  const openGitCheckoutModal = useCallback((initialParentPath?: string | null) => {
    const defaultParentPath =
      normalizeWorkspacePath(initialParentPath) ??
      preferredStartCwd ??
      workspaceBrowsePath ??
      workspaceBridgeRoot ??
      null;
    setGitCheckoutRepoUrl('');
    setGitCheckoutDirectoryName('');
    setGitCheckoutDirectoryNameEdited(false);
    setGitCheckoutParentPath(defaultParentPath);
    setGitCheckoutError(null);
    setGitCheckoutCloning(false);
    setResumeGitCheckoutAfterWorkspacePicker(false);
    setGitCheckoutModalVisible(true);
    void refreshWorkspaceRoots().then((response) => {
      const bridgeRoot = normalizeWorkspacePath(response?.bridgeRoot);
      if (bridgeRoot) {
        setGitCheckoutParentPath((current) => current ?? bridgeRoot);
      }
    });
  }, [
    preferredStartCwd,
    refreshWorkspaceRoots,
    workspaceBridgeRoot,
    workspaceBrowsePath,
  ]);

  const closeGitCheckoutModal = useCallback(() => {
    if (gitCheckoutCloning) {
      return;
    }
    setGitCheckoutModalVisible(false);
    setGitCheckoutError(null);
    setResumeGitCheckoutAfterWorkspacePicker(false);
  }, [gitCheckoutCloning]);

  const openGitCheckoutDestinationPicker = useCallback(() => {
    setResumeGitCheckoutAfterWorkspacePicker(true);
    setGitCheckoutModalVisible(false);
    openWorkspacePicker(
      'git-checkout-destination',
      gitCheckoutParentPath ?? preferredStartCwd ?? workspaceBridgeRoot ?? null
    );
  }, [gitCheckoutParentPath, openWorkspacePicker, preferredStartCwd, workspaceBridgeRoot]);

  return {
    browseWorkspacePath,
    openWorkspacePicker,
    openWorkspaceModal,
    openGitCheckoutModal,
    closeGitCheckoutModal,
    openGitCheckoutDestinationPicker,
  };
}

export type MainScreenWorkspaceBrowserStateResult = ReturnType<typeof useMainScreenWorkspaceBrowserState>;
