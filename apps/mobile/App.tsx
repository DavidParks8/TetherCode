import 'react-native-gesture-handler';

import { useFonts } from 'expo-font';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  AppState,
  ActivityIndicator,
  BackHandler,
  Keyboard,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  type AppStateStatus,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Easing,
  LinearTransition,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

import { HostBridgeApiClient } from './src/api/client';
import { toRecord } from './src/api/chatMapping';
import { readAccountRateLimitSnapshot } from './src/api/rateLimits';
import { bindAppWebSocketLifecycle } from './src/appWebSocketLifecycle';
import {
  createEmptyChatSnapshotCache,
  deleteChatSnapshotCache,
  loadChatSnapshotCache,
  saveChatSnapshotCache,
  updateChatSnapshotCache,
  type ChatSnapshotCache,
} from './src/chatSnapshotCache';
import type {
  ApprovalDecision,
  Chat,
  ChatEngine,
  CollaborationMode,
  ReasoningEffort,
  ServiceTier,
} from './src/api/types';
import { HostBridgeWsClient } from './src/api/ws';
import { createAppStateStore, type AppSettingsState } from './src/appState';
import { createAppStatePersistence } from './src/appStatePersistence';
import { normalizeBridgeUrlInput } from './src/bridgeUrl';
import {
  APP_FONT_ASSETS,
  DEFAULT_FONT_PREFERENCE,
} from './src/fonts';
import {
  getActiveBridgeProfile,
  type BridgeProfileDraft,
} from './src/bridgeProfiles';
import { env } from './src/config';
import { DrawerContent } from './src/navigation/DrawerContent';
import { BrowserScreen, type BrowserScreenHandle } from './src/screens/BrowserScreen';
import { GitScreen } from './src/screens/GitScreen';
import { MainScreen, type MainScreenHandle } from './src/screens/MainScreen';
import {
  OnboardingScreen,
  type OnboardingBridgeProfileDraft,
  type OnboardingMode,
} from './src/screens/OnboardingScreen';
import { PrivacyScreen } from './src/screens/PrivacyScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import {
  AUTO_STORE_REVIEW_THRESHOLD_MS,
  createDefaultAutoStoreReviewState,
  isAutoStoreReviewEligible,
  loadAutoStoreReviewState,
  requestNativeStoreReview,
  saveAutoStoreReviewState,
  type AutoStoreReviewState,
} from './src/storeReview';
import { TermsScreen } from './src/screens/TermsScreen';
import {
  addNotificationResponseListener,
  getInitialNotificationResponse,
  registerNotificationCategories,
  setupNotificationHandler,
  type PushResponseEvent,
} from './src/pushNotifications';
import { syncPushRegistration } from './src/pushController';
import { configureRevenueCatIfNeeded } from './src/tips';
import {
  AppThemeProvider,
  createAppTheme,
  resolveThemeMode,
} from './src/theme';

type AppScreen = 'Main' | 'ChatGit' | 'Browser' | 'Settings' | 'Privacy' | 'Terms';
type Screen = AppScreen | 'Onboarding';

const DRAWER_MIN_WIDTH = 260;
const DRAWER_MAX_WIDTH = 296;
const DRAWER_SCREEN_RATIO = 0.69;
const TABLET_LAYOUT_MIN_WIDTH = 700;
const TABLET_SIDEBAR_WIDTH = 312;
const TABLET_SIDEBAR_ANIMATION_MS = 260;
const EDGE_SWIPE_WIDTH = 24;
const CHAT_GIT_BACK_DISTANCE = 56;
const CHAT_GIT_BACK_VELOCITY = 900;
const DRAWER_SNAP_OPEN_PROGRESS = 0.38;
const DRAWER_SNAP_VELOCITY = 920;
const DRAWER_VELOCITY_PROJECTION = 0.08;
const DRAWER_RUBBER_BAND_STRENGTH = 0.2;
const DRAWER_CONTENT_SCALE = 0.94;
const CHAT_TRANSITION_MIN_MS = 220;
const DRAWER_CONTENT_PARALLAX = 18;
const DRAWER_MAX_RADIUS = 28;
const DRAWER_MAX_SHADOW_OPACITY = 0.24;
const DRAWER_MAX_SHADOW_RADIUS = 26;
const DRAWER_MAX_ELEVATION = 18;
const APP_PREFETCH_DELAY_MS = 0;
const APP_PREFETCH_CHAT_LIMIT = 5;
const CHAT_SNAPSHOT_PERSIST_DELAY_MS = 250;
const AUTO_STORE_REVIEW_RETRY_MS = 24 * 60 * 60 * 1000;

