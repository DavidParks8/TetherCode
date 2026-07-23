import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { BridgeUiModal } from '../components/BridgeUiSurface';
import { controlAccessibilityState } from '../accessibility';
import type { MainScreenPanelCollapseCoordinatorContext, MainScreenPanelCollapseCoordinatorResult } from './mainScreenPanelCollapseCoordinator';




type Context = MainScreenPanelCollapseCoordinatorContext & MainScreenPanelCollapseCoordinatorResult;

export function MainScreenApprovalAndBridgePrompts({ context }: { context: Context }) {
  const {
    pendingUserInputRequest,
    styles,
    userInputDrafts,
    setUserInputDraft,
    theme,
    resolvingUserInput,
    userInputError,
    dismissUserInputRequest,
    submitUserInputRequest,
    modalBridgeUiSurface,
    handleBridgeUiAction,
    dismissBridgeUiSurface,
  } = context;

  return (
    <>
      <Modal
                visible={Boolean(pendingUserInputRequest)}
                transparent
                animationType="fade"
                onRequestClose={() => {
                  // This prompt requires a reply; keep it visible until submitted.
                }}
              >
                <View style={styles.userInputModalBackdrop}>
                  <View accessibilityViewIsModal importantForAccessibility="yes" style={styles.userInputModalCard}>
                    <Text style={styles.userInputModalTitle}>Clarification needed</Text>
                    <ScrollView
                      style={styles.userInputQuestionsList}
                      contentContainerStyle={styles.userInputQuestionsListContent}
                      showsVerticalScrollIndicator={false}
                    >
                      {(pendingUserInputRequest?.questions ?? []).map((question, questionIndex) => {
                        const answer = userInputDrafts[question.id] ?? '';
                        const hasPresetOptions =
                          Array.isArray(question.options) && question.options.length > 0;
                        const needsFreeformInput = !hasPresetOptions || question.isOther;
                        return (
                          <View
                            key={`${question.id}-${String(questionIndex)}`}
                            style={styles.userInputQuestionCard}
                          >
                            <Text style={styles.userInputQuestionHeader}>{question.header}</Text>
                            <Text style={styles.userInputQuestionText}>{question.question}</Text>
                            {hasPresetOptions ? (
                              <View style={styles.userInputOptionsColumn}>
                                {question.options?.map((option, index) => (
                                  <Pressable
                                    key={`${question.id}-${String(index)}-${option.value}`}
                                    style={({ pressed }) => [
                                      styles.userInputOptionButton,
                                      answer.trim() === option.value.trim() &&
                                        styles.userInputOptionButtonSelected,
                                      pressed && styles.userInputOptionButtonPressed,
                                    ]}
                                    onPress={() => setUserInputDraft(question.id, option.value)}
                                    accessibilityRole="radio"
                                    accessibilityState={{ checked: answer.trim() === option.value.trim() }}
                                    accessibilityLabel={option.label}
                                    accessibilityHint={option.description || undefined}
                                  >
                                    <View style={styles.userInputOptionHeaderRow}>
                                      <Text style={styles.userInputOptionIndex}>
                                        {`${String(index + 1)}.`}
                                      </Text>
                                      <Text style={styles.userInputOptionLabel}>{option.label}</Text>
                                    </View>
                                    {option.description.trim() ? (
                                      <Text style={styles.userInputOptionDescription}>
                                        {option.description}
                                      </Text>
                                    ) : null}
                                  </Pressable>
                                ))}
                              </View>
                            ) : null}
                            {needsFreeformInput ? (
                              <TextInput
                                value={answer}
                                onChangeText={(value) => setUserInputDraft(question.id, value)}
                                keyboardAppearance={theme.keyboardAppearance}
                                placeholder={
                                  question.isOther
                                    ? 'Or enter a custom answer…'
                                    : 'Type your answer…'
                                }
                                placeholderTextColor={theme.colors.textMuted}
                                secureTextEntry={question.isSecret}
                                editable={!resolvingUserInput}
                                multiline={!question.isSecret && question.fieldType !== 'boolean'}
                                keyboardType={
                                  question.fieldType === 'integer'
                                    ? 'number-pad'
                                    : question.fieldType === 'number'
                                      ? 'decimal-pad'
                                      : 'default'
                                }
                                style={[
                                  styles.userInputAnswerInput,
                                  question.isSecret && styles.userInputAnswerInputSecret,
                                ]}
                                accessibilityLabel={question.header || question.question}
                              />
                            ) : null}
                          </View>
                        );
                      })}
                    </ScrollView>
                    {userInputError ? (
                      <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.userInputErrorText}>{userInputError}</Text>
                    ) : null}
                    <View style={styles.userInputModalActions}>
                      <Pressable
                        onPress={() => void dismissUserInputRequest('cancel')}
                        style={({ pressed }) => [styles.userInputSecondaryButton, pressed && styles.userInputSubmitButtonPressed]}
                        disabled={resolvingUserInput}
                        accessibilityRole="button"
                        accessibilityLabel="Cancel request"
                      >
                        <Text style={styles.userInputSecondaryButtonText}>Cancel</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => void dismissUserInputRequest('decline')}
                        style={({ pressed }) => [styles.userInputSecondaryButton, pressed && styles.userInputSubmitButtonPressed]}
                        disabled={resolvingUserInput}
                        accessibilityRole="button"
                        accessibilityLabel="Decline request"
                      >
                        <Text style={styles.userInputSecondaryButtonText}>Decline</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => void submitUserInputRequest()}
                        style={({ pressed }) => [
                          styles.userInputSubmitButton,
                          pressed && styles.userInputSubmitButtonPressed,
                          resolvingUserInput && styles.userInputSubmitButtonDisabled,
                        ]}
                        disabled={resolvingUserInput}
                        accessibilityRole="button"
                        accessibilityState={controlAccessibilityState({ disabled: resolvingUserInput, busy: resolvingUserInput })}
                      >
                        <Text style={styles.userInputSubmitButtonText}>
                          {resolvingUserInput ? 'Submitting…' : 'Submit answers'}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              </Modal>
      {modalBridgeUiSurface ? (
                <BridgeUiModal
                  surface={modalBridgeUiSurface}
                  onAction={(nextSurface, action) => {
                    void handleBridgeUiAction(nextSurface, action);
                  }}
                  onDismiss={(surface) => {
                    void dismissBridgeUiSurface(surface);
                  }}
                />
              ) : null}
    </>
  );
}
