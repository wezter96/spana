import FontAwesome from "@expo/vector-icons/FontAwesome";
import { forwardRef } from "react";
import { Pressable, StyleSheet, type ViewInstance } from "react-native";

import { NAV_THEME } from "@/lib/constants";
import { useColorScheme } from "@/lib/use-color-scheme";

export const HeaderButton = forwardRef<ViewInstance, { onPress?: () => void }>(
  ({ onPress }, ref) => {
    const { colorScheme } = useColorScheme();
    const theme = colorScheme === "dark" ? NAV_THEME.dark : NAV_THEME.light;

    return (
      <Pressable
        ref={ref}
        testID="modal-open-button"
        accessibilityLabel="Open modal"
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [
          styles.button,
          {
            backgroundColor: pressed ? theme.background : theme.card,
          },
        ]}
      >
        {({ pressed }) => (
          <FontAwesome
            name="info-circle"
            size={20}
            color={theme.text}
            style={{
              opacity: pressed ? 0.7 : 1,
            }}
          />
        )}
      </Pressable>
    );
  },
);

const styles = StyleSheet.create({
  button: {
    padding: 8,
    marginRight: 8,
  },
});
