import { useCallback, useEffect } from 'react';
import { AppState } from 'react-native';
import { scheduleIdleTask, normalizeWorkspacePath, normalizeCloneDirectoryName, deriveCloneDirectoryName, formatGitCloneFailureMessage, joinWorkspacePath, isBridgeConnectionErrorMessage } from './mainScreenHelpers';
import type { MainScreenAgentThreadsRefreshContext, MainScreenAgentThreadsRefreshResult } from './mainScreenAgentThreadsRefresh';






export type MainScreenWorkspaceCheckoutActionsContext = MainScreenAgentThreadsRefreshContext & MainScreenAgentThreadsRefreshResult;

export function useMainScreenWorkspaceCheckoutActions(context: MainScreenWorkspaceCheckoutActionsContext) {
  const {
    api,
    appStateRef,
    chatIdRef,
    clearDeferredDisconnectActivity,
    clearForegroundAgentRefresh,
    foregroundAgentRefreshHandleRef,
    gitCheckoutDirectoryName,
    gitCheckoutDirectoryNameEdited,
    gitCheckoutParentPath,
    gitCheckoutRepoUrl,
    lastAppForegroundedAtRef,
    onDefaultStartCwdChange,
    refreshWorkspaceRoots,
    scheduleAgentThreadsRefresh,
    scheduleDisconnectActivity,
    setBridgeRecoveryBannerVisible,
    setError,
    setGitCheckoutCloning,
    setGitCheckoutDirectoryName,
    setGitCheckoutDirectoryNameEdited,
    setGitCheckoutError,
    setGitCheckoutModalVisible,
    setGitCheckoutParentPath,
    setGitCheckoutRepoUrl,
    setResumeGitCheckoutAfterWorkspacePicker,
    setWorkspaceBrowseError,
    setWorkspaceBrowseParentPath,
    setWorkspaceBrowsePath,
    setWorkspaceModalVisible,
    workspaceBridgeRoot,
    workspacePickerPurpose,
    ws,
  } = context;


  useEffect(() => {
    if (appStateRef.current === 'active' && !ws.isConnected) {
      scheduleDisconnectActivity();
    }

    return ws.onStatus((connected) => {
      if (connected) {
        clearDeferredDisconnectActivity();
        setBridgeRecoveryBannerVisible(false);
        setError((previous) =>
          isBridgeConnectionErrorMessage(previous) ? null : previous
        );
        return;
      }

      if (appStateRef.current !== 'active') {
        clearDeferredDisconnectActivity();
        setBridgeRecoveryBannerVisible(false);
        return;
      }

      scheduleDisconnectActivity();
    });
  }, [clearDeferredDisconnectActivity, scheduleDisconnectActivity, ws]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      const previousAppState = appStateRef.current;
      appStateRef.current = nextAppState;

      if (nextAppState !== 'active') {
        clearDeferredDisconnectActivity();
        clearForegroundAgentRefresh();
        setBridgeRecoveryBannerVisible(false);
        return;
      }

      if (previousAppState === 'active') {
        return;
      }

      lastAppForegroundedAtRef.current = Date.now();
      clearDeferredDisconnectActivity();
      if (!ws.isConnected) {
        scheduleDisconnectActivity();
      }

      const activeChatId = chatIdRef.current;
      if (!activeChatId) {
        return;
      }

      clearForegroundAgentRefresh();
      foregroundAgentRefreshHandleRef.current = scheduleIdleTask(() => {
        foregroundAgentRefreshHandleRef.current = null;
        if (appStateRef.current !== 'active' || chatIdRef.current !== activeChatId) {
          return;
        }
        scheduleAgentThreadsRefresh(activeChatId);
      });
    });

    return () => {
      clearForegroundAgentRefresh();
      subscription.remove();
    };
  }, [
    clearDeferredDisconnectActivity,
    clearForegroundAgentRefresh,
    scheduleAgentThreadsRefresh,
    scheduleDisconnectActivity,
    ws,
  ]);

  const handleWorkspaceSelection = useCallback(
    (cwd: string | null) => {
      const normalizedPath = normalizeWorkspacePath(cwd);
      setWorkspaceBrowseError(null);

      if (workspacePickerPurpose === 'git-checkout-destination') {
        setGitCheckoutParentPath(normalizedPath);
        setResumeGitCheckoutAfterWorkspacePicker(false);
        setWorkspaceModalVisible(false);
        setGitCheckoutModalVisible(true);
        return;
      }

      onDefaultStartCwdChange?.(normalizedPath);
      setWorkspaceModalVisible(false);
    },
    [onDefaultStartCwdChange, workspacePickerPurpose]
  );

  const handleGitCheckoutRepoUrlChange = useCallback(
    (value: string) => {
      setGitCheckoutRepoUrl(value);
      setGitCheckoutError(null);
      if (!gitCheckoutDirectoryNameEdited) {
        setGitCheckoutDirectoryName(deriveCloneDirectoryName(value) ?? '');
      }
    },
    [gitCheckoutDirectoryNameEdited]
  );

  const handleGitCheckoutDirectoryNameChange = useCallback((value: string) => {
    setGitCheckoutDirectoryName(value);
    setGitCheckoutDirectoryNameEdited(value.trim().length > 0);
    setGitCheckoutError(null);
  }, []);

  const submitGitCheckout = useCallback(async () => {
    const url = gitCheckoutRepoUrl.trim();
    const directoryName = normalizeCloneDirectoryName(gitCheckoutDirectoryName);
    if (!url) {
      setGitCheckoutError('Paste an HTTPS or SSH repository URL first.');
      return;
    }
    if (!directoryName) {
      setGitCheckoutError('Choose a valid folder name for the cloned repo.');
      return;
    }

    let parentPath = normalizeWorkspacePath(gitCheckoutParentPath) ?? workspaceBridgeRoot;
    if (!parentPath) {
      const response = await refreshWorkspaceRoots();
      parentPath = normalizeWorkspacePath(response?.bridgeRoot);
    }
    if (!parentPath) {
      setGitCheckoutError('Choose where the repository should be cloned.');
      return;
    }

    try {
      setGitCheckoutCloning(true);
      setGitCheckoutError(null);
      const cloned = await api.gitClone({
        url,
        parentPath,
        directoryName,
      });
      const cloneFailureMessage = formatGitCloneFailureMessage(cloned, directoryName);
      if (cloneFailureMessage) {
        setGitCheckoutError(cloneFailureMessage);
        return;
      }
      const clonedPath = normalizeWorkspacePath(cloned.cwd) ?? joinWorkspacePath(parentPath, directoryName);
      onDefaultStartCwdChange?.(clonedPath);
      setWorkspaceBrowsePath(clonedPath);
      setWorkspaceBrowseParentPath(parentPath);
      setWorkspaceBrowseError(null);
      setGitCheckoutModalVisible(false);
    } catch (err) {
      setGitCheckoutError((err as Error).message);
    } finally {
      setGitCheckoutCloning(false);
    }
  }, [
    api,
    gitCheckoutDirectoryName,
    gitCheckoutParentPath,
    gitCheckoutRepoUrl,
    onDefaultStartCwdChange,
    refreshWorkspaceRoots,
    workspaceBridgeRoot,
  ]);

  return {
    handleWorkspaceSelection,
    handleGitCheckoutRepoUrlChange,
    handleGitCheckoutDirectoryNameChange,
    submitGitCheckout,
  };
}

export type MainScreenWorkspaceCheckoutActionsResult = ReturnType<typeof useMainScreenWorkspaceCheckoutActions>;
