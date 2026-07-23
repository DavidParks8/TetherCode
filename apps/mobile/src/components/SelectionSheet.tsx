import { Ionicons } from '@expo/vector-icons';
import { useMemo, type ComponentProps } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  type TextStyle,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createSelectionSheetStyles } from './selection-sheet-styles';
import { useAppTheme } from '../theme';
import {
  controlAccessibilityState,
  decorativeAccessibilityProps,
  useAccessibilityAnnouncement,
  useModalAccessibilityFocus,
} from '../accessibility';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

type OptionTone = 'default' | 'accent' | 'danger';
type SelectionSheetPresentation = 'default' | 'expanded';

export interface SelectionSheetOption {
  key: string;
  title: string;
  description?: string;
  descriptionNumberOfLines?: number;
  badge?: string;
  meta?: string;
  icon?: IoniconName;
  titleColor?: string;
  descriptionColor?: string;
  titleStyle?: TextStyle;
  descriptionStyle?: TextStyle;
  badgeBackgroundColor?: string;
  badgeTextColor?: string;
  metaColor?: string;
  iconColor?: string;
  selected?: boolean;
  disabled?: boolean;
  tone?: OptionTone;
  onPress: () => void;
}

interface SelectionSheetProps {
  visible: boolean;
  title: string;
  subtitle?: string;
  eyebrow?: string;
  options: SelectionSheetOption[];
  onClose: () => void;
  closeLabel?: string;
  loading?: boolean;
  loadingLabel?: string;
  emptyLabel?: string;
  presentation?: SelectionSheetPresentation;
}

