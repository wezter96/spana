import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import { Link, useNavigation } from "expo-router";
import { Pressable } from "react-native";
import { Drawer } from "expo-router/drawer";
import {
  DrawerContentScrollView,
  DrawerItem,
  type DrawerContentComponentProps,
} from "@react-navigation/drawer";
import { HeaderButton } from "@/components/header-button";
import { NAV_THEME } from "@/lib/constants";
import { useColorScheme } from "@/lib/use-color-scheme";

function DrawerToggle({ color }: { color: string }) {
  const navigation = useNavigation();
  return (
    <Pressable
      accessibilityLabel="Show navigation menu"
      accessibilityRole="button"
      onPress={() => (navigation as any).toggleDrawer()}
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
        icon={({ size, color }) => <Ionicons name="home-outline" size={size} color={color} />}
        onPress={() => {
          props.navigation.navigate("index");
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
        icon={({ size, color }) => <MaterialIcons name="border-bottom" size={size} color={color} />}
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
            <Ionicons name="home-outline" size={size} color={color} />
          ),
        }}
      />
      <Drawer.Screen
        name="(tabs)"
        options={{
          headerTitle: "Demo Tabs",
          drawerLabel: "Demo Tabs",
          drawerIcon: ({ size, color }) => (
            <MaterialIcons name="border-bottom" size={size} color={color} />
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
