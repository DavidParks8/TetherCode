import { Ionicons } from '@expo/vector-icons';
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { AgentDescriptor } from '../api/types';
import { UNKNOWN_AGENT_LABEL, validAgentIconUri } from '../agents';

interface AgentIconProps {
  agent?: AgentDescriptor | null;
  size?: number;
  style?: StyleProp<ViewStyle>;
}

export function AgentIcon({ agent, size = 18, style }: AgentIconProps) {
  const iconUri = validAgentIconUri(agent?.icon);
  const label = agent?.displayName.trim() || UNKNOWN_AGENT_LABEL;
  return (
    <View
      accessibilityLabel={label}
      accessibilityRole="image"
      style={[styles.frame, { width: size, height: size }, style]}
    >
      {iconUri ? (
        <Image source={{ uri: iconUri }} resizeMode="contain" style={{ width: size, height: size }} />
      ) : (
        <Ionicons name="hardware-chip-outline" size={size} color="#7f8790" />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    flexShrink: 0,
  },
});