import { flow } from "spana-test";

/**
 * Proves `openLink` routes a deep link to the target native screen.
 *
 * Android-only: iOS WDA routes custom-scheme URLs through Safari, which
 * breaks the WDA session. iOS deep-link conformance is covered via
 * `launchApp({ deepLink })` on supported providers; here we only exercise
 * the standalone `openLink` call on Android.
 */
export default flow(
  "conformance — openLink navigates to deep link target",
  {
    tags: ["conformance", "open-link"],
    platforms: ["android"],
    autoLaunch: false,
  },
  async ({ app, expect }) => {
    // Start at home.
    await app.launch({ clearState: true, deepLink: "spana://" });
    await expect({ testID: "home-title" }).toBeVisible({ timeout: 10_000 });

    // Standalone openLink — separate from launchApp's deepLink path.
    await app.openLink("spana://playground");
    await expect({ testID: "playground-title" }).toBeVisible({ timeout: 10_000 });
  },
);
