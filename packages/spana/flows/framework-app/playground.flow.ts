import { flow } from "spana-test";
import { buildFrameworkHref } from "./support/navigation.js";

export default flow(
  "Framework app - interaction playground showcase",
  {
    tags: ["showcase", "e2e", "framework-app"],
    platforms: ["web", "android", "ios"],
    autoLaunch: false,
    timeout: 90_000,
    artifacts: { captureOnSuccess: true, captureSteps: true },
  },
  async ({ app, expect, platform }) => {
    if (platform === "ios") {
      // Navigate via drawer menu — WDA's openUrl breaks session for custom URL schemes
      await app.launch();
      await expect({ accessibilityLabel: "Show navigation menu" }).toBeVisible({ timeout: 10_000 });
      await app.tap({ accessibilityLabel: "Show navigation menu" });
      await expect({ testID: "drawer-playground-item" }).toBeVisible({ timeout: 5_000 });
      await app.tap({ testID: "drawer-playground-item" });
    } else {
      await app.launch({
        clearState: platform === "android",
        deepLink: buildFrameworkHref(platform, "/playground"),
      });
    }
    await expect({ testID: "playground-title" }).toBeVisible({ timeout: 10_000 });

    await app.tap({ testID: "playground-input" });
    const inputText = platform === "android" ? "Hello spana" : "Hello 👨‍👩‍👧‍👦 cafe\u0301";
    await app.inputText(inputText);
    await expect({ testID: "playground-input-mirror" }).toHaveText(inputText);
    await app.dismissKeyboard();
    await app.takeScreenshot("text-input-unicode");

    await app.doubleTap({ testID: "playground-double-tap" });
    await expect({ testID: "playground-double-tap-status" }).toHaveText("Detected");
    await app.takeScreenshot("double-tap");

    await app.longPress({ testID: "playground-long-press" });
    await expect({ testID: "playground-long-press-status" }).toHaveText("Activated");
    await app.takeScreenshot("long-press");

    await app.tap({ testID: "playground-nested-label" });
    await expect({ testID: "playground-nested-status" }).toHaveText("Activated 1x");
    await app.takeScreenshot("nested-target-resolution");

    await expect({ testID: "playground-details-text" }).toBeHidden();
    await app.tap({ testID: "playground-toggle" });
    await expect({ testID: "playground-details-text" }).toBeVisible();
    await app.takeScreenshot("section-expanded");

    await app.scrollUntilVisible({ testID: "playground-sentinel" }, { timeout: 20_000, maxScrolls: 10 });
    await expect({ testID: "playground-sentinel" }).toBeVisible({ timeout: 10_000 });
    await expect({ testID: "playground-sentinel-text" }).toHaveText("Bottom Reached");
    await app.takeScreenshot("scroll-sentinel");
  },
);
