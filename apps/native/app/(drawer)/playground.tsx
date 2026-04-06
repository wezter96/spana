import { useState, useCallback, useRef } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, Keyboard } from "react-native";

import { Container } from "@/components/container";
import { NAV_THEME } from "@/lib/constants";
import { useColorScheme } from "@/lib/use-color-scheme";

export default function Playground() {
  const { colorScheme } = useColorScheme();
  const theme = colorScheme === "dark" ? NAV_THEME.dark : NAV_THEME.light;

  const [inputValue, setInputValue] = useState("");
  const [doubleTapStatus, setDoubleTapStatus] = useState("Ready");
  const [longPressActive, setLongPressActive] = useState(false);
  const [sectionExpanded, setSectionExpanded] = useState(false);
  const lastTapAtRef = useRef(0);

  const handleDoubleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapAtRef.current < 400) {
      setDoubleTapStatus("Detected");
      lastTapAtRef.current = 0;
      return;
    }

    setDoubleTapStatus("Waiting");
    lastTapAtRef.current = now;
  }, []);

  const handleLongPress = useCallback(() => {
    setLongPressActive((prev) => !prev);
  }, []);

  return (
    <Container>
      <ScrollView testID="playground-scroll" style={styles.scrollView}>
        <View testID="playground-content" style={styles.content}>
          <Text testID="playground-title" style={[styles.title, { color: theme.text }]}>
            Interaction Playground
          </Text>

          {/* Text input section */}
          <View
            testID="playground-input-card"
            style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}
          >
            <Text style={[styles.cardTitle, { color: theme.text }]}>Text Input</Text>
            <TextInput
              testID="playground-input"
              accessibilityLabel="Playground text input"
              style={[
                styles.textInput,
                { color: theme.text, borderColor: theme.border, backgroundColor: theme.background },
              ]}
              placeholder="Type something..."
              placeholderTextColor={theme.border}
              value={inputValue}
              onChangeText={setInputValue}
            />
            <Text
              testID="playground-input-mirror"
              style={[styles.mirrorText, { color: theme.text }]}
            >
              {inputValue || "(empty)"}
            </Text>
            <Pressable
              testID="playground-dismiss-keyboard"
              accessibilityLabel="Dismiss keyboard"
              accessibilityRole="button"
              onPress={() => Keyboard.dismiss()}
              style={[styles.button, { backgroundColor: theme.primary }]}
            >
              <Text style={styles.buttonText}>Dismiss Keyboard</Text>
            </Pressable>
          </View>

          {/* Double tap target */}
          <Pressable
            testID="playground-double-tap"
            accessibilityLabel="Double tap target"
            accessibilityRole="button"
            onPress={handleDoubleTap}
            style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}
          >
            <Text style={[styles.cardTitle, { color: theme.text }]}>Double Tap Target</Text>
            <Text
              testID="playground-double-tap-status"
              style={[styles.countText, { color: theme.primary }]}
            >
              {doubleTapStatus}
            </Text>
          </Pressable>

          {/* Long press target */}
          <Pressable
            testID="playground-long-press"
            accessibilityLabel="Long press target"
            accessibilityRole="button"
            onLongPress={handleLongPress}
            delayLongPress={800}
            style={[
              styles.card,
              {
                backgroundColor: longPressActive ? theme.primary : theme.card,
                borderColor: theme.border,
              },
            ]}
          >
            <Text style={[styles.cardTitle, { color: longPressActive ? "#ffffff" : theme.text }]}>
              Long Press Target
            </Text>
            <Text
              testID="playground-long-press-status"
              style={{ color: longPressActive ? "#ffffff" : theme.text }}
            >
              {longPressActive ? "Activated" : "Inactive"}
            </Text>
          </Pressable>

          {/* Expandable section */}
          <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Pressable
              testID="playground-toggle"
              accessibilityLabel="Toggle details section"
              accessibilityRole="button"
              onPress={() => setSectionExpanded((prev) => !prev)}
            >
              <Text style={[styles.cardTitle, { color: theme.text }]}>
                {sectionExpanded ? "Hide Details" : "Show Details"}
              </Text>
            </Pressable>
            {sectionExpanded && (
              <View testID="playground-details">
                <Text testID="playground-details-text" style={{ color: theme.text }}>
                  These are the hidden details that only appear when the section is expanded.
                </Text>
              </View>
            )}
            {!sectionExpanded && (
              <Text
                testID="playground-details-hidden"
                style={{ color: theme.border, fontSize: 12 }}
              >
                Tap above to reveal content
              </Text>
            )}
          </View>

          {/* Spacer content for scroll testing */}
          <View style={styles.spacer}>
            <Text style={[styles.spacerLabel, { color: theme.border }]}>
              Scroll down to find the sentinel
            </Text>
          </View>
          <View style={styles.spacer}>
            <Text style={[styles.spacerLabel, { color: theme.border }]}>Keep scrolling...</Text>
          </View>

          {/* Bottom sentinel */}
          <View
            testID="playground-sentinel"
            style={[styles.sentinel, { backgroundColor: theme.primary }]}
          >
            <Text testID="playground-sentinel-text" style={styles.sentinelText}>
              Bottom Reached
            </Text>
          </View>
        </View>
      </ScrollView>
    </Container>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 16,
  },
  card: {
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderRadius: 8,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 8,
  },
  textInput: {
    borderWidth: 1,
    borderRadius: 6,
    padding: 12,
    fontSize: 16,
    marginBottom: 8,
  },
  mirrorText: {
    fontSize: 14,
    marginBottom: 12,
  },
  button: {
    padding: 12,
    borderRadius: 6,
    alignItems: "center",
  },
  buttonText: {
    color: "#ffffff",
    fontWeight: "600",
  },
  countText: {
    fontSize: 20,
    fontWeight: "bold",
  },
  spacer: {
    height: 300,
    justifyContent: "center",
    alignItems: "center",
  },
  spacerLabel: {
    fontSize: 14,
  },
  sentinel: {
    padding: 20,
    borderRadius: 8,
    alignItems: "center",
    marginBottom: 32,
  },
  sentinelText: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "bold",
  },
});
