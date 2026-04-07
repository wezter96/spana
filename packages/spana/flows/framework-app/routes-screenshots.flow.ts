import { flow } from "spana-test";
import type { Platform } from "spana-test";

interface RouteSpec {
  name: string;
  path: string;
  selector: { testID: string };
}

const WEB_BASE_URL = "http://127.0.0.1:8081";

const routeSpecs: RouteSpec[] = [
  { name: "home", path: "/", selector: { testID: "home-title" } },
  { name: "tabs-home", path: "/(drawer)/(tabs)", selector: { testID: "tab-one-title" } },
  { name: "tabs-explore", path: "/two", selector: { testID: "tab-two-title" } },
  { name: "modal", path: "/modal", selector: { testID: "modal-title" } },
  { name: "playground", path: "/playground", selector: { testID: "playground-title" } },
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
          // Force clear state to reset scroll position and navigation stack
          await app.launch({ deepLink: routeHref(platform, route), clearState: true });
        } else if (platform === "ios") {
          // Navigate via drawer menu — WDA's openUrl breaks session for custom URL schemes
          await app.launch();
          await expect({ accessibilityLabel: "Show navigation menu" }).toBeVisible({
            timeout: 10_000,
          });
          const drawerItemId = `drawer-${route.path.replace(/^\/+/, "").replace(/[()]/g, "")}-item`;
          // For root "/" route, go directly to home
          if (route.path === "/") {
            await expect(route.selector).toBeVisible({ timeout: 10_000 });
          } else {
            await app.tap({ accessibilityLabel: "Show navigation menu" });
            await expect({ testID: drawerItemId }).toBeVisible({ timeout: 5_000 });
            await app.tap({ testID: drawerItemId });
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
