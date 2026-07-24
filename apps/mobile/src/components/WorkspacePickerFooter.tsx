import { Pressable, Text, View } from 'react-native';

import { controlAccessibilityState } from '../accessibility';
import type { WorkspacePickerStyles } from './workspacePickerStyles';

export function WorkspacePickerFooter({
  styles,
  bottomSafeInset,
  folderPath,
  folderTitle,
  onSelectPath,
}: {
  styles: WorkspacePickerStyles;
  bottomSafeInset: number;
  folderPath: string | null;
  folderTitle: string;
  onSelectPath: (path: string | null) => void;
}) {
  return (
    <View style={[styles.browserFooter, { paddingBottom: Math.max(bottomSafeInset, 12) }]}>
      <Pressable
        onPress={() => folderPath && onSelectPath(folderPath)}
        disabled={!folderPath}
        style={({ pressed }) => [
          styles.chooseButton,
          !folderPath && styles.buttonDisabled,
          pressed && folderPath && styles.chooseButtonPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Choose ${folderTitle} workspace`}
        accessibilityState={controlAccessibilityState({ disabled: !folderPath })}
      >
        <Text style={styles.chooseButtonText}>{`Choose "${folderTitle}"`}</Text>
      </Pressable>
    </View>
  );
}
