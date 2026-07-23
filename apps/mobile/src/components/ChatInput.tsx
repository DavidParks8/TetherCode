import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  type TextLayoutEventData,
  type TextInputKeyPressEventData,
  View,
} from 'react-native';

import { resolveComposerBottomSpacing } from './chat-input-layout';
import { createChatInputStyles } from './chat-input-styles';
import { useAppTheme } from '../theme';
import { controlAccessibilityState, decorativeAccessibilityProps } from '../accessibility';

interface ChatInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onFocus?: () => void;
  onSubmit: () => void;
  onStop?: () => void;
  onAttachPress: () => void;
  attachDisabled?: boolean;
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
  const styles = useMemo(() => createChatInputStyles(theme), [theme]);
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
        <View style={styles.composerBar}>
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
                  accessibilityRole={onRemoveAttachment ? 'button' : undefined}
                  accessibilityLabel={`${attachment.label}${onRemoveAttachment ? ', remove attachment' : ''}`}
                  accessibilityHint={onRemoveAttachment ? 'Removes this attachment from the message' : undefined}
                >
                  <Ionicons {...decorativeAccessibilityProps} name="attach-outline" size={12} color={colors.textMuted} />
                  <Text style={styles.attachmentChipText} numberOfLines={1}>
                    {attachment.label}
                  </Text>
                  {onRemoveAttachment ? (
                    <Ionicons {...decorativeAccessibilityProps} name="close-outline" size={12} color={colors.textMuted} />
                  ) : null}
                </Pressable>
              ))}
            </ScrollView>
          ) : null}

          <View style={styles.row}>
            <Pressable
              disabled={attachDisabled}
              onPress={onAttachPress}
              hitSlop={ACTION_BUTTON_HIT_SLOP}
              style={({ pressed }) => [
                styles.plusBtn,
                attachDisabled && styles.plusBtnDisabled,
                pressed && !attachDisabled && styles.plusBtnPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Add attachment"
              accessibilityHint="Opens attachment choices"
              accessibilityState={controlAccessibilityState({ disabled: attachDisabled })}
            >
              <Ionicons {...decorativeAccessibilityProps} name="add" size={21} color={colors.textPrimary} />
            </Pressable>

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
              accessibilityLabel="Message"
              accessibilityHint="Enter a message for the agent"
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
                    accessibilityRole="button"
                    accessibilityLabel={isStopping ? 'Stopping agent' : 'Stop agent'}
                    accessibilityHint="Stops the current turn"
                    accessibilityState={controlAccessibilityState({ disabled: isStopping, busy: isStopping })}
                  >
                    <View style={styles.stopButtonContent}>
                      <Ionicons {...decorativeAccessibilityProps} name="square" size={10} color={colors.textPrimary} />
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
                    accessibilityRole="button"
                    accessibilityLabel={isLoading && !canSend ? 'Agent is responding' : 'Send message'}
                    accessibilityHint="Sends the current message"
                    accessibilityState={controlAccessibilityState({ disabled: !canSend, busy: isLoading && !canSend })}
                  >
                    {isLoading && !canSend ? (
                      <ActivityIndicator
                        size="small"
                        color={submitUsesPrimaryChrome ? colors.accentText : colors.textMuted}
                      />
                    ) : (
                      <Ionicons
                        {...decorativeAccessibilityProps}
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
