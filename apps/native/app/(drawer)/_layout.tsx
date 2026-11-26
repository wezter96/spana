import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import { Link, useNavigation } from "expo-router";
import {
  Drawer,
  DrawerContentScrollView,
  DrawerItem,
  type DrawerContentComponentProps,
} from "expo-router/drawer";
import { Pressable } from "react-native";
import { HeaderButton } from "@/components/header-button";
import { NAV_THEME } from "@/lib/constants";
import { useColorScheme } from "@/lib/use-color-scheme";

function DrawerToggle({ color }: { color: string }) {
  const navigation = useNavigation<DrawerContentComponentProps["navigation"]>();
  return (
    <Pressable
      accessibilityLabel="Show navigation menu"
      accessibilityRole="button"
      onPress={() => navigation.toggleDrawer()}
      style={{ marginLeft: 16, padding: 4 }}
    >
      <Ionicons name="menu" size={24} color={color} />
    </Pressable>
  );
}

function FrameworkDrawerContent({
  theme,
  ...props
}: DrawerContentComponentProps & {
  theme: typeof NAV_THEME.light;
}) {
  const activeRouteName = props.state.routeNames[props.state.index];

  return (
    <DrawerContentScrollView
      {...props}
      contentContainerStyle={{ backgroundColor: theme.background }}
    >
      <DrawerItem
        testID="drawer-home-item"
        accessibilityLabel="Navigate to home screen"
        label="Home"
        focused={activeRouteName === "index"}
        activeTintColor={theme.primary}
        inactiveTintColor={theme.text}
        labelStyle={{ color: theme.text }}
        icon={({ size, color }) => <Ionicons name="home-outline" size={size} style={{ color }} />}
        onPress={() => {
          props.navigation.navigate("index");
          props.navigation.closeDrawer();
        }}
      />
      <DrawerItem
        testID="drawer-playground-item"
        accessibilityLabel="Navigate to interaction playground"
        label="Playground"
        focused={activeRouteName === "playground"}
        activeTintColor={theme.primary}
        inactiveTintColor={theme.text}
        labelStyle={{ color: theme.text }}
        icon={({ size, color }) => (
          <Ionicons name="game-controller-outline" size={size} style={{ color }} />
        )}
        onPress={() => {
          props.navigation.navigate("playground");
          props.navigation.closeDrawer();
        }}
      />
      <DrawerItem
        testID="drawer-tabs-item"
        accessibilityLabel="Navigate to demo tabs screen"
        label="Demo Tabs"
        focused={activeRouteName === "(tabs)"}
        activeTintColor={theme.primary}
        inactiveTintColor={theme.text}
        labelStyle={{ color: theme.text }}
        icon={({ size, color }) => (
          <MaterialIcons name="border-bottom" size={size} style={{ color }} />
        )}
        onPress={() => {
          props.navigation.navigate("(tabs)");
          props.navigation.closeDrawer();
        }}
      />
    </DrawerContentScrollView>
  );
}

const DrawerLayout = () => {
  const { colorScheme } = useColorScheme();
  const theme = colorScheme === "dark" ? NAV_THEME.dark : NAV_THEME.light;

  return (
    <Drawer
      drawerContent={(props) => <FrameworkDrawerContent {...props} theme={theme} />}
      screenOptions={{
        headerStyle: {
          backgroundColor: theme.background,
        },
        headerTitleStyle: {
          color: theme.text,
        },
        headerTintColor: theme.primary,
        headerLeft: () => <DrawerToggle color={theme.text} />,
        drawerStyle: {
          backgroundColor: theme.background,
        },
        drawerLabelStyle: {
          color: theme.text,
        },
        drawerInactiveTintColor: theme.text,
      }}
    >
      <Drawer.Screen
        name="index"
        options={{
          headerTitle: "Home",
          drawerLabel: "Home",
          drawerIcon: ({ size, color }) => (
            <Ionicons name="home-outline" size={size} style={{ color }} />
          ),
        }}
      />
      <Drawer.Screen
        name="playground"
        options={{
          headerTitle: "Playground",
          drawerLabel: "Playground",
          drawerIcon: ({ size, color }) => (
            <Ionicons name="game-controller-outline" size={size} style={{ color }} />
          ),
        }}
      />
      <Drawer.Screen
        name="(tabs)"
        options={{
          headerTitle: "Demo Tabs",
          drawerLabel: "Demo Tabs",
          drawerIcon: ({ size, color }) => (
            <MaterialIcons name="border-bottom" size={size} style={{ color }} />
          ),
          headerRight: () => (
            <Link href="/modal" asChild>
              <HeaderButton />
            </Link>
          ),
        }}
      />
    </Drawer>
  );
};

export default DrawerLayout;
