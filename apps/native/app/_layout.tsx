import { DarkTheme, DefaultTheme, Stack, type Theme, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { NAV_THEME } from "@/lib/constants";
import { useColorScheme } from "@/lib/use-color-scheme";

const LIGHT_THEME: Theme = {
  ...DefaultTheme,
  colors: NAV_THEME.light,
};
const DARK_THEME: Theme = {
  ...DarkTheme,
  colors: NAV_THEME.dark,
};

export const unstable_settings = {
  initialRouteName: "(drawer)",
};

export default function RootLayout() {
  const { isDarkColorScheme } = useColorScheme();

  return (
    <>
      <ThemeProvider value={isDarkColorScheme ? DARK_THEME : LIGHT_THEME}>
        <StatusBar style={isDarkColorScheme ? "light" : "dark"} />
        <Stack>
          <Stack.Screen name="(drawer)" options={{ headerShown: false }} />
          <Stack.Screen name="modal" options={{ title: "Modal", presentation: "modal" }} />
        </Stack>
      </ThemeProvider>
    </>
  );
}