export default function App() {
  const systemColorScheme = useColorScheme();
  const appStateStore = useMemo(
    () => createAppStateStore(createAppStatePersistence()),
    []
  );
  const appStateSnapshot = useSyncExternalStore(
    appStateStore.subscribe,
    appStateStore.getSnapshot,
    appStateStore.getSnapshot
  );
  const settingsLoaded = appStateSnapshot.loaded;
  const {
    settings: {
      defaultStartCwd,
      defaultChatEngine,
      defaultEngineSettings,
      approvalMode,
      showToolCalls,
      workspaceChatLimit,
      appearancePreference,
      darkUiPalette,
      fontPreference,
      recentBrowserTargetUrls,
    },
    bridgeProfiles: currentBridgeProfileStore,
  } = appStateSnapshot.data;
  const { activeProfileId: activeBridgeProfileId, profiles: bridgeProfiles } =
    currentBridgeProfileStore;
  const [onboardingMode, setOnboardingMode] = useState<OnboardingMode>('initial');
  const [onboardingReturnScreen, setOnboardingReturnScreen] =
    useState<AppScreen>('Settings');
  const activeBridgeProfile = useMemo(
    () =>
      getActiveBridgeProfile({
        activeProfileId: activeBridgeProfileId,
        profiles: bridgeProfiles,
      }),
    [activeBridgeProfileId, bridgeProfiles]
  );
  const bridgeUrl = activeBridgeProfile?.bridgeUrl ?? null;
  const bridgeToken = activeBridgeProfile?.bridgeToken ?? null;
  const ws = useMemo(
    () =>
      bridgeUrl
        ? new HostBridgeWsClient(bridgeUrl, {
            authToken: bridgeToken ?? env.hostBridgeToken,
            allowQueryTokenAuth: env.allowWsQueryTokenAuth,
          })
        : null,
    [bridgeToken, bridgeUrl]
  );
  const api = useMemo(
    () =>
      ws
        ? new HostBridgeApiClient({
            ws,
          })
        : null,
    [ws]
  );
  const mainRef = useRef<MainScreenHandle>(null);
  const browserRef = useRef<BrowserScreenHandle>(null);
  const pushSyncedApiRef = useRef<HostBridgeApiClient | null>(null);
  // Kept current so the (zero-dep) notification response listener always reaches
  // the active bridge clients without re-subscribing.
  const pushApiRef = useRef(api);
  pushApiRef.current = api;
  const pushWsRef = useRef(ws);
  pushWsRef.current = ws;
  const [currentScreen, setCurrentScreen] = useState<Screen>('Main');
  const [browserReturnScreen, setBrowserReturnScreen] = useState<AppScreen>('Main');
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [gitChat, setGitChat] = useState<Chat | null>(null);
  const [chatTransitionChatId, setChatTransitionChatId] = useState<string | null>(null);
  const [mainOpeningChatId, setMainOpeningChatId] = useState<string | null>(null);
  const [pendingMainChatId, setPendingMainChatId] = useState<string | null>(null);
  const [pendingMainChatSnapshot, setPendingMainChatSnapshot] = useState<Chat | null>(null);
  const [chatSnapshotCache, setChatSnapshotCache] = useState<ChatSnapshotCache | null>(null);
  const [settingsAllowsDrawerGesture, setSettingsAllowsDrawerGesture] = useState(true);
  const [drawerCapturesTouches, setDrawerCapturesTouches] = useState(false);
  const [pendingBrowserTargetUrl, setPendingBrowserTargetUrl] = useState<string | null>(null);
  const [, setBridgeConnected] = useState(() => Boolean(ws?.isConnected));
  const [appLifecycleState, setAppLifecycleState] = useState<AppStateStatus>(
    AppState.currentState
  );
  const [storeReviewStateLoaded, setStoreReviewStateLoaded] = useState(false);
  const [storeReviewState, setStoreReviewState] = useState<AutoStoreReviewState>(
    createDefaultAutoStoreReviewState
  );
  const [automaticStoreReviewRetryAt, setAutomaticStoreReviewRetryAt] = useState<number | null>(
    null
  );
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [tabletSidebarVisible, setTabletSidebarVisible] = useState(true);
  const [fontsLoaded, fontsError] = useFonts(APP_FONT_ASSETS);
  const drawerOpenRef = useRef(false);
  const drawerVisibleRef = useRef(false);
  const drawerCapturesTouchesRef = useRef(false);
  const chatTransitionRequestIdRef = useRef(0);
  const chatSnapshotPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appLifecycleStateRef = useRef(AppState.currentState);
  const activeUsageStartedAtRef = useRef<number | null>(
    AppState.currentState === 'active' ? Date.now() : null
  );
  const storeReviewStateRef = useRef<AutoStoreReviewState>(createDefaultAutoStoreReviewState());
  const automaticStoreReviewInFlightRef = useRef(false);
  const { width: screenWidth } = useWindowDimensions();
  const usesTabletLayout = screenWidth >= TABLET_LAYOUT_MIN_WIDTH;
  const resolvedThemeMode = resolveThemeMode(appearancePreference, systemColorScheme);
  const themeFontPreference = fontsLoaded ? fontPreference : DEFAULT_FONT_PREFERENCE;
  const theme = useMemo(
    () =>
      createAppTheme(
        resolvedThemeMode,
        themeFontPreference,
        resolvedThemeMode === 'dark' ? darkUiPalette : 'classic'
      ),
    [resolvedThemeMode, themeFontPreference, darkUiPalette]
  );
  const styles = useMemo(() => createStyles(theme), [theme]);
  const drawerWidth = useMemo(() => getDrawerWidth(screenWidth), [screenWidth]);
  const tabletLayoutTransition = useMemo(
    () =>
      LinearTransition.duration(TABLET_SIDEBAR_ANIMATION_MS).easing(
        Easing.out(Easing.cubic)
      ),
    []
  );
  const contentShiftOpen = Math.min(drawerWidth - 12, screenWidth * 0.74);
  const drawerOffset = useSharedValue(-drawerWidth);
  const drawerDragStartOffset = useSharedValue(-drawerWidth);
  const drawerGestureDidSettle = useSharedValue(true);

  const screenFrameAnimatedStyle = useAnimatedStyle(() => {
    if (usesTabletLayout) {
      return {
        transform: [{ translateX: 0 }, { scale: 1 }],
        borderRadius: 0,
        shadowOpacity: 0,
        shadowRadius: 0,
        elevation: 0,
      };
    }

    const progress = getDrawerOpenProgress(drawerOffset.value, drawerWidth);
    return {
      transform: [
        { translateX: progress * contentShiftOpen },
        { scale: 1 - (1 - DRAWER_CONTENT_SCALE) * progress },
      ],
      borderRadius: DRAWER_MAX_RADIUS * progress,
      shadowOpacity: DRAWER_MAX_SHADOW_OPACITY * progress,
      shadowRadius: DRAWER_MAX_SHADOW_RADIUS * progress,
      elevation: DRAWER_MAX_ELEVATION * progress,
    };
  }, [contentShiftOpen, drawerWidth, usesTabletLayout]);

  const overlayAnimatedStyle = useAnimatedStyle(() => ({
    opacity: getDrawerOpenProgress(drawerOffset.value, drawerWidth),
  }));

  const drawerAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: drawerOffset.value }],
  }));

  const drawerContentAnimatedStyle = useAnimatedStyle(() => {
    const progress = getDrawerOpenProgress(drawerOffset.value, drawerWidth);
    return {
      opacity: 0.88 + progress * 0.12,
      transform: [
        { translateX: (1 - progress) * -DRAWER_CONTENT_PARALLAX },
        { scale: 0.985 + progress * 0.015 },
      ],
    };
  });

  useEffect(() => {
    const nextOffset = drawerOpenRef.current ? 0 : -drawerWidth;
    drawerOffset.value = nextOffset;
    drawerDragStartOffset.value = nextOffset;
  }, [drawerDragStartOffset, drawerOffset, drawerWidth]);

  useEffect(() => {
    if (!ws) {
      setBridgeConnected(false);
      return;
    }

    return bindAppWebSocketLifecycle(ws);
  }, [ws]);

  useEffect(() => {
    if (!ws) {
      setBridgeConnected(false);
      return;
    }

    setBridgeConnected(ws.isConnected);
    return ws.onStatus((connected) => {
      setBridgeConnected(connected);
    });
  }, [ws]);

  // Push notifications: suppress banners while foregrounded, and route a tapped
  // notification to its thread (cold-start taps included).
  useEffect(() => {
    setupNotificationHandler();
    void registerNotificationCategories();

    // Resolve an approval once the bridge WS is connected. The app foregrounds on
    // an action tap, so the WS reconnects shortly; we wait for it (with a cap)
    // rather than firing into a closed socket.
    const resolveFromAction = (approvalId: string, decision: ApprovalDecision) => {
      const handles: {
        done: boolean;
        unsubscribe?: () => void;
        timer?: ReturnType<typeof setTimeout>;
      } = { done: false };
      const attempt = () => {
        if (handles.done) {
          return;
        }
        handles.done = true;
        if (handles.timer) {
          clearTimeout(handles.timer);
        }
        handles.unsubscribe?.();
        void pushApiRef.current?.resolveApproval(approvalId, decision).catch(() => {
          // Best-effort; the in-app approval banner remains as a fallback.
        });
      };
      const wsClient = pushWsRef.current;
      if (wsClient?.isConnected) {
        attempt();
        return;
      }
      handles.unsubscribe = wsClient?.onStatus((connected) => {
        if (connected) {
          attempt();
        }
      });
      handles.timer = setTimeout(attempt, 10000);
    };

    const handleResponse = (event: PushResponseEvent) => {
      const { action, target } = event;
      if ((action === 'approve' || action === 'deny') && target.approvalId) {
        resolveFromAction(
          target.approvalId,
          action === 'approve' ? 'accept' : 'decline'
        );
      }
      setCurrentScreen('Main');
      if (target.threadId) {
        const threadId = target.threadId;
        // Defer so MainScreen is mounted (and on cold start, has begun connecting).
        setTimeout(() => {
          mainRef.current?.openChat(threadId);
        }, 400);
      }
    };

    const subscription = addNotificationResponseListener(handleResponse);
    void getInitialNotificationResponse().then((event) => {
      if (event) {
        handleResponse(event);
      }
    });
    return () => subscription.remove();
  }, []);

  // Auto-register for push on the first successful bridge connect (skipping
  // onboarding/pairing). The OS permission dialog is shown once here rather than
  // requiring the user to find the Settings toggle. Re-runs when the active
  // bridge changes so a newly paired bridge also learns this device's token.
  useEffect(() => {
    if (!api || !ws || currentScreen === 'Onboarding') {
      return;
    }
    const attempt = () => {
      if (pushSyncedApiRef.current === api) {
        return;
      }
      pushSyncedApiRef.current = api;
      void syncPushRegistration(api).catch(() => {
        // Leave it to the next connect; never block the connect flow.
      });
    };
    if (ws.isConnected) {
      attempt();
    }
    return ws.onStatus((connected) => {
      if (connected) {
        attempt();
      }
    });
  }, [api, ws, currentScreen]);

  useEffect(() => {
    if (!api || !ws || currentScreen === 'Onboarding') {
      return;
    }

    let cancelled = false;
    let prefetchTimer: ReturnType<typeof setTimeout> | null = null;

    const runPrefetch = () => {
      if (cancelled) {
        return;
      }
      void api.primeChats({ limit: APP_PREFETCH_CHAT_LIMIT }).catch(() => {});
      void api.primeAccountRateLimits().catch(() => {});
    };

    const schedulePrefetch = () => {
      if (prefetchTimer) {
        return;
      }

      prefetchTimer = setTimeout(() => {
        prefetchTimer = null;
        runPrefetch();
      }, APP_PREFETCH_DELAY_MS);
    };

    schedulePrefetch();
    const unsubscribeStatus = ws.onStatus((connected) => {
      if (connected) {
        schedulePrefetch();
      }
    });

    return () => {
      cancelled = true;
      if (prefetchTimer) {
        clearTimeout(prefetchTimer);
        prefetchTimer = null;
      }
      unsubscribeStatus();
    };
  }, [api, currentScreen, ws]);

  useEffect(() => {
    if (!api || !ws) {
      return;
    }

    return ws.onEvent((event) => {
      if (event.method === 'bridge/events/snapshotRequired') {
        void api.readAccountRateLimits({ forceRefresh: true }).catch(() => {});
        return;
      }

      if (event.method === 'account/rateLimits/updated') {
        const params = toRecord(event.params);
        const snapshot = readAccountRateLimitSnapshot(
          params?.rateLimits ?? params?.rate_limits ?? event.params
        );
        api.rememberAccountRateLimits(snapshot);
        return;
      }

      if (!event.method.startsWith('codex/event/')) {
        return;
      }

      const params = toRecord(event.params);
      const msg = toRecord(params?.msg);
      const snapshot = readAccountRateLimitSnapshot(
        msg?.rate_limits ?? msg?.rateLimits
      );
      if (snapshot && !api.peekAccountRateLimits()) {
        api.rememberAccountRateLimits(snapshot);
      }
    });
  }, [api, ws]);

  useEffect(() => {
    void configureRevenueCatIfNeeded().catch((error) => {
      console.warn(
        `RevenueCat setup skipped: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }, []);

  const persistStoreReviewState = useCallback(async (nextState: AutoStoreReviewState) => {
    try {
      await saveAutoStoreReviewState(nextState);
    } catch {
      // Best effort persistence only.
    }
  }, []);

  const updateStoreReviewState = useCallback(
    (recipe: (previous: AutoStoreReviewState) => AutoStoreReviewState) => {
      setStoreReviewState((previous) => {
        const nextState = recipe(previous);
        if (
          previous.accumulatedForegroundMs === nextState.accumulatedForegroundMs &&
          previous.automaticRequestAt === nextState.automaticRequestAt
        ) {
          return previous;
        }

        storeReviewStateRef.current = nextState;
        void persistStoreReviewState(nextState);
        return nextState;
      });
    },
    [persistStoreReviewState]
  );

  const flushActiveUsageTime = useCallback(
    (now = Date.now(), keepActive = false) => {
      const activeUsageStartedAt = activeUsageStartedAtRef.current;
      if (appLifecycleStateRef.current !== 'active' || activeUsageStartedAt === null) {
        if (keepActive && appLifecycleStateRef.current === 'active') {
          activeUsageStartedAtRef.current = now;
        }
        return;
      }

      const elapsedMs = Math.max(0, now - activeUsageStartedAt);
      activeUsageStartedAtRef.current = keepActive ? now : null;
      if (elapsedMs <= 0) {
        return;
      }

      updateStoreReviewState((previous) => ({
        ...previous,
        accumulatedForegroundMs: previous.accumulatedForegroundMs + elapsedMs,
      }));
    },
    [updateStoreReviewState]
  );

  const getEffectiveForegroundUsageMs = useCallback(() => {
    const currentState = storeReviewStateRef.current;
    if (
      appLifecycleStateRef.current !== 'active' ||
      activeUsageStartedAtRef.current === null
    ) {
      return currentState.accumulatedForegroundMs;
    }

    return (
      currentState.accumulatedForegroundMs +
      Math.max(0, Date.now() - activeUsageStartedAtRef.current)
    );
  }, []);

  const requestAutomaticStoreReview = useCallback(async () => {
    if (
      automaticStoreReviewInFlightRef.current ||
      !settingsLoaded ||
      !storeReviewStateLoaded ||
      currentScreen === 'Onboarding' ||
      (automaticStoreReviewRetryAt !== null && automaticStoreReviewRetryAt > Date.now())
    ) {
      return;
    }

    const effectiveState: AutoStoreReviewState = {
      ...storeReviewStateRef.current,
      accumulatedForegroundMs: getEffectiveForegroundUsageMs(),
    };
    if (!isAutoStoreReviewEligible(effectiveState)) {
      return;
    }

    automaticStoreReviewInFlightRef.current = true;
    try {
      const now = Date.now();
      flushActiveUsageTime(now, true);
      const didRequest = await requestNativeStoreReview();
      if (!didRequest) {
        setAutomaticStoreReviewRetryAt(now + AUTO_STORE_REVIEW_RETRY_MS);
        return;
      }

      setAutomaticStoreReviewRetryAt(null);
      updateStoreReviewState((previous) => ({
        ...previous,
        automaticRequestAt: new Date(now).toISOString(),
      }));
    } catch (error) {
      setAutomaticStoreReviewRetryAt(Date.now() + AUTO_STORE_REVIEW_RETRY_MS);
      console.warn(
        `Automatic store review request failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      automaticStoreReviewInFlightRef.current = false;
    }
  }, [
    currentScreen,
    flushActiveUsageTime,
    getEffectiveForegroundUsageMs,
    automaticStoreReviewRetryAt,
    settingsLoaded,
    storeReviewStateLoaded,
    updateStoreReviewState,
  ]);

  useEffect(() => {
    let cancelled = false;

    const loadStoreReviewPromptState = async () => {
      const nextState = await loadAutoStoreReviewState();
      if (cancelled) {
        return;
      }

      storeReviewStateRef.current = nextState;
      setStoreReviewState(nextState);
      setStoreReviewStateLoaded(true);
    };

    void loadStoreReviewPromptState();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      const previousState = appLifecycleStateRef.current;
      if (previousState === 'active' && nextState !== 'active') {
        flushActiveUsageTime(Date.now(), false);
      }

      if (previousState !== 'active' && nextState === 'active') {
        activeUsageStartedAtRef.current = Date.now();
      }

      appLifecycleStateRef.current = nextState;
      setAppLifecycleState(nextState);
    });

    return () => {
      subscription.remove();
      flushActiveUsageTime(Date.now(), false);
    };
  }, [flushActiveUsageTime]);

  useEffect(() => {
    if (
      appLifecycleState !== 'active' ||
      !settingsLoaded ||
      !storeReviewStateLoaded ||
      currentScreen === 'Onboarding' ||
      storeReviewState.automaticRequestAt
    ) {
      return;
    }

    const thresholdRemainingMs = AUTO_STORE_REVIEW_THRESHOLD_MS - getEffectiveForegroundUsageMs();
    const retryRemainingMs =
      automaticStoreReviewRetryAt === null ? 0 : automaticStoreReviewRetryAt - Date.now();
    const remainingMs = Math.max(thresholdRemainingMs, retryRemainingMs);
    if (remainingMs <= 0) {
      void requestAutomaticStoreReview();
      return;
    }

    const timer = setTimeout(() => {
      void requestAutomaticStoreReview();
    }, remainingMs);

    return () => {
      clearTimeout(timer);
    };
  }, [
    appLifecycleState,
    automaticStoreReviewRetryAt,
    currentScreen,
    getEffectiveForegroundUsageMs,
    requestAutomaticStoreReview,
    settingsLoaded,
    storeReviewState.accumulatedForegroundMs,
    storeReviewState.automaticRequestAt,
    storeReviewStateLoaded,
  ]);

  useEffect(() => {
    let cancelled = false;

    const loadSettings = async () => {
      try {
        await appStateStore.initialize();
        if (cancelled) {
          return;
        }
        const profileStore = appStateStore.getSnapshot().data.bridgeProfiles;
        const activeProfile = getActiveBridgeProfile(profileStore);
        const snapshotCache = activeProfile
          ? await loadChatSnapshotCache(activeProfile.id)
          : null;
        if (cancelled) {
          return;
        }
        const selectedSnapshot =
          snapshotCache?.entries.find(
            (entry) => entry.chat.id === snapshotCache.selectedChatId
          )?.chat ?? null;

        setChatSnapshotCache(snapshotCache);
        setSelectedChatId(selectedSnapshot?.id ?? null);
        setActiveChat(selectedSnapshot);
        setPendingMainChatId(selectedSnapshot?.id ?? null);
        setPendingMainChatSnapshot(selectedSnapshot);
      } catch {
        // The typed persistence error remains available in the app-state snapshot.
      }
    };

    void loadSettings();
    return () => {
      cancelled = true;
    };
  }, [appStateStore]);

  useEffect(() => {
    if (!api || !chatSnapshotCache || chatSnapshotCache.profileId !== activeBridgeProfile?.id) {
      return;
    }
    for (const entry of chatSnapshotCache.entries) {
      api.rememberChat(entry.chat);
    }
  }, [activeBridgeProfile?.id, api, chatSnapshotCache]);

  useEffect(() => {
    const profileId = activeBridgeProfile?.id;
    if (!profileId || !settingsLoaded) {
      return;
    }

    if (chatSnapshotPersistTimerRef.current) {
      clearTimeout(chatSnapshotPersistTimerRef.current);
    }
    chatSnapshotPersistTimerRef.current = setTimeout(() => {
      chatSnapshotPersistTimerRef.current = null;
      setChatSnapshotCache((previous) => {
        const base =
          previous?.profileId === profileId
            ? previous
            : createEmptyChatSnapshotCache(profileId);
        const next = updateChatSnapshotCache(base, selectedChatId, activeChat);
        void saveChatSnapshotCache(next).catch(() => {});
        return next;
      });
    }, CHAT_SNAPSHOT_PERSIST_DELAY_MS);

    return () => {
      if (chatSnapshotPersistTimerRef.current) {
        clearTimeout(chatSnapshotPersistTimerRef.current);
        chatSnapshotPersistTimerRef.current = null;
      }
    };
  }, [activeBridgeProfile?.id, activeChat, selectedChatId, settingsLoaded]);

  const dismissKeyboard = useCallback(() => {
    Keyboard.dismiss();
  }, []);

  const ensureDrawerVisible = useCallback(() => {
    if (drawerVisibleRef.current) {
      return;
    }

    drawerVisibleRef.current = true;
    setDrawerVisible(true);
  }, []);

  const ensureDrawerCapturesTouches = useCallback(() => {
    if (drawerCapturesTouchesRef.current) {
      return;
    }

    drawerCapturesTouchesRef.current = true;
    setDrawerCapturesTouches(true);
  }, []);

  const beginDrawerInteraction = useCallback(() => {
    ensureDrawerVisible();
    ensureDrawerCapturesTouches();
  }, [ensureDrawerCapturesTouches, ensureDrawerVisible]);

  const handleDrawerSettled = useCallback(
    (isOpen: boolean) => {
      drawerOpenRef.current = isOpen;
      drawerVisibleRef.current = isOpen;
      drawerCapturesTouchesRef.current = isOpen;
      setDrawerVisible(isOpen);
      setDrawerCapturesTouches(isOpen);
    },
    []
  );

  const animateDrawerTo = useCallback(
    (shouldOpen: boolean, velocityX = 0) => {
      if (usesTabletLayout) {
        handleDrawerSettled(false);
        drawerOffset.value = -drawerWidth;
        drawerDragStartOffset.value = -drawerWidth;
        return;
      }

      if (!shouldOpen && !drawerVisibleRef.current) {
        return;
      }

      if (shouldOpen) {
        dismissKeyboard();
        ensureDrawerCapturesTouches();
      }

      ensureDrawerVisible();
      drawerOffset.value = withSpring(
        shouldOpen ? 0 : -drawerWidth,
        buildDrawerSpringConfig(velocityX),
        (finished) => {
          if (finished) {
            runOnJS(handleDrawerSettled)(shouldOpen);
          }
        }
      );
    },
    [
      dismissKeyboard,
      drawerDragStartOffset,
      drawerOffset,
      drawerWidth,
      ensureDrawerCapturesTouches,
      ensureDrawerVisible,
      handleDrawerSettled,
      usesTabletLayout,
    ]
  );

  const openDrawer = useCallback(() => {
    animateDrawerTo(true);
  }, [animateDrawerTo]);

  const closeDrawer = useCallback(() => {
    animateDrawerTo(false);
  }, [animateDrawerTo]);

  const handleNavigationToggle = useCallback(() => {
    if (usesTabletLayout) {
      setTabletSidebarVisible((visible) => !visible);
      return;
    }

    openDrawer();
  }, [openDrawer, usesTabletLayout]);

  const openChatWithTransition = useCallback(
    async (id: string, snapshot?: Chat | null) => {
      const requestId = chatTransitionRequestIdRef.current + 1;
      chatTransitionRequestIdRef.current = requestId;
      const startedAt = Date.now();

      const nextSnapshot =
        snapshot && snapshot.id === id ? snapshot : api?.peekChatShell(id) ?? null;
      const hasHydratedSnapshot = Boolean(nextSnapshot && nextSnapshot.messages.length > 0);
      const shouldShowTransition = !hasHydratedSnapshot;

      setChatTransitionChatId(shouldShowTransition ? id : null);
      setMainOpeningChatId(shouldShowTransition ? id : null);
      closeDrawer();

      const remainingMs = shouldShowTransition
        ? CHAT_TRANSITION_MIN_MS - (Date.now() - startedAt)
        : 0;
      if (remainingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingMs));
      }

      if (chatTransitionRequestIdRef.current !== requestId) {
        return;
      }

      setSelectedChatId(id);
      setActiveChat(nextSnapshot);
      setGitChat(null);
      setCurrentScreen('Main');
      setPendingMainChatId(id);
      setPendingMainChatSnapshot(hasHydratedSnapshot ? nextSnapshot : null);
      setChatTransitionChatId(null);
      if (hasHydratedSnapshot) {
        setMainOpeningChatId(null);
      }
    },
    [api, closeDrawer]
  );

  const handleChatGitBack = useCallback(() => {
    const chatId = gitChat?.id ?? activeChat?.id ?? selectedChatId;
    const resumeChat =
      gitChat && gitChat.id === chatId
        ? gitChat
        : activeChat && activeChat.id === chatId
          ? activeChat
          : null;
    if (chatId) {
      void openChatWithTransition(chatId, resumeChat);
      return;
    }
    setCurrentScreen('Main');
    setGitChat(null);
  }, [activeChat, gitChat, openChatWithTransition, selectedChatId]);

  const chatGitBackGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ right: 12 })
        .activeOffsetX(12)
        .failOffsetY([-18, 18])
        .onEnd((event) => {
          if (
            event.translationX > CHAT_GIT_BACK_DISTANCE ||
            event.velocityX > CHAT_GIT_BACK_VELOCITY
          ) {
            runOnJS(handleChatGitBack)();
          }
        }),
    [handleChatGitBack]
  );

  const openDrawerGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(
          !usesTabletLayout &&
            currentScreen !== 'ChatGit' &&
            currentScreen !== 'Browser' &&
            (currentScreen !== 'Settings' || settingsAllowsDrawerGesture)
        )
        .activeOffsetX(12)
        .failOffsetY([-18, 18])
        .onStart(() => {
          drawerGestureDidSettle.value = false;
          cancelAnimation(drawerOffset);
          drawerDragStartOffset.value = drawerOffset.value;
          runOnJS(dismissKeyboard)();
          runOnJS(beginDrawerInteraction)();
        })
        .onUpdate((event) => {
          drawerOffset.value = applyDrawerRubberBand(
            drawerDragStartOffset.value + event.translationX,
            drawerWidth
          );
        })
        .onEnd((event) => {
          drawerGestureDidSettle.value = true;
          const nextOffset = clampDrawerOffset(
            drawerDragStartOffset.value + event.translationX,
            drawerWidth
          );
          const shouldOpen = shouldSettleDrawerOpen(
            nextOffset,
            event.velocityX,
            drawerWidth,
            drawerDragStartOffset.value
          );
          drawerOffset.value = withSpring(
            shouldOpen ? 0 : -drawerWidth,
            buildDrawerSpringConfig(event.velocityX),
            (finished) => {
              if (finished) {
                runOnJS(handleDrawerSettled)(shouldOpen);
              }
            }
          );
        })
        .onFinalize((event) => {
          if (drawerGestureDidSettle.value) {
            return;
          }
          drawerGestureDidSettle.value = true;
          const nextOffset = clampDrawerOffset(drawerOffset.value, drawerWidth);
          const shouldOpen = shouldSettleDrawerOpen(
            nextOffset,
            event.velocityX,
            drawerWidth,
            drawerDragStartOffset.value
          );
          drawerOffset.value = withSpring(
            shouldOpen ? 0 : -drawerWidth,
            buildDrawerSpringConfig(event.velocityX),
            (finished) => {
              if (finished) {
                runOnJS(handleDrawerSettled)(shouldOpen);
              }
            }
          );
        }),
    [
      beginDrawerInteraction,
      currentScreen,
      dismissKeyboard,
      drawerDragStartOffset,
      drawerGestureDidSettle,
      drawerOffset,
      drawerWidth,
      handleDrawerSettled,
      ensureDrawerCapturesTouches,
      settingsAllowsDrawerGesture,
      usesTabletLayout,
    ]
  );

  useEffect(() => {
    if (!usesTabletLayout) {
      return;
    }

    handleDrawerSettled(false);
    drawerOffset.value = -drawerWidth;
    drawerDragStartOffset.value = -drawerWidth;
  }, [
    drawerDragStartOffset,
    drawerOffset,
    drawerWidth,
    handleDrawerSettled,
    usesTabletLayout,
  ]);

  useEffect(() => {
    if (currentScreen !== 'Settings' && !settingsAllowsDrawerGesture) {
      setSettingsAllowsDrawerGesture(true);
    }
  }, [currentScreen, settingsAllowsDrawerGesture]);

  const visibleDrawerGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(drawerVisible)
        .activeOffsetX([-8, 8])
        .failOffsetY([-18, 18])
        .onStart(() => {
          drawerGestureDidSettle.value = false;
          cancelAnimation(drawerOffset);
          drawerDragStartOffset.value = drawerOffset.value;
          runOnJS(ensureDrawerCapturesTouches)();
        })
        .onUpdate((event) => {
          drawerOffset.value = applyDrawerRubberBand(
            drawerDragStartOffset.value + event.translationX,
            drawerWidth
          );
        })
        .onEnd((event) => {
          drawerGestureDidSettle.value = true;
          const nextOffset = clampDrawerOffset(
            drawerDragStartOffset.value + event.translationX,
            drawerWidth
          );
          const shouldOpen = shouldSettleDrawerOpen(
            nextOffset,
            event.velocityX,
            drawerWidth,
            drawerDragStartOffset.value
          );
          drawerOffset.value = withSpring(
            shouldOpen ? 0 : -drawerWidth,
            buildDrawerSpringConfig(event.velocityX),
            (finished) => {
              if (finished) {
                runOnJS(handleDrawerSettled)(shouldOpen);
              }
            }
          );
        })
        .onFinalize((event) => {
          if (drawerGestureDidSettle.value) {
            return;
          }
          drawerGestureDidSettle.value = true;
          const nextOffset = clampDrawerOffset(drawerOffset.value, drawerWidth);
          const shouldOpen = shouldSettleDrawerOpen(
            nextOffset,
            event.velocityX,
            drawerWidth,
            drawerDragStartOffset.value
          );
          drawerOffset.value = withSpring(
            shouldOpen ? 0 : -drawerWidth,
            buildDrawerSpringConfig(event.velocityX),
            (finished) => {
              if (finished) {
                runOnJS(handleDrawerSettled)(shouldOpen);
              }
            }
          );
        }),
    [
      drawerDragStartOffset,
      drawerGestureDidSettle,
      drawerOffset,
      drawerWidth,
      drawerVisible,
      ensureDrawerCapturesTouches,
      handleDrawerSettled,
    ]
  );

  const visibleDrawerTapGesture = useMemo(
    () =>
      Gesture.Tap()
        .enabled(drawerVisible)
        .maxDistance(8)
        .onEnd((_event, success) => {
          if (success) {
            runOnJS(closeDrawer)();
          }
        }),
    [closeDrawer, drawerVisible]
  );

  const navigate = useCallback(
    (screen: Screen) => {
      if (screen !== 'Main') {
        chatTransitionRequestIdRef.current += 1;
        setChatTransitionChatId(null);
        setMainOpeningChatId(null);
      }
      setCurrentScreen(screen);
      closeDrawer();
    },
    [closeDrawer]
  );

  const handleSelectChat = useCallback(
    (id: string) => {
      const currentChatId = activeChat?.id ?? selectedChatId;
      if (currentScreen === 'Main' && currentChatId === id) {
        closeDrawer();
        return;
      }

      void openChatWithTransition(id, null);
    },
    [activeChat?.id, closeDrawer, currentScreen, openChatWithTransition, selectedChatId]
  );

  const handleNewChat = useCallback(() => {
    chatTransitionRequestIdRef.current += 1;
    setChatTransitionChatId(null);
    setMainOpeningChatId(null);
    setPendingMainChatId(null);
    setPendingMainChatSnapshot(null);
    setSelectedChatId(null);
    setActiveChat(null);
    setGitChat(null);
    setCurrentScreen('Main');
    mainRef.current?.startNewChat();
    closeDrawer();
  }, [closeDrawer]);

  const handleLastUsedThreadSettingsChange = useCallback(
    (
      engine: ChatEngine,
      modelId: string | null,
      effort: ReasoningEffort | null,
      serviceTier: ServiceTier | null,
      collaborationMode: CollaborationMode
    ) => {
      appStateStore.dispatch({
        type: 'settings/remember-thread',
        engine,
        modelId,
        effort,
        serviceTier,
        collaborationMode,
      });
    },
    [appStateStore]
  );

  const updateSettings = useCallback(
    (patch: Partial<AppSettingsState>) => {
      appStateStore.dispatch({ type: 'settings/update', patch });
    },
    [appStateStore]
  );

  const openBrowser = useCallback(
    (targetUrl?: string | null) => {
      if (typeof targetUrl === 'string' && targetUrl.trim().length > 0) {
        setPendingBrowserTargetUrl(targetUrl.trim());
      }
      setBrowserReturnScreen(
        currentScreen === 'Browser' ||
          currentScreen === 'Onboarding'
          ? 'Main'
          : currentScreen
      );
      chatTransitionRequestIdRef.current += 1;
      setChatTransitionChatId(null);
      setMainOpeningChatId(null);
      setCurrentScreen('Browser');
      closeDrawer();
    },
    [closeDrawer, currentScreen]
  );

  const resetBridgeSessionState = useCallback(() => {
      setSelectedChatId(null);
      setActiveChat(null);
      setGitChat(null);
      setChatTransitionChatId(null);
      setMainOpeningChatId(null);
      setPendingMainChatId(null);
      setPendingMainChatSnapshot(null);
      setChatSnapshotCache(null);
  }, []);

  const handleBridgeProfileSaved = useCallback(
    async (draft: OnboardingBridgeProfileDraft) => {
      const normalized = normalizeBridgeUrlInput(draft.bridgeUrl);
      const normalizedToken = normalizeBridgeToken(draft.bridgeToken);
      if (!normalized || !normalizedToken) {
        throw new Error('Bridge URL and token are required.');
      }

      const nextDraft: BridgeProfileDraft = {
        id:
          onboardingMode === 'edit'
            ? activeBridgeProfile?.id ?? null
            : null,
        bridgeUrl: normalized,
        bridgeToken: normalizedToken,
        activate: true,
      };
      const editedProfile = nextDraft.id
        ? currentBridgeProfileStore.profiles.find((profile) => profile.id === nextDraft.id) ?? null
        : null;
      const bridgeIdentityChanged = Boolean(
        editedProfile &&
          (editedProfile.bridgeUrl !== normalized || editedProfile.bridgeToken !== normalizedToken)
      );
      const nextState = await appStateStore.dispatchDurable({
        type: 'profiles/save',
        draft: nextDraft,
      });
      const nextStore = nextState.bridgeProfiles;
      if (bridgeIdentityChanged && nextStore.activeProfileId) {
        await deleteChatSnapshotCache(nextStore.activeProfileId);
      }
      resetBridgeSessionState();
      const nextCache = nextStore.activeProfileId && !bridgeIdentityChanged
        ? await loadChatSnapshotCache(nextStore.activeProfileId)
        : null;
      const selectedSnapshot =
        nextCache?.entries.find((entry) => entry.chat.id === nextCache.selectedChatId)?.chat ?? null;
      setChatSnapshotCache(nextCache);
      setSelectedChatId(selectedSnapshot?.id ?? null);
      setActiveChat(selectedSnapshot);
      setPendingMainChatId(selectedSnapshot?.id ?? null);
      setPendingMainChatSnapshot(selectedSnapshot);
      setCurrentScreen(onboardingMode === 'initial' ? 'Main' : onboardingReturnScreen);
      setOnboardingMode('edit');
      closeDrawer();
    },
    [
      activeBridgeProfile?.id,
      appStateStore,
      closeDrawer,
      currentBridgeProfileStore,
      onboardingMode,
      onboardingReturnScreen,
      resetBridgeSessionState,
    ]
  );

  const handleEditBridgeProfile = useCallback(() => {
    setOnboardingMode(bridgeUrl ? 'edit' : 'initial');
    setOnboardingReturnScreen(
      currentScreen === 'Onboarding' ? 'Settings' : currentScreen
    );
    setCurrentScreen('Onboarding');
    closeDrawer();
  }, [bridgeUrl, closeDrawer, currentScreen]);

  const handleAddBridgeProfile = useCallback(() => {
    setOnboardingMode('add');
    setOnboardingReturnScreen(
      currentScreen === 'Onboarding' ? 'Settings' : currentScreen
    );
    setCurrentScreen('Onboarding');
    closeDrawer();
  }, [closeDrawer, currentScreen]);

  const handleOpenBridgeRecoveryGuide = useCallback(() => {
    setOnboardingMode('reconnect');
    setOnboardingReturnScreen(
      currentScreen === 'Onboarding' ? 'Settings' : currentScreen
    );
    setCurrentScreen('Onboarding');
    closeDrawer();
  }, [closeDrawer, currentScreen]);

  const handleSwitchBridgeProfile = useCallback(
    async (profileId: string) => {
      const nextCache = await loadChatSnapshotCache(profileId);
      await appStateStore.dispatchDurable({
        type: 'profiles/switch',
        profileId,
      });
      const selectedSnapshot =
        nextCache.entries.find((entry) => entry.chat.id === nextCache.selectedChatId)?.chat ?? null;
      resetBridgeSessionState();
      setChatSnapshotCache(nextCache);
      setSelectedChatId(selectedSnapshot?.id ?? null);
      setActiveChat(selectedSnapshot);
      setPendingMainChatId(selectedSnapshot?.id ?? null);
      setPendingMainChatSnapshot(selectedSnapshot);
    },
    [appStateStore, resetBridgeSessionState]
  );

  const handleRenameBridgeProfile = useCallback(
    async (profileId: string, nextName: string) => {
      await appStateStore.dispatchDurable({
        type: 'profiles/rename',
        profileId,
        name: nextName,
      });
    },
    [appStateStore]
  );

  const handleDeleteBridgeProfile = useCallback(
    async (profileId: string) => {
      const deletingActiveProfile = activeBridgeProfileId === profileId;
      const nextState = await appStateStore.dispatchDurable({
        type: 'profiles/remove',
        profileId,
      });
      const nextStore = nextState.bridgeProfiles;
      await deleteChatSnapshotCache(profileId);

      if (deletingActiveProfile) {
        resetBridgeSessionState();
        const nextCache = nextStore.activeProfileId
          ? await loadChatSnapshotCache(nextStore.activeProfileId)
          : null;
        const selectedSnapshot =
          nextCache?.entries.find((entry) => entry.chat.id === nextCache.selectedChatId)?.chat ?? null;
        setChatSnapshotCache(nextCache);
        setSelectedChatId(selectedSnapshot?.id ?? null);
        setActiveChat(selectedSnapshot);
        setPendingMainChatId(selectedSnapshot?.id ?? null);
        setPendingMainChatSnapshot(selectedSnapshot);
      }

      if (nextStore.profiles.length === 0) {
        setOnboardingMode('initial');
        setOnboardingReturnScreen('Main');
        setCurrentScreen('Onboarding');
        closeDrawer();
      }
    },
    [activeBridgeProfileId, appStateStore, closeDrawer, resetBridgeSessionState]
  );

  const handleClearSavedBridges = useCallback(async () => {
    await appStateStore.dispatchDurable({ type: 'profiles/clear' });
    await Promise.all(bridgeProfiles.map((profile) => deleteChatSnapshotCache(profile.id)));
    resetBridgeSessionState();
    setOnboardingMode('initial');
    setOnboardingReturnScreen('Main');
    setCurrentScreen('Onboarding');
    closeDrawer();
  }, [appStateStore, bridgeProfiles, closeDrawer, resetBridgeSessionState]);

  const handleCancelOnboarding = useCallback(() => {
    setCurrentScreen(onboardingReturnScreen);
  }, [onboardingReturnScreen]);

  const handleOpenChatGit = useCallback((chat: Chat) => {
    chatTransitionRequestIdRef.current += 1;
    setChatTransitionChatId(null);
    setMainOpeningChatId(null);
    setGitChat(chat);
    setSelectedChatId(chat.id);
    setCurrentScreen('ChatGit');
  }, []);

  const handleChatContextChange = useCallback((chat: Chat | null) => {
    setActiveChat(chat);
    setSelectedChatId((previous) => {
      if (chat?.id) {
        return chat.id;
      }
      return mainOpeningChatId ? previous : null;
    });
  }, [mainOpeningChatId]);

  const handleGitChatUpdated = useCallback((chat: Chat) => {
    setGitChat(chat);
    setActiveChat((prev) => (prev?.id === chat.id ? chat : prev));
  }, []);

  const handleCloseGit = useCallback(() => {
    const chatId = gitChat?.id ?? activeChat?.id ?? selectedChatId;
    const resumeChat =
      gitChat && gitChat.id === chatId
        ? gitChat
        : activeChat && activeChat.id === chatId
          ? activeChat
          : null;
    if (chatId) {
      void openChatWithTransition(chatId, resumeChat);
      return;
    }
    setCurrentScreen('Main');
    setGitChat(null);
  }, [activeChat, gitChat, openChatWithTransition, selectedChatId]);

  const handleHardwareBackPress = useCallback(() => {
    if (drawerVisibleRef.current || drawerOpenRef.current) {
      closeDrawer();
      return true;
    }

    if (currentScreen === 'Onboarding') {
      if (onboardingMode !== 'initial' && activeBridgeProfile) {
        handleCancelOnboarding();
        return true;
      }
      return false;
    }

    switch (currentScreen) {
      case 'ChatGit':
        handleCloseGit();
        return true;
      case 'Browser':
        if (browserRef.current?.handleHardwareBackPress()) {
          return true;
        }
        setCurrentScreen(browserReturnScreen);
        return true;
      case 'Settings':
        setCurrentScreen('Main');
        return true;
      case 'Privacy':
      case 'Terms':
        setCurrentScreen('Settings');
        return true;
      case 'Main':
      default:
        return false;
    }
  }, [
    activeBridgeProfile,
    browserReturnScreen,
    closeDrawer,
    currentScreen,
    handleCancelOnboarding,
    handleCloseGit,
    onboardingMode,
  ]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      handleHardwareBackPress
    );

    return () => subscription.remove();
  }, [handleHardwareBackPress]);

  const openPrivacy = useCallback(() => {
    chatTransitionRequestIdRef.current += 1;
    setChatTransitionChatId(null);
    setMainOpeningChatId(null);
    setCurrentScreen('Privacy');
  }, []);

  const openTerms = useCallback(() => {
    chatTransitionRequestIdRef.current += 1;
    setChatTransitionChatId(null);
    setMainOpeningChatId(null);
    setCurrentScreen('Terms');
  }, []);

  if (!settingsLoaded || (!fontsLoaded && !fontsError)) {
    return (
      <AppThemeProvider theme={theme}>
        <GestureHandlerRootView style={styles.root}>
          <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            <StatusBar
              barStyle={theme.statusBarStyle}
              backgroundColor={theme.colors.bgMain}
            />
            <View style={styles.loadingRoot}>
              <ActivityIndicator size="large" color={theme.colors.textMuted} />
            </View>
          </SafeAreaProvider>
        </GestureHandlerRootView>
      </AppThemeProvider>
    );
  }

  if (
    appStateSnapshot.persistenceError &&
    appStateSnapshot.persistenceError.operation !== 'write'
  ) {
    return (
      <AppThemeProvider theme={theme}>
        <GestureHandlerRootView style={styles.root}>
          <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            <StatusBar
              barStyle={theme.statusBarStyle}
              backgroundColor={theme.colors.bgMain}
            />
            <View style={styles.persistenceRecoveryRoot}>
              <Text style={styles.persistenceRecoveryTitle}>Could not load saved app state</Text>
              <Text selectable style={styles.persistenceRecoveryMessage}>
                {appStateSnapshot.persistenceError.message}
              </Text>
              <Pressable
                onPress={() => void appStateStore.retryPersistence()}
                style={({ pressed }) => [
                  styles.persistenceRecoveryButton,
                  pressed && styles.persistenceRecoveryButtonPressed,
                ]}
              >
                <Text style={styles.persistenceRecoveryButtonText}>Retry</Text>
              </Pressable>
            </View>
          </SafeAreaProvider>
        </GestureHandlerRootView>
      </AppThemeProvider>
    );
  }

  if (!bridgeUrl || !api || !ws || currentScreen === 'Onboarding') {
    const mode: OnboardingMode = bridgeUrl ? onboardingMode : 'initial';
    const shouldUseSavedBridgeCredentials = mode === 'edit' || mode === 'reconnect';
    const initialUrl =
      shouldUseSavedBridgeCredentials
        ? activeBridgeProfile?.bridgeUrl ?? ''
        : mode === 'add'
          ? ''
          : env.legacyHostBridgeUrl ?? '';
    const initialToken =
      shouldUseSavedBridgeCredentials
        ? activeBridgeProfile?.bridgeToken ?? ''
        : mode === 'add'
          ? ''
          : env.hostBridgeToken ?? '';
    const canCancel = mode !== 'initial' && Boolean(activeBridgeProfile);
    return (
      <AppThemeProvider theme={theme}>
        <GestureHandlerRootView style={styles.root}>
          <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            <StatusBar
              barStyle={theme.statusBarStyle}
              backgroundColor={theme.colors.bgMain}
            />
            <OnboardingScreen
              mode={mode}
              initialBridgeUrl={initialUrl}
              initialBridgeToken={initialToken}
              allowInsecureRemoteBridge={env.allowInsecureRemoteBridge}
              allowQueryTokenAuth={env.allowWsQueryTokenAuth}
              onSave={handleBridgeProfileSaved}
              onCancel={canCancel ? handleCancelOnboarding : undefined}
            />
          </SafeAreaProvider>
        </GestureHandlerRootView>
      </AppThemeProvider>
    );
  }

  const activeApi = api;
  const activeWs = ws;

  const renderScreen = () => {
    switch (currentScreen) {
      case 'ChatGit':
        return gitChat ? (
          <GitScreen
            api={activeApi}
            chat={gitChat}
            approvalMode={approvalMode}
            onBack={handleCloseGit}
            onChatUpdated={handleGitChatUpdated}
          />
        ) : (
          <MainScreen
            key={activeBridgeProfile?.id}
            ref={mainRef}
            api={activeApi}
            ws={activeWs}
            bridgeUrl={bridgeUrl}
            bridgeToken={bridgeToken}
            bridgeProfileId={activeBridgeProfile?.id ?? ''}
            onOpenDrawer={handleNavigationToggle}
            onOpenGit={handleOpenChatGit}
            onOpenLocalPreview={openBrowser}
            onOpenBridgeRecoveryGuide={handleOpenBridgeRecoveryGuide}
            defaultStartCwd={defaultStartCwd}
            defaultChatEngine={defaultChatEngine}
            defaultEngineSettings={defaultEngineSettings}
            onLastUsedThreadSettingsChange={handleLastUsedThreadSettingsChange}
            approvalMode={approvalMode}
            showToolCalls={showToolCalls}
            onDefaultStartCwdChange={(value) => updateSettings({ defaultStartCwd: value })}
            onChatContextChange={handleChatContextChange}
            onChatOpeningStateChange={setMainOpeningChatId}
            pendingOpenChatId={pendingMainChatId}
            pendingOpenChatSnapshot={pendingMainChatSnapshot}
            onPendingOpenChatHandled={() => {
              setPendingMainChatId(null);
              setPendingMainChatSnapshot(null);
            }}
          />
        );
      case 'Settings':
        return (
          <SettingsScreen
            api={activeApi}
            ws={activeWs}
            activeBridgeProfileId={activeBridgeProfile?.id ?? null}
            bridgeProfileName={activeBridgeProfile?.name ?? 'Current bridge'}
            bridgeProfiles={bridgeProfiles}
            approvalMode={approvalMode}
            onApprovalModeChange={(value) => updateSettings({ approvalMode: value })}
            showToolCalls={showToolCalls}
            onShowToolCallsChange={(value) => updateSettings({ showToolCalls: value })}
            workspaceChatLimit={workspaceChatLimit}
            onWorkspaceChatLimitChange={(value) => updateSettings({ workspaceChatLimit: value })}
            appearancePreference={appearancePreference}
            darkUiPalette={darkUiPalette}
            onAppearancePreferenceChange={(value) =>
              updateSettings({ appearancePreference: value })
            }
            onDarkUiPaletteChange={(value) => updateSettings({ darkUiPalette: value })}
            fontPreference={fontPreference}
            onFontPreferenceChange={(value) => updateSettings({ fontPreference: value })}
            persistenceError={appStateSnapshot.persistenceError}
            onRetryPersistence={() => appStateStore.retryPersistence()}
            onEditBridgeProfile={handleEditBridgeProfile}
            onAddBridgeProfile={handleAddBridgeProfile}
            onSwitchBridgeProfile={handleSwitchBridgeProfile}
            onRenameBridgeProfile={handleRenameBridgeProfile}
            onDeleteBridgeProfile={handleDeleteBridgeProfile}
            onClearSavedBridges={handleClearSavedBridges}
            onOpenDrawer={handleNavigationToggle}
            onDrawerGestureEnabledChange={setSettingsAllowsDrawerGesture}
            onOpenPrivacy={openPrivacy}
            onOpenTerms={openTerms}
          />
        );
      case 'Browser':
        return (
          <BrowserScreen
            ref={browserRef}
            api={activeApi}
            bridgeUrl={bridgeUrl}
            onOpenDrawer={handleNavigationToggle}
            recentTargetUrls={recentBrowserTargetUrls}
            onRecentTargetUrlsChange={(value) =>
              updateSettings({ recentBrowserTargetUrls: value })
            }
            pendingTargetUrl={pendingBrowserTargetUrl}
            onPendingTargetHandled={() => setPendingBrowserTargetUrl(null)}
          />
        );
      case 'Privacy':
        return (
          <PrivacyScreen
            policyUrl={env.privacyPolicyUrl}
            onOpenDrawer={handleNavigationToggle}
          />
        );
      case 'Terms':
        return (
          <TermsScreen
            termsUrl={env.termsOfServiceUrl}
            onOpenDrawer={handleNavigationToggle}
          />
        );
      default:
        return (
          <MainScreen
            key={activeBridgeProfile?.id}
            ref={mainRef}
            api={activeApi}
            ws={activeWs}
            bridgeUrl={bridgeUrl}
            bridgeToken={bridgeToken}
            bridgeProfileId={activeBridgeProfile?.id ?? ''}
            onOpenDrawer={handleNavigationToggle}
            onOpenGit={handleOpenChatGit}
            onOpenLocalPreview={openBrowser}
            onOpenBridgeRecoveryGuide={handleOpenBridgeRecoveryGuide}
            defaultStartCwd={defaultStartCwd}
            defaultChatEngine={defaultChatEngine}
            defaultEngineSettings={defaultEngineSettings}
            onLastUsedThreadSettingsChange={handleLastUsedThreadSettingsChange}
            approvalMode={approvalMode}
            showToolCalls={showToolCalls}
            onDefaultStartCwdChange={(value) => updateSettings({ defaultStartCwd: value })}
            onChatContextChange={handleChatContextChange}
            onChatOpeningStateChange={setMainOpeningChatId}
            pendingOpenChatId={pendingMainChatId}
            pendingOpenChatSnapshot={pendingMainChatSnapshot}
            onPendingOpenChatHandled={() => {
              setPendingMainChatId(null);
              setPendingMainChatSnapshot(null);
            }}
          />
        );
    }
  };

  return (
    <AppThemeProvider theme={theme}>
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
          <StatusBar
            barStyle={theme.statusBarStyle}
            backgroundColor={theme.colors.bgMain}
          />
          <View style={[styles.root, usesTabletLayout && styles.tabletShell]}>
            {usesTabletLayout ? (
              <Animated.View
                layout={tabletLayoutTransition}
                pointerEvents={tabletSidebarVisible ? 'auto' : 'none'}
                style={[
                  styles.tabletSidebarClip,
                  { width: tabletSidebarVisible ? TABLET_SIDEBAR_WIDTH : 0 },
                ]}
              >
                <View style={styles.tabletSidebarContent}>
                  <DrawerContent
                    key={activeBridgeProfile?.id}
                    api={activeApi}
                    ws={activeWs}
                    active
                    workspaceChatLimit={workspaceChatLimit}
                    selectedChatId={selectedChatId}
                    onSelectChat={handleSelectChat}
                    onNewChat={handleNewChat}
                    onNavigate={navigate}
                  />
                </View>
              </Animated.View>
            ) : null}
            <GestureDetector gesture={openDrawerGesture}>
              <Animated.View
                layout={usesTabletLayout ? tabletLayoutTransition : undefined}
                pointerEvents={drawerVisible && drawerCapturesTouches ? 'none' : 'auto'}
                style={[
                  styles.screenFrame,
                  usesTabletLayout && styles.tabletScreenFrame,
                  screenFrameAnimatedStyle,
                  usesTabletLayout ? null : { width: screenWidth },
                ]}
              >
                {renderScreen()}
                {chatTransitionChatId || (currentScreen === 'Main' && mainOpeningChatId) ? (
                  <View style={styles.chatTransitionOverlay}>
                    <View style={styles.chatTransitionCard}>
                      <ActivityIndicator size="small" color={theme.colors.textPrimary} />
                      <Text style={styles.chatTransitionTitle}>Opening chat...</Text>
                    </View>
                  </View>
                ) : null}
              </Animated.View>
            </GestureDetector>

            {!usesTabletLayout ? (
              <View
                pointerEvents={drawerVisible && drawerCapturesTouches ? 'auto' : 'none'}
                style={styles.drawerLayer}
              >
                <GestureDetector gesture={visibleDrawerGesture}>
                  <View style={styles.drawerGestureSurface}>
                    <GestureDetector gesture={visibleDrawerTapGesture}>
                      <Animated.View style={[styles.overlay, overlayAnimatedStyle]} />
                    </GestureDetector>

                    <Animated.View style={[styles.drawer, { width: drawerWidth }, drawerAnimatedStyle]}>
                      <Animated.View
                        style={[styles.drawerContentShell, drawerContentAnimatedStyle]}
                      >
                        <DrawerContent
                          key={activeBridgeProfile?.id}
                          api={activeApi}
                          ws={activeWs}
                          active={drawerVisible}
                          workspaceChatLimit={workspaceChatLimit}
                          selectedChatId={selectedChatId}
                          onSelectChat={handleSelectChat}
                          onNewChat={handleNewChat}
                          onNavigate={navigate}
                        />
                      </Animated.View>
                    </Animated.View>
                  </View>
                </GestureDetector>
              </View>
            ) : null}

            {currentScreen === 'ChatGit' && !usesTabletLayout ? (
              <GestureDetector gesture={chatGitBackGesture}>
                <View
                  pointerEvents={drawerVisible && drawerCapturesTouches ? 'none' : 'auto'}
                  style={styles.edgeSwipeZone}
                />
              </GestureDetector>
            ) : null}

          </View>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </AppThemeProvider>
  );
}

