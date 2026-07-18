import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ChatEngine } from '../api/types';
import { ChatEngineIcon } from './ChatEngineIcon';
import { useAppTheme, type AppTheme } from '../theme';

interface ChatHeaderProps {
  onOpenDrawer: () => void;
  title: string;
  engine?: ChatEngine | null;
  engineLabel?: string;
  onOpenTitleMenu?: () => void;
  rightIconName?: keyof typeof Ionicons.glyphMap;
  onRightActionPress?: () => void;
}

export function ChatHeader({
  onOpenDrawer,
  title,
  engine,
  engineLabel,
  onOpenTitleMenu,
  rightIconName,
  onRightActionPress,
}: ChatHeaderProps) {
  const theme = useAppTheme();
  const { colors } = theme;
  const styles = useMemo(() => createStyles(theme), [theme]);
  const titleDisplay = title.trim() || 'New chat';

  return (
    <View style={styles.headerContainer}>
      <SafeAreaView edges={['top', 'left', 'right']}>
        <View style={styles.header}>
          <Pressable onPress={onOpenDrawer} hitSlop={8} style={styles.menuBtn}>
            <Ionicons name="menu" size={20} color={colors.textPrimary} />
          </Pressable>
          {onOpenTitleMenu ? (
            <Pressable
              onPress={onOpenTitleMenu}
              hitSlop={8}
              style={({ pressed }) => [styles.titleButton, pressed && styles.titleButtonPressed]}
            >
              <ScrollableTitle title={titleDisplay} />
              {engineLabel ? <ChatEngineIcon engine={engine} size={18} /> : null}
              <Ionicons name="chevron-down" size={12} color={colors.textMuted} />
            </Pressable>
          ) : (
            <View style={styles.modelNameRow}>
              <ScrollableTitle title={titleDisplay} />
              {engineLabel ? <ChatEngineIcon engine={engine} size={18} /> : null}
            </View>
          )}
          <View style={{ flex: 1 }} />
          {rightIconName ? (
            onRightActionPress ? (
              <Pressable onPress={onRightActionPress} hitSlop={8} style={styles.rightBtn}>
                <Ionicons name={rightIconName} size={18} color={colors.textMuted} />
              </Pressable>
            ) : (
              <Ionicons name={rightIconName} size={18} color={colors.textMuted} />
            )
          ) : null}
        </View>
      </SafeAreaView>
    </View>
  );
}

function ScrollableTitle({ title }: { title: string }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const scrollRef = useRef<ScrollView>(null);
  const viewportWidthRef = useRef(0);
  const contentWidthRef = useRef(0);
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showRightFade, setShowRightFade] = useState(false);

  const updateFades = (offsetX: number) => {
    const maxOffset = Math.max(0, contentWidthRef.current - viewportWidthRef.current);
    setShowLeftFade(offsetX > 1);
    setShowRightFade(offsetX < maxOffset - 1);
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ x: 0, animated: false });
    updateFades(0);
  }, [title]);

  return (
    <View style={styles.titleViewport}>
      <ScrollView
        ref={scrollRef}
        horizontal
        bounces={false}
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onLayout={(event) => {
          viewportWidthRef.current = event.nativeEvent.layout.width;
          updateFades(0);
        }}
        onContentSizeChange={(width) => {
          contentWidthRef.current = width;
          updateFades(0);
        }}
        onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
          updateFades(event.nativeEvent.contentOffset.x);
        }}
      >
        <Text style={styles.modelName}>{title}</Text>
      </ScrollView>
      {showLeftFade ? (
        <LinearGradient
          pointerEvents="none"
          colors={[theme.colors.bgMain, theme.colors.transparent]}
          style={[styles.titleFade, styles.titleFadeLeft]}
        />
      ) : null}
      {showRightFade ? (
        <LinearGradient
          pointerEvents="none"
          colors={[theme.colors.transparent, theme.colors.bgMain]}
          style={[styles.titleFade, styles.titleFadeRight]}
        />
      ) : null}
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    headerContainer: {
      backgroundColor: theme.colors.bgMain,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.sm,
    },
    menuBtn: {
      padding: 2,
    },
    rightBtn: {
      padding: 2,
    },
    modelNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      flexShrink: 1,
      minWidth: 0,
    },
    titleButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      borderRadius: 8,
      paddingHorizontal: 2,
      paddingVertical: 1,
      flexShrink: 1,
      minWidth: 0,
    },
    titleButtonPressed: {
      backgroundColor: theme.colors.bgItem,
    },
    modelName: {
      ...theme.typography.headline,
      fontSize: 17,
      color: theme.colors.textPrimary,
    },
    titleViewport: {
      position: 'relative',
      flexShrink: 1,
      minWidth: 0,
      overflow: 'hidden',
    },
    titleFade: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      width: 22,
    },
    titleFadeLeft: {
      left: 0,
    },
    titleFadeRight: {
      right: 0,
    },
  });
