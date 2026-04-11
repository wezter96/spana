import { flow } from "spana-test";

/**
 * Proves `launchApp({ deepLink })` navigates to the target route on Android
 * Appium drivers. The deep link path is also implicitly exercised by
 * `openPlayground` on Android, but this flow makes it an explicit assertion.
 *
 * Skipped on iOS because WDA's openUrl routes custom schemes through Safari,
 * which breaks the WDA session — we navigate iOS through the drawer instead.
 * See `flows/framework-app/support/navigation.ts` for the history.
 */
export default flow(
  "conformance — launchApp with deepLink navigates to target route",
  {
    tags: ["conformance", "deep-link"],
    platforms: ["android"],
    autoLaunch: false,
  },
  async (ctx) => {
    const { app, expect } = ctx;
    // Navigate to home first so we have a known non-playground starting point.
    await app.launch({ clearState: true, deepLink: "spana://" });
    await expect({ testID: "home-title" }).toBeVisible({ timeout: 10_000 });

    // Now deep-link into playground from a live session — this should land
    // directly on the playground screen, not home.
    await app.launch({ clearState: true, deepLink: "spana://playground" });
    await expect({ testID: "playground-title" }).toBeVisible({ timeout: 10_000 });
    // Prove we're really on playground, not a stale cached home screen.
    await expect({ testID: "playground-input" }).toBeVisible();
  },
);