export function SelectionSheet({
  visible,
  title,
  subtitle,
  eyebrow,
  options,
  onClose,
  closeLabel = 'Close',
  loading = false,
  loadingLabel = 'Loading…',
  emptyLabel = 'No options available.',
  presentation = 'default',
}: SelectionSheetProps) {
  const theme = useAppTheme();
  const { colors, spacing } = theme;
  const styles = useMemo(() => createSelectionSheetStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const expanded = presentation === 'expanded';
  const expandedTopInset = Math.max(insets.top + spacing.xl, 68);
  const expandedBottomInset = Math.max(insets.bottom + spacing.xl, 68);
  const expandedCardMaxHeight = Math.min(
    Math.max(420, Math.round(windowHeight * 0.72)),
    windowHeight - expandedTopInset - expandedBottomInset
  );
  const expandedListMaxHeight = Math.max(180, expandedCardMaxHeight - 176);
  const defaultCardMaxHeight = Math.min(
    Math.max(220, Math.round(windowHeight * 0.46)),
    windowHeight - Math.max(insets.top + spacing.xl, 72) - Math.max(insets.bottom + spacing.xl, 72)
  );
  const defaultListMaxHeight = Math.max(84, defaultCardMaxHeight - 168);
  const modalFocusRef = useModalAccessibilityFocus(visible);
  useAccessibilityAnnouncement(visible && loading ? loadingLabel : null);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      presentationStyle="overFullScreen"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={`Close ${title}`}
          accessibilityHint="Dismisses this selection sheet"
        />
        <View
          style={[
            styles.sheetOuter,
            expanded && styles.sheetOuterExpanded,
            {
              justifyContent: 'center',
              paddingBottom: expanded
                ? expandedBottomInset
                : Math.max(insets.bottom + spacing.md, spacing.xl),
              paddingTop: expanded
                ? expandedTopInset
                : Math.max(insets.top + spacing.md, spacing.xl),
            },
          ]}
        >
          <View
            accessibilityViewIsModal
            importantForAccessibility="yes"
            style={[
              styles.sheetCard,
              expanded && styles.sheetCardExpanded,
              expanded
                ? { maxHeight: expandedCardMaxHeight }
                : { maxHeight: defaultCardMaxHeight },
            ]}
          >
            <View {...decorativeAccessibilityProps} style={styles.handle} />

            <View
              ref={modalFocusRef}
              accessible
              accessibilityRole="header"
              accessibilityLabel={[title, subtitle].filter(Boolean).join('. ')}
              style={styles.header}
            >
              {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
              <Text style={styles.title}>{title}</Text>
              {subtitle ? (
                <Text style={styles.subtitle} numberOfLines={expanded ? 3 : 2}>
                  {subtitle}
                </Text>
              ) : null}
            </View>

            <View
              style={[
                styles.body,
                expanded
                  ? { maxHeight: expandedListMaxHeight }
                  : { maxHeight: defaultListMaxHeight },
              ]}
            >
              {loading ? (
                <View
                  style={styles.loadingState}
                  accessibilityRole="progressbar"
                  accessibilityLiveRegion="polite"
                  accessibilityLabel={loadingLabel}
                >
                  <ActivityIndicator color={colors.textPrimary} />
                  <Text style={styles.loadingLabel}>{loadingLabel}</Text>
                </View>
              ) : options.length > 0 ? (
                <ScrollView
                  style={[styles.list, expanded && styles.listExpanded]}
                  contentContainerStyle={[
                    styles.listContent,
                    expanded && styles.listContentExpanded,
                  ]}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                >
                  {options.map((option) => {
                    const tone = option.tone ?? 'default';
                    const iconColor =
                      option.iconColor ??
                      (tone === 'danger'
                        ? colors.error
                        : option.selected || tone === 'accent'
                          ? colors.textPrimary
                          : colors.textMuted);
                    const titleColor = option.titleColor ?? colors.textPrimary;
                    const descriptionColor = option.descriptionColor ?? colors.textMuted;
                    const metaColor = option.metaColor ?? colors.textMuted;
                    const badgeBackgroundColor =
                      option.badgeBackgroundColor ?? styles.badge.backgroundColor;
                    const badgeTextColor =
                      option.badgeTextColor ?? styles.badgeText.color;

                    return (
                      <Pressable
                        key={option.key}
                        disabled={option.disabled}
                        onPress={option.onPress}
                        accessibilityRole="button"
                        accessibilityLabel={option.title}
                        accessibilityHint={option.description}
                        accessibilityState={controlAccessibilityState({
                          disabled: option.disabled,
                          selected: option.selected,
                        })}
                        style={({ pressed }) => [
                          styles.option,
                          option.selected && styles.optionSelected,
                          option.disabled && styles.optionDisabled,
                          pressed && !option.disabled && styles.optionPressed,
                        ]}
                      >
                        <View style={styles.optionMain}>
                          {option.icon ? (
                            <View
                              style={[
                                styles.iconWrap,
                                option.selected && styles.iconWrapSelected,
                                tone === 'danger' && styles.iconWrapDanger,
                              ]}
                            >
                              <Ionicons
                                {...decorativeAccessibilityProps}
                                name={option.icon}
                                size={15}
                                color={iconColor}
                              />
                            </View>
                          ) : null}

                          <View style={styles.copy}>
                            <View style={styles.titleRow}>
                              <Text
                                style={[
                                  styles.optionTitle,
                                  option.selected && styles.optionTitleSelected,
                                  { color: titleColor },
                                  option.titleStyle,
                                ]}
                                numberOfLines={2}
                              >
                                {option.title}
                              </Text>
                              {option.badge ? (
                                <View
                                  style={[
                                    styles.badge,
                                    { backgroundColor: badgeBackgroundColor },
                                  ]}
                                >
                                  <Text style={[styles.badgeText, { color: badgeTextColor }]}>
                                    {option.badge}
                                  </Text>
                                </View>
                              ) : null}
                            </View>
                            {option.description ? (
                              <Text
                                style={[
                                  styles.optionDescription,
                                  { color: descriptionColor },
                                  option.descriptionStyle,
                                ]}
                                numberOfLines={option.descriptionNumberOfLines ?? 2}
                              >
                                {option.description}
                              </Text>
                            ) : null}
                          </View>
                        </View>

                        <View style={styles.accessory}>
                          {option.meta ? (
                            <Text
                              style={[styles.meta, { color: metaColor }]}
                              numberOfLines={1}
                            >
                              {option.meta}
                            </Text>
                          ) : null}
                          {option.selected ? (
                            <Ionicons
                              {...decorativeAccessibilityProps}
                              name="checkmark-circle"
                              size={18}
                              color={colors.textPrimary}
                            />
                          ) : null}
                        </View>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              ) : (
                <View style={styles.loadingState}>
                  <Text accessibilityLiveRegion="polite" style={styles.loadingLabel}>
                    {emptyLabel}
                  </Text>
                </View>
              )}
            </View>

            <View style={styles.footer}>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel={closeLabel}
                style={({ pressed }) => [
                  styles.closeButton,
                  pressed && styles.closeButtonPressed,
                ]}
              >
                <Text style={styles.closeText}>{closeLabel}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}
