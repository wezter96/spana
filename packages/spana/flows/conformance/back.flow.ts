import { flow } from "spana-test";

/**
 * Proves `back` navigates to the previous screen on Android.
 *
 * Skipped on iOS: iOS has no system back button, so the Appium iOS driver
 * explicitly throws on back(). iOS uses tap-on-nav-bar-back-button in
 * user-facing flows instead.
 */
export default flow(
  "conformance — back navigates to previous screen",
  {
    tags: ["conformance", "back"],
    platforms: ["android"],
    autoLaunch: false,
  },
  async ({ app, expect }) => {
    // Home → drawer → playground: gives us a back stack to test against.
    await app.launch({ clearState: true, deepLink: "spana://" });
    await expect({ testID: "home-title" }).toBeVisible({ timeout: 10_000 });

    await app.launch({ clearState: false, deepLink: "spana://playground" });
    await expect({ testID: "playground-title" }).toBeVisible({ timeout: 10_000 });

    await app.back();
    // Back from playground should land us on home (deep link stack is
    // rooted at home in this app).
    await expect({ testID: "home-title" }).toBeVisible({ timeout: 10_000 });
  },
);
