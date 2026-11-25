import { flow } from "spana-test";
import { navigateToPlaygroundScreen } from "./support/navigation.js";

export default flow(
  "Framework app - accessibility assertions stay green",
  {
    tags: ["showcase", "e2e", "framework-app", "accessibility"],
    platforms: ["web", "android", "ios"],
    autoLaunch: false,
    artifacts: { captureOnSuccess: true },
  },
  async (ctx) => {
    const { app, expect, platform } = ctx;

    await navigateToPlaygroundScreen(ctx);

    await expect({ testID: "playground-input" }).toHaveAccessibilityLabel("Playground text input");
    await expect({ testID: "playground-dismiss-keyboard" }).toHaveAccessibilityLabel(
      "Dismiss keyboard",
    );
    await expect({ testID: "playground-dismiss-keyboard" }).toHaveRole("button");
    await expect({ testID: "playground-dismiss-keyboard" }).toHaveMinTouchTarget(44);

    if (platform === "web") {
      await expect({ testID: "playground-content" }).toPassAccessibilityAudit({
        severity: "serious",
      });
      await expect({ testID: "playground-dismiss-keyboard" }).toBeFocusable();
    }

    await app.takeScreenshot("accessibility-showcase");
  },
);
