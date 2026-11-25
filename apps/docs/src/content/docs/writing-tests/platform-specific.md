---
title: Platform-Specific Tests
description: Writing platform-aware tests using the platform context value and FlowConfig.platforms.
---

spana runs a single flow file against multiple platforms. There are two mechanisms for platform-specific behavior: branching inside a flow, and restricting a flow to specific platforms entirely.

## Branching inside a flow

The `platform` value in `FlowContext` is `"web" | "android" | "ios" | "electron" | "electrobun"`. Use it for conditional logic within a flow that is mostly shared across platforms.

```ts
import { flow } from "spana-test";

export default flow("user can share content", async ({ app, expect, platform }) => {
  await app.tap({ testID: "share-button" });

  if (platform === "ios") {
    // iOS share sheet uses a native action sheet
    await expect({ text: "Copy Link" }).toBeVisible();
    await app.tap({ text: "Copy Link" });
  } else if (platform === "android") {
    // Android uses the system share dialog
    await expect({ text: "Copy to clipboard" }).toBeVisible();
    await app.tap({ text: "Copy to clipboard" });
  } else {
    // Web uses a custom share modal
    await expect({ testID: "share-modal" }).toBeVisible();
    await app.tap({ testID: "copy-link" });
  }

  await expect({ testID: "share-confirmation" }).toBeVisible();
});
```

## Restricting a flow to specific platforms

Use `FlowConfig.platforms` to prevent a flow from running on platforms where it does not apply.

```ts
import { flow } from "spana-test";

export default flow(
  "push notification permissions",
  { platforms: ["android", "ios"] },
  async ({ app, expect }) => {
    await app.tap({ testID: "enable-notifications" });
    await expect({ testID: "permission-granted" }).toBeVisible();
  },
);
```

This flow is skipped on `web` (and any other platform not in the list), even when that platform is part of the same run.

`FlowConfig.when.platform` is different: it only drops the flow when none of the run's platforms match. See [Conditional execution](/writing-tests/flows/#conditional-execution-with-when).

## CLI platform filtering

Regardless of per-flow `platforms` config, you can also filter at the CLI:

```bash
# Run only on web
spana test --platform web

# Run on android and ios only
spana test --platform android,ios
```

CLI filtering takes effect before per-flow filtering. A flow with `platforms: ["android"]` will not run if you pass `--platform web`, even if both are in your config.

## Device emulation and OS events

| API                                             | Playwright web                                                 | Android                                                      | iOS                                                                |
| ----------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `setGeolocation({ latitude, longitude })`       | Yes; also grant location access                                | Local emulator or supported Appium driver                    | Simulator or supported Appium driver                               |
| `setSystemTime(date)`                           | Yes; changes browser wall time without pausing timers          | —                                                            | —                                                                  |
| `grantPermission(name)`, `denyPermission(name)` | Grant via Playwright, deny via Chromium; optional `{ origin }` | Runtime permission names such as `android.permission.CAMERA` | Simulator privacy services such as `location`                      |
| `setOrientation("portrait" \| "landscape")`     | Swaps the viewport dimensions                                  | UiAutomator2 or Appium                                       | WDA or Appium                                                      |
| `setBiometricEnrollment(enabled)`               | —                                                              | Enroll a test fingerprint in Android settings first          | Simulator                                                          |
| `simulateBiometric(options)`                    | —                                                              | Emulator; `{ type: "fingerprint", fingerId: 1 }`             | Simulator; `{ type: "faceId", match: false }` or `type: "touchId"` |
| `sendPushNotification(payload)`                 | —                                                              | —                                                            | Simulator; pass an APNs payload with an `aps` object               |

```ts
await app.setBiometricEnrollment(true);
await app.simulateBiometric({ type: "faceId", match: true });
await app.sendPushNotification({ aps: { alert: "Order shipped" }, orderId: "123" });
```

Guard calls by platform and target type. Appium support depends on the provider and driver version. Device changes can persist in reused devices or browser contexts; restore state explicitly where needed. Android system notifications posted by the shell do not deliver FCM messages to an app, so Android push simulation is not exposed.

## Common patterns

### System UI on mobile

Out-of-process OS UI (permission dialogs, share sheets, in-app browser tabs) is not part of the app's DOM. Mark those selectors with `systemUI` so spana goes straight to the native driver:

```ts
import { flow, systemUI } from "spana-test";

export default flow("allow notifications", { platforms: ["android", "ios"] }, async ({ app }) => {
  await app.tap({ testID: "enable-notifications" });
  await app.tap(systemUI({ text: "Allow" }));
});
```

### Platform-specific selectors

Some elements have the same semantic purpose but different identifiers across platforms. Assign the selector based on platform:

```ts
export default flow("open menu", async ({ app, platform }) => {
  const menuSelector =
    platform === "ios" ? { accessibilityLabel: "Main menu" } : { testID: "menu-button" };

  await app.tap(menuSelector);
});
```

### Skip web for native-only features

```ts
export default flow(
  "biometric authentication",
  { platforms: ["ios", "android"] },
  async ({ app, expect }) => {
    await app.tap({ testID: "use-biometrics" });
    await expect({ testID: "biometric-success" }).toBeVisible({ timeout: 10000 });
  },
);
```

### Deep link only on mobile

```ts
export default flow("deep link navigation", async ({ app, expect, platform }) => {
  if (platform !== "web") {
    await app.openLink("myapp://profile/settings");
  } else {
    await app.tap({ testID: "settings-nav" });
  }
  await expect({ testID: "settings-screen" }).toBeVisible();
});
```
