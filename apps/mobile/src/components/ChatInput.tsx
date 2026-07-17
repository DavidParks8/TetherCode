import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextLayoutEventData,
  type TextInputKeyPressEventData,
  View,
} from 'react-native';

import { resolveComposerBottomSpacing } from './chat-input-layout';
import { useAppTheme, type AppTheme } from '../theme';

interface ChatInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onFocus?: () => void;
  onSubmit: () => void;
  onStop?: () => void;
  onAttachPress: () => void;
  attachDisabled?: boolean;
  onPromptLibraryPress?: () => void;
  attachments?: Array<{ id: string; label: string }>;
  onRemoveAttachment?: (id: string) => void;
  isLoading: boolean;
  showStopButton?: boolean;
  isStopping?: boolean;
  placeholder?: string;
  safeAreaBottomInset?: number;
  keyboardVisible?: boolean;
  footer?: ReactNode;
  reserveFooterSpace?: boolean;
}

export function ChatInput({
  value,
  onChangeText,
  onFocus,
  onSubmit,
  onStop,
  onAttachPress,
  attachDisabled = false,
  onPromptLibraryPress,
  attachments = [],
  onRemoveAttachment,
  isLoading,
  showStopButton = false,
  isStopping = false,
  placeholder = 'Message agent...',
  safeAreaBottomInset = 0,
  keyboardVisible = false,
  footer = null,
  reserveFooterSpace = false,
}: ChatInputProps) {
  const theme = useAppTheme();
  const { colors } = theme;
  const styles = useMemo(() => createStyles(theme), [theme]);
  const ACTION_BUTTON_HIT_SLOP = 6;
  const ACTION_BUTTON_PRESS_RETENTION_OFFSET = 8;
  const INPUT_TEXT_LINE_HEIGHT = 20;
  const INPUT_TEXT_VERTICAL_PADDING = Platform.OS === 'ios' ? 2 : 0;
  const INPUT_TEXT_MIN_HEIGHT = 20;
  const INPUT_TEXT_MAX_HEIGHT = 96;
  const [inputHeight, setInputHeight] = useState(INPUT_TEXT_MIN_HEIGHT);
  const [inputWidth, setInputWidth] = useState(0);
  const updateInputHeight = (height: number) => {
    const nextHeight = Math.max(
      INPUT_TEXT_MIN_HEIGHT,
      Math.min(INPUT_TEXT_MAX_HEIGHT, Math.ceil(height))
    );
    setInputHeight((previousHeight) =>
      previousHeight === nextHeight ? previousHeight : nextHeight
    );
  };

  useEffect(() => {
    if (!value && inputHeight !== INPUT_TEXT_MIN_HEIGHT) {
      setInputHeight(INPUT_TEXT_MIN_HEIGHT);
    }
  }, [inputHeight, value]);

  const canSend = value.trim().length > 0;
  const canStop = Boolean(showStopButton && onStop);
  const showSendButton = canSend || (isLoading && !canStop);
  const inputScrollEnabled = inputHeight >= INPUT_TEXT_MAX_HEIGHT;
  const submitUsesPrimaryChrome = showSendButton && !canStop;
  const shouldShowActionButton = canStop || showSendButton;
  const composerBottomSpacing = resolveComposerBottomSpacing(
    Platform.OS,
    safeAreaBottomInset,
    keyboardVisible
  );

  return (
    <View style={styles.shell}>
      <View
        style={[
          styles.container,
          {
            paddingBottom: composerBottomSpacing.totalBottomPadding,
          },
        ]}
      >
        {attachments.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.attachmentListContent}
            style={styles.attachmentList}
          >
            {attachments.map((attachment, index) => (
              <Pressable
                key={`${attachment.id}-${String(index)}`}
                onPress={
                  onRemoveAttachment
                    ? () => onRemoveAttachment(attachment.id)
                    : undefined
                }
                style={({ pressed }) => [
                  styles.attachmentChip,
                  pressed && styles.attachmentChipPressed,
                ]}
              >
                <Ionicons name="attach-outline" size={12} color={colors.textMuted} />
                <Text style={styles.attachmentChipText} numberOfLines={1}>
                  {attachment.label}
                </Text>
                {onRemoveAttachment ? (
                  <Ionicons name="close-outline" size={12} color={colors.textMuted} />
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        <View style={styles.row}>
          <Pressable
            disabled={attachDisabled}
            onPress={onAttachPress}
            style={({ pressed }) => [
              styles.plusBtn,
              attachDisabled && styles.plusBtnDisabled,
              pressed && !attachDisabled && styles.plusBtnPressed,
            ]}
          >
            <Ionicons name="add" size={20} color={colors.textMuted} />
          </Pressable>

          {onPromptLibraryPress ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open prompt library"
              onPress={onPromptLibraryPress}
              style={({ pressed }) => [
                styles.promptLibraryBtn,
                pressed && styles.plusBtnPressed,
              ]}
            >
              <Ionicons name="bookmark-outline" size={17} color={colors.textMuted} />
            </Pressable>
          ) : null}

          <View style={styles.inputWrapper}>
            <Text
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={[
                styles.inputMeasure,
                {
                  width: inputWidth,
                  lineHeight: INPUT_TEXT_LINE_HEIGHT,
                  paddingVertical: INPUT_TEXT_VERTICAL_PADDING,
                },
              ]}
              onTextLayout={(event: NativeSyntheticEvent<TextLayoutEventData>) => {
                if (inputWidth <= 0) {
                  return;
                }
                const lineCount = Math.max(1, event.nativeEvent.lines.length);
                const measuredHeight =
                  lineCount * INPUT_TEXT_LINE_HEIGHT + INPUT_TEXT_VERTICAL_PADDING * 2;
                updateInputHeight(measuredHeight);
              }}
            >
              {value.length > 0 ? `${value}\u200b` : ' '}
            </Text>
            <TextInput
              style={[styles.input, { height: inputHeight }]}
              value={value}
              onChangeText={onChangeText}
              keyboardAppearance={theme.keyboardAppearance}
              onLayout={(event) => {
                const nextWidth = Math.floor(event.nativeEvent.layout.width);
                setInputWidth((previousWidth) =>
                  previousWidth === nextWidth ? previousWidth : nextWidth
                );
              }}
              onFocus={onFocus}
              placeholder={placeholder}
              placeholderTextColor={colors.textMuted}
              multiline
              scrollEnabled={inputScrollEnabled}
              onKeyPress={(e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
                const keyEvent = e.nativeEvent as TextInputKeyPressEventData & {
                  shiftKey?: boolean;
                };
                if (
                  Platform.OS === 'web' &&
                  keyEvent.key === 'Enter' &&
                  !keyEvent.shiftKey
                ) {
                  e.preventDefault();
                  if (canSend) onSubmit();
                }
              }}
            />
            {shouldShowActionButton ? (
              <View style={styles.actionButtons}>
                {canStop ? (
                  <Pressable
                    onPress={onStop}
                    style={styles.sendBtn}
                    disabled={isStopping}
                    hitSlop={ACTION_BUTTON_HIT_SLOP}
                    pressRetentionOffset={ACTION_BUTTON_PRESS_RETENTION_OFFSET}
                  >
                    <View style={styles.stopButtonContent}>
                      <Ionicons name="square" size={10} color={colors.textPrimary} />
                      <ActivityIndicator
                        size="small"
                        color={colors.textMuted}
                        style={styles.stopButtonSpinner}
                      />
                    </View>
                  </Pressable>
                ) : null}
                {showSendButton ? (
                  <Pressable
                    onPress={canSend ? onSubmit : undefined}
                    style={[styles.sendBtn, submitUsesPrimaryChrome && styles.sendBtnPrimary]}
                    disabled={!canSend}
                    hitSlop={ACTION_BUTTON_HIT_SLOP}
                    pressRetentionOffset={ACTION_BUTTON_PRESS_RETENTION_OFFSET}
                  >
                    {isLoading && !canSend ? (
                      <ActivityIndicator
                        size="small"
                        color={submitUsesPrimaryChrome ? colors.accentText : colors.textMuted}
                      />
                    ) : (
                      <Ionicons
                        name="arrow-up"
                        size={14}
                        color={submitUsesPrimaryChrome ? colors.accentText : colors.textPrimary}
                      />
                    )}
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>
        {footer || reserveFooterSpace ? (
          <View
            style={[
              styles.footer,
              !footer && styles.footerPlaceholder,
            ]}
          >
            {footer}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    shell: {
      overflow: 'hidden',
    },
    container: {
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.xs + 2,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    footer: {
      alignItems: 'flex-start',
      marginTop: 1,
    },
    footerPlaceholder: {
      minHeight: 16,
    },
    attachmentList: {
      maxHeight: 34,
    },
    attachmentListContent: {
      gap: theme.spacing.xs,
      paddingRight: theme.spacing.sm,
    },
    attachmentChip: {
      height: 28,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderHighlight,
      backgroundColor: theme.colors.bgInput,
      paddingHorizontal: theme.spacing.sm,
      alignItems: 'center',
      flexDirection: 'row',
      gap: theme.spacing.xs,
      maxWidth: 260,
    },
    attachmentChipPressed: {
      backgroundColor: theme.colors.bgItem,
    },
    attachmentChipText: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      flexShrink: 1,
    },
    plusBtn: {
      width: 44,
      height: 44,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.bgElevated,
      alignItems: 'center',
      justifyContent: 'center',
    },
    plusBtnPressed: {
      backgroundColor: theme.colors.bgItem,
    },
    plusBtnDisabled: {
      opacity: 0.45,
    },
    promptLibraryBtn: {
      width: 44,
      height: 44,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.bgElevated,
      alignItems: 'center',
      justifyContent: 'center',
    },
    inputWrapper: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.bgInput,
      borderWidth: 1,
      borderColor: theme.colors.borderHighlight,
      borderRadius: theme.radius.lg,
      paddingHorizontal: theme.spacing.sm + 2,
      paddingVertical: 3,
      minHeight: 44,
      maxHeight: 120,
    },
    input: {
      ...theme.typography.body,
      flex: 1,
      color: theme.colors.textPrimary,
      lineHeight: 20,
      paddingVertical: Platform.OS === 'ios' ? 2 : 0,
      textAlignVertical: 'top',
    },
    inputMeasure: {
      position: 'absolute',
      opacity: 0,
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      left: theme.spacing.sm + 2,
      top: theme.spacing.xs,
    },
    actionButtons: {
      flexDirection: 'row',
      alignItems: 'center',
      marginLeft: theme.spacing.xs,
      gap: theme.spacing.xs / 2,
    },
    sendBtn: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: theme.colors.bgElevated,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendBtnPrimary: {
      backgroundColor: theme.colors.accent,
    },
    stopButtonContent: {
      width: 24,
      height: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stopButtonSpinner: {
      position: 'absolute',
    },
  });
