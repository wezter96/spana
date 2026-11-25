import { flow } from "spana-test";
import { navigateToTabsScreen } from "./support/navigation.js";

export default flow(
  "Framework app - navigate to tabs explore through the UI",
  {
    tags: ["e2e", "framework-app", "tabs"],
    platforms: ["web", "android"],
    autoLaunch: false,
    artifacts: {
      captureOnSuccess: true,
      captureSteps: true,
    },
  },
  async (ctx) => {
    const { app, expect, platform } = ctx;

    await navigateToTabsScreen(ctx);
    if (platform === "android") {
      await app.tap({ text: "Explore" });
    } else {
      await app.tap({ accessibilityLabel: "Open explore tab" });
    }
    await expect({ testID: "tab-two-title" }).toBeVisible({ timeout: 10_000 });
    await expect({ testID: "tab-two-subtitle" }).toHaveText(
      "Browse more of the Spana demo experience",
    );
  },
);
