import { ScrollView, Text, View, StyleSheet } from "react-native";

import { Container } from "@/components/container";
import { NAV_THEME } from "@/lib/constants";
import { useColorScheme } from "@/lib/use-color-scheme";

export default function TabTwo() {
  const { colorScheme } = useColorScheme();
  const theme = colorScheme === "dark" ? NAV_THEME.dark : NAV_THEME.light;

  return (
    <Container>
      <ScrollView testID="tab-two-scroll" style={styles.scrollView}>
        <View testID="tab-two-content" style={styles.content}>
          <Text testID="tab-two-title" style={[styles.title, { color: theme.text }]}>
            Explore
          </Text>
          <Text
            testID="tab-two-subtitle"
            style={[styles.subtitle, { color: theme.text, opacity: 0.7 }]}
          >
            Browse more of the Spana demo experience
          </Text>
        </View>
      </ScrollView>
    </Container>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
    padding: 16,
  },
  content: {
    paddingVertical: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
  },
});
