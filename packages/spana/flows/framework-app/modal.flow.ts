import { flow } from "spana-test";
import { navigateToTabsScreen } from "./support/navigation.js";

export default flow(
  "Framework app - modal navigation through UI",
  {
    tags: ["showcase", "e2e", "framework-app"],
    platforms: ["web", "android", "ios"],
    autoLaunch: false,
    artifacts: { captureOnSuccess: true, captureSteps: true },
  },
  async (ctx) => {
    const { app, expect, platform } = ctx;

    await navigateToTabsScreen(ctx);
    await app.tap({ testID: "modal-open-button" });
    await expect({ testID: "modal-title" }).toBeVisible({ timeout: 5_000 });
    await expect({ testID: "modal-title" }).toHaveText("Modal");
    await expect({ testID: "modal-description" }).toBeVisible();
    await app.takeScreenshot("modal-open");

    if (platform === "web") {
      await app.backUntilVisible({ testID: "tab-one-title" }, { maxBacks: 2 });
    } else if (platform === "android") {
      await app.back();
    } else {
      await app.tap({ testID: "modal-dismiss-button" });
    }

    await expect({ testID: "tab-one-title" }).toBeVisible({ timeout: 15_000 });
    await app.takeScreenshot("modal-dismissed");
  },
);
