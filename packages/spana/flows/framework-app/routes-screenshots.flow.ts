import { flow } from "spana-test";
import type { Platform } from "spana-test";
import { navigateToHomeScreen } from "./support/navigation.js";

interface RouteSpec {
  name: string;
  path: string;
  selector: { testID: string };
  /** testID of the drawer item for iOS navigation. null = not in drawer. */
  drawerItem?: string;
  /** Extra steps after drawer navigation (e.g. tapping a tab). */
  afterDrawer?: (app: any, expect: any) => Promise<void>;
  /**
   * Expo Router's grouped tabs index collapses to "/" on native, so the internal
   * file-system path is not a stable Android deep link target.
   */
  androidNavigation?: "deepLink" | "drawer";
}

const WEB_BASE_URL = "http://127.0.0.1:8081";

const routeSpecs: RouteSpec[] = [
  { name: "home", path: "/", selector: { testID: "home-title" } },
  {
    name: "tabs-home",
    path: "/(drawer)/(tabs)",
    selector: { testID: "tab-one-title" },
    drawerItem: "drawer-tabs-item",
    androidNavigation: "drawer",
  },
  {
    name: "tabs-explore",
    path: "/two",
    selector: { testID: "tab-two-title" },
    drawerItem: "drawer-tabs-item",
    afterDrawer: async (app: any) => {
      // Navigate to the explore tab after opening the tabs screen
      await app.tap({ testID: "tabs-explore-tab" });
    },
  },
  {
    name: "modal",
    path: "/modal",
    selector: { testID: "modal-title" },
    drawerItem: "drawer-tabs-item",
    afterDrawer: async (app: any, expect: any) => {
      // Wait for tabs screen to fully load, then open modal
      await expect({ testID: "tab-one-title" }).toBeVisible({ timeout: 10_000 });
      await app.tap({ testID: "modal-open-button" });
    },
  },
  {
    name: "playground",
    path: "/playground",
    selector: { testID: "playground-title" },
    drawerItem: "drawer-playground-item",
  },
];

function routeHref(platform: Platform, route: RouteSpec): string {
  if (platform === "web") {
    return `${WEB_BASE_URL}${route.path}`;
  }

  const normalizedPath = route.path === "/" ? "" : route.path.replace(/^\/+/, "");
  return `spana://${normalizedPath}`;
}

export default flow(
  "Framework app - capture screenshots for direct route jumps",
  {
    tags: ["e2e", "framework-app", "screenshots"],
    platforms: ["web", "android", "ios"],
    autoLaunch: false,
    timeout: 90_000,
    artifacts: {
      captureOnSuccess: true,
    },
  },
  async ({ app, expect, platform }) => {
    const failures: string[] = [];

    for (const route of routeSpecs) {
      try {
        if (platform === "android") {
          if (route.androidNavigation === "drawer" && route.drawerItem) {
            await navigateToHomeScreen({ app, expect, platform });
            await expect({ accessibilityLabel: "Show navigation menu" }).toBeVisible({
              timeout: 10_000,
            });
            await app.tap({ accessibilityLabel: "Show navigation menu" });
            await expect({ testID: route.drawerItem }).toBeVisible({ timeout: 5_000 });
            await app.tap({ testID: route.drawerItem });
            if (route.afterDrawer) {
              await route.afterDrawer(app, expect);
            }
          } else {
            // Force clear state to reset scroll position and navigation stack.
            await app.launch({ deepLink: routeHref(platform, route), clearState: true });
          }
        } else if (platform === "ios") {
          // Navigate via drawer menu — WDA's openUrl breaks session for custom URL schemes.
          // clearState ensures each route starts from a fresh home screen.
          await app.launch({ clearState: true });
          await expect({ accessibilityLabel: "Show navigation menu" }).toBeVisible({
            timeout: 10_000,
          });
          // For root "/" route, go directly to home
          if (route.path === "/") {
            await expect(route.selector).toBeVisible({ timeout: 10_000 });
          } else if (route.drawerItem) {
            await app.tap({ accessibilityLabel: "Show navigation menu" });
            await expect({ testID: route.drawerItem }).toBeVisible({ timeout: 5_000 });
            await app.tap({ testID: route.drawerItem });
            if (route.afterDrawer) {
              await route.afterDrawer(app, expect);
            }
          }
        } else {
          await app.openLink(routeHref(platform, route));
        }
        await expect(route.selector).toBeVisible({ timeout: 15_000 });
        await app.takeScreenshot(route.name);
      } catch (error) {
        failures.push(`${route.name}: ${error instanceof Error ? error.message : String(error)}`);
        try {
          await app.takeScreenshot(`${route.name}-failure`);
        } catch {
          // Ignore secondary screenshot failures so the flow can continue.
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(`Direct route screenshot flow failed:\n- ${failures.join("\n- ")}`);
    }
  },
);
