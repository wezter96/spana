import { flow } from "spana-test";
import { navigateToPlaygroundScreen } from "./support/navigation.js";

export default flow(
  "Framework app - relative selectors disambiguate targets",
  {
    tags: ["showcase", "e2e", "framework-app", "relative-selectors"],
    platforms: ["web", "android", "ios"],
    autoLaunch: false,
    artifacts: { captureOnSuccess: true },
  },
  async (ctx) => {
    const { app, expect } = ctx;

    await navigateToPlaygroundScreen(ctx);

    await expect({
      selector: { testID: "playground-input-mirror" },
      below: { testID: "playground-input" },
    }).toHaveText("(empty)");
    await expect({
      selector: { testID: "playground-dismiss-keyboard" },
      below: { testID: "playground-input" },
    }).toBeVisible();

    await app.tap({
      selector: { testID: "playground-nested-label" },
      childOf: { testID: "playground-nested-card" },
    });
    await expect({ testID: "playground-nested-status" }).toHaveText("Activated 1x");

    await app.scrollUntilVisible(
      { testID: "playground-relative-label" },
      { timeout: 20_000, maxScrolls: 10 },
    );
    await expect({ testID: "playground-relative-label" }).toBeVisible();

    await app.tap({
      selector: { testID: "playground-relative-button" },
      rightOf: { testID: "playground-relative-label" },
    });
    await expect({ testID: "playground-relative-status" }).toHaveText("Triggered 1x");

    await app.takeScreenshot("relative-selectors");
  },
);
