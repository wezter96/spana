import { flow } from "../../src/api/flow.js";
import type { Platform } from "../../src/schemas/selector.js";

const WEB_BASE_URL = "http://127.0.0.1:8081";

function homePath(_platform: Platform): string {
  return "/";
}

function homeHref(platform: Platform): string {
  const path = homePath(platform);
  return platform === "web" ? `${WEB_BASE_URL}${path}` : `spana://${path}`;
}

export default flow(
  "Framework app - navigate to tabs explore through the UI",
  {
    tags: ["e2e", "framework-app", "tabs"],
    platforms: ["web", "android", "ios"],
    autoLaunch: false,
    artifacts: {
      captureOnSuccess: true,
      captureSteps: true,
    },
  },
  async ({ app, expect, platform }) => {
    try {
      await app.stop();
    } catch {
      /* may not be running */
    }
    await app.launch({ deepLink: homeHref(platform) });
    await expect({ accessibilityLabel: "Show navigation menu" }).toBeVisible({ timeout: 10_000 });
    await app.tap({ accessibilityLabel: "Show navigation menu" });
    await expect({ testID: "drawer-tabs-item" }).toBeVisible({ timeout: 10_000 });
    await app.tap({ testID: "drawer-tabs-item" });
    await expect({ testID: "tab-one-title" }).toBeVisible();
    await app.tap({ accessibilityLabel: "Open explore tab" });
    await expect({ testID: "tab-two-title" }).toBeVisible();
    await expect({ testID: "tab-two-subtitle" }).toHaveText("Discover more features and content");
  },
);
