import type { FlowContext } from "spana-test";

/**
 * Navigate to the playground screen from a cold launch.
 *
 * The conformance flows all start here because the playground exposes
 * the full testID surface needed to exercise every driver method.
 *
 * On Android we use a deep link (exercises `mobile: deepLink` + `clearApp`).
 * On iOS we launch with clearState and navigate through the drawer menu
 * (exercises `terminate_app` + `activate_app` + regular taps).
 */
export async function openPlayground(ctx: FlowContext): Promise<void> {
  const { app, expect, platform } = ctx;

  if (platform === "ios") {
    await app.launch({ clearState: true });
    await expect({ accessibilityLabel: "Show navigation menu" }).toBeVisible({ timeout: 10_000 });
    await app.tap({ accessibilityLabel: "Show navigation menu" });
    await expect({ testID: "drawer-playground-item" }).toBeVisible({ timeout: 5_000 });
    await app.tap({ testID: "drawer-playground-item" });
  } else if (platform === "android") {
    await app.launch({
      clearState: true,
      deepLink: "spana://playground",
    });
  } else {
    await app.openLink("http://127.0.0.1:8081/playground");
  }

  await expect({ testID: "playground-title" }).toBeVisible({ timeout: 10_000 });
}
