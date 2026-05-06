import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import clawdexMark from '../../assets/brand/mark.png';
import { useAppTheme, type AppTheme } from '../theme';

type ChoiceActionVariant = 'primary' | 'secondary';
type ChoiceActionLogo = 'github' | 'clawdex';

interface ChoiceActionProps {
  title: string;
  meta?: string;
  variant?: ChoiceActionVariant;
  logo?: ChoiceActionLogo;
  iconName?: keyof typeof Ionicons.glyphMap;
  loading?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

export function ChoiceAction({
  title,
  meta,
  variant = 'secondary',
  logo,
  iconName,
  loading = false,
  disabled = false,
  onPress,
}: ChoiceActionProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const isPrimary = variant === 'primary';
  const iconColor = isPrimary ? theme.colors.accentText : theme.colors.textPrimary;
  const arrowColor = isPrimary ? theme.colors.accentText : theme.colors.textMuted;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.root,
        isPrimary ? styles.rootPrimary : styles.rootSecondary,
        (disabled || loading) && styles.rootDisabled,
        pressed && !(disabled || loading) && styles.rootPressed,
      ]}
    >
      <View style={[styles.iconWrap, isPrimary && styles.iconWrapPrimary]}>
        {loading ? (
          <ActivityIndicator size="small" color={iconColor} />
        ) : logo === 'github' ? (
          <Ionicons name="logo-github" size={19} color={iconColor} />
        ) : logo === 'clawdex' ? (
          <Image
            source={clawdexMark}
            resizeMode="contain"
            style={[styles.logoImage, { tintColor: iconColor }]}
          />
        ) : iconName ? (
          <Ionicons name={iconName} size={19} color={iconColor} />
        ) : null}
      </View>
      <View style={styles.copy}>
        <Text style={[styles.title, isPrimary ? styles.titlePrimary : styles.titleSecondary]}>
          {title}
        </Text>
        {meta ? (
          <Text style={[styles.meta, isPrimary ? styles.metaPrimary : styles.metaSecondary]}>
            {meta}
          </Text>
        ) : null}
      </View>
      <Ionicons name="arrow-forward" size={20} color={arrowColor} />
    </Pressable>
  );
}

const createStyles = (theme: AppTheme) => {
  const secondaryBackground = theme.isDark
    ? 'rgba(255,255,255,0.05)'
    : 'rgba(255,255,255,0.62)';

  return StyleSheet.create({
    root: {
      minHeight: 78,
      borderRadius: 24,
      borderWidth: 1,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      borderCurve: 'continuous',
    },
    rootPrimary: {
      backgroundColor: theme.colors.accent,
      borderColor: theme.colors.accent,
      boxShadow: theme.isDark
        ? '0px 14px 28px rgba(0, 0, 0, 0.34)'
        : '0px 14px 28px rgba(15, 23, 42, 0.18)',
    },
    rootSecondary: {
      backgroundColor: secondaryBackground,
      borderColor: theme.colors.borderHighlight,
    },
    rootPressed: {
      opacity: 0.92,
    },
    rootDisabled: {
      opacity: 0.68,
    },
    iconWrap: {
      width: 42,
      height: 42,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.78)',
    },
    iconWrapPrimary: {
      backgroundColor: 'rgba(255,255,255,0.14)',
      borderColor: 'rgba(255,255,255,0.24)',
    },
    logoImage: {
      width: 22,
      height: 22,
    },
    copy: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    title: {
      ...theme.typography.headline,
      fontSize: 17,
    },
    titlePrimary: {
      color: theme.colors.accentText,
    },
    titleSecondary: {
      color: theme.colors.textPrimary,
    },
    meta: {
      ...theme.typography.caption,
      fontWeight: '600',
    },
    metaPrimary: {
      color: theme.colors.accentText,
    },
    metaSecondary: {
      color: theme.colors.textMuted,
    },
  });
};