function normalizeBridgeToken(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getDrawerWidth(screenWidth: number): number {
  const targetWidth = screenWidth * DRAWER_SCREEN_RATIO;
  return Math.min(DRAWER_MAX_WIDTH, Math.max(DRAWER_MIN_WIDTH, targetWidth));
}

function clampDrawerOffset(value: number, drawerWidth: number): number {
  'worklet';
  return Math.max(-drawerWidth, Math.min(0, value));
}

function getDrawerOpenProgress(value: number, drawerWidth: number): number {
  'worklet';
  return (clampDrawerOffset(value, drawerWidth) + drawerWidth) / drawerWidth;
}

function applyDrawerRubberBand(value: number, drawerWidth: number): number {
  'worklet';
  if (value > 0) {
    return value * DRAWER_RUBBER_BAND_STRENGTH;
  }

  if (value < -drawerWidth) {
    return -drawerWidth + (value + drawerWidth) * DRAWER_RUBBER_BAND_STRENGTH;
  }

  return value;
}

function projectDrawerOffset(value: number, velocityX: number, drawerWidth: number): number {
  'worklet';
  return clampDrawerOffset(value + velocityX * DRAWER_VELOCITY_PROJECTION, drawerWidth);
}

function shouldSettleDrawerOpen(
  value: number,
  velocityX: number,
  drawerWidth: number,
  startOffset: number
): boolean {
  'worklet';
  if (velocityX >= DRAWER_SNAP_VELOCITY) {
    return true;
  }

  if (velocityX <= -DRAWER_SNAP_VELOCITY) {
    return false;
  }

  const projectedProgress = getDrawerOpenProgress(
    projectDrawerOffset(value, velocityX, drawerWidth),
    drawerWidth
  );
  const startedOpen = getDrawerOpenProgress(startOffset, drawerWidth) > 0.5;
  const settleThreshold = startedOpen
    ? 1 - DRAWER_SNAP_OPEN_PROGRESS
    : DRAWER_SNAP_OPEN_PROGRESS;

  return projectedProgress >= settleThreshold;
}

function buildDrawerSpringConfig(velocityX: number) {
  'worklet';
  return {
    damping: 22,
    stiffness: 260,
    mass: 0.9,
    velocity: Math.max(-1800, Math.min(1800, velocityX)),
  };
}

const createStyles = (theme: ReturnType<typeof createAppTheme>) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: theme.colors.bgMain,
    },
    loadingRoot: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.bgMain,
    },
    persistenceRecoveryRoot: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.md,
      padding: theme.spacing.xl,
      backgroundColor: theme.colors.bgMain,
    },
    persistenceRecoveryTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
      textAlign: 'center',
    },
    persistenceRecoveryMessage: {
      ...theme.typography.body,
      maxWidth: 440,
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },
    persistenceRecoveryButton: {
      minWidth: 120,
      alignItems: 'center',
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.accent,
    },
    persistenceRecoveryButtonPressed: {
      backgroundColor: theme.colors.accentPressed,
    },
    persistenceRecoveryButtonText: {
      ...theme.typography.body,
      color: theme.colors.accentText,
      fontWeight: '700',
    },
    screen: {
      flex: 1,
    },
    tabletShell: {
      flexDirection: 'row',
      backgroundColor: theme.colors.bgMain,
    },
    tabletSidebarClip: {
      width: TABLET_SIDEBAR_WIDTH,
      overflow: 'hidden',
      backgroundColor: theme.colors.bgSidebar,
    },
    tabletSidebarContent: {
      width: TABLET_SIDEBAR_WIDTH,
      flex: 1,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgSidebar,
    },
    screenFrame: {
      flex: 1,
      backgroundColor: theme.colors.bgMain,
      overflow: 'hidden',
      borderCurve: 'continuous',
      shadowColor: theme.colors.shadow,
      shadowOffset: { width: 0, height: 16 },
    },
    tabletScreenFrame: {
      width: undefined,
      borderRadius: 0,
      shadowOpacity: 0,
      shadowRadius: 0,
      elevation: 0,
    },
    chatTransitionOverlay: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 5,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 28,
      backgroundColor: theme.colors.bgMain,
    },
    chatTransitionCard: {
      width: '100%',
      maxWidth: 320,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgElevated,
      paddingHorizontal: 22,
      paddingVertical: 24,
      alignItems: 'center',
      gap: 10,
    },
    chatTransitionTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
      fontWeight: '700',
      textAlign: 'center',
    },
    overlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: theme.colors.overlayBackdrop,
      zIndex: 10,
    },
    drawerLayer: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 10,
    },
    drawerGestureSurface: {
      ...StyleSheet.absoluteFillObject,
    },
    drawer: {
      position: 'absolute',
      top: 0,
      left: 0,
      bottom: 0,
      zIndex: 20,
    },
    drawerContentShell: {
      flex: 1,
    },
    edgeSwipeZone: {
      position: 'absolute',
      top: 0,
      left: 0,
      bottom: 0,
      width: EDGE_SWIPE_WIDTH,
      zIndex: 30,
    },
  });
