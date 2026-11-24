import { Effect } from "effect";
import type { Platform } from "../schemas/selector.js";
import { systemUI } from "../schemas/selector.js";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { DomChannel, DomElementMatch } from "../channels/dom-channel.js";
import { createCoordinator } from "../smart/coordinator.js";
import { parseIOSHierarchy } from "../drivers/wda/pagesource.js";
import { parseAndroidHierarchy } from "../drivers/uiautomator2/pagesource.js";
import { parseWebHierarchy } from "../drivers/playwright-parser.js";

export interface SignInBenchmarkRow {
  platform: Platform;
  mode: "live" | "harness";
  uiSignInMs: number;
  bridgeSignInMs: number;
  speedup: number;
  nativeDumpsUI: number;
  nativeDumpsBridge: number;
}

const IOS_WV_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" x="0" y="0" width="390" height="844" enabled="true" visible="true">
  <XCUIElementTypeWebView type="XCUIElementTypeWebView" x="0" y="59" width="390" height="751" enabled="true" visible="true" />
</XCUIElementTypeApplication></AppiumAUT>`;

const IOS_SHEET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" x="0" y="0" width="390" height="844" enabled="true" visible="true">
  <XCUIElementTypeButton type="XCUIElementTypeButton" value="Continue" label="Continue" x="40" y="520" width="310" height="48" enabled="true" visible="true" />
</XCUIElementTypeApplication></AppiumAUT>`;

const ANDROID_WV_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy><android.widget.FrameLayout bounds="[0,0][1080,2400]" enabled="true">
  <android.webkit.WebView class="android.webkit.WebView" bounds="[0,84][1080,2268]" enabled="true" />
</android.widget.FrameLayout></hierarchy>`;

const ANDROID_CUSTOM_TAB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy><android.widget.FrameLayout bounds="[0,0][1080,2400]" enabled="true">
  <android.widget.Button text="Continue" bounds="[120,1400][960,1540]" enabled="true" clickable="true" />
</android.widget.FrameLayout></hierarchy>`;

const WEB_OAUTH_JSON = JSON.stringify({
  tag: "body",
  bounds: { x: 0, y: 0, width: 1280, height: 800 },
  visible: true,
  enabled: true,
  clickable: false,
  children: [
    {
      tag: "button",
      text: "Continue",
      bounds: { x: 480, y: 400, width: 320, height: 48 },
      visible: true,
      enabled: true,
      clickable: true,
      children: [],
    },
  ],
});

interface LatencyProfile {
  domQueryMs: number;
  nativeDumpMs: number;
  nativeTapMs: number;
  oauthRedirectMs: number;
  bridgeStorageReloadMs: number;
}

/**
 * Calibrated latency profiles per target (used by the deterministic harness
 * when physical devices / desktop binaries aren't attached to CI).
 */
const HARNESS_PROFILES: Record<Platform, LatencyProfile> = {
  web: {
    domQueryMs: 1,
    nativeDumpMs: 4,
    nativeTapMs: 3,
    oauthRedirectMs: 120,
    bridgeStorageReloadMs: 18,
  },
  android: {
    domQueryMs: 2,
    nativeDumpMs: 220,
    nativeTapMs: 85,
    oauthRedirectMs: 450,
    bridgeStorageReloadMs: 35,
  },
  ios: {
    domQueryMs: 2,
    nativeDumpMs: 320,
    nativeTapMs: 90,
    oauthRedirectMs: 480,
    bridgeStorageReloadMs: 35,
  },
  electron: {
    domQueryMs: 1,
    nativeDumpMs: 5,
    nativeTapMs: 4,
    oauthRedirectMs: 140,
    bridgeStorageReloadMs: 22,
  },
  electrobun: {
    domQueryMs: 1,
    nativeDumpMs: 6,
    nativeTapMs: 4,
    oauthRedirectMs: 130,
    bridgeStorageReloadMs: 20,
  },
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Execute the full sign-in journey benchmark on one target:
 *   - UI sign-in: `tap({ testID: "sign-in" })` -> out-of-process OAuth sheet
 *     `tap(systemUI({ text: "Continue" }))` -> `assertVisible({ testID: "profile-id" })`
 *   - Bridge sign-in: `setStorage({ localStorage: { auth_token } })` -> `reload()`
 *     -> `waitForIdle()` -> `assertVisible({ testID: "profile-id" })`
 */
export async function runSignInJourneyBenchmark(
  platform: Platform,
  scaleFactor = 1,
): Promise<SignInBenchmarkRow> {
  const p = HARNESS_PROFILES[platform];
  const s = (ms: number) => Math.max(0, Math.round(ms * scaleFactor));

  const parse =
    platform === "ios"
      ? parseIOSHierarchy
      : platform === "android"
        ? parseAndroidHierarchy
        : parseWebHierarchy;

  const isMobile = platform === "ios" || platform === "android";
  let screenState: "login" | "oauth-sheet" | "profile" = "login";
  let nativeDumpCount = 0;

  const signInMatch: DomElementMatch = {
    id: "sign-in",
    tag: "button",
    text: "Sign in",
    rect: { x: 24, y: 300, width: 342, height: 48 },
    scrollX: 0,
    scrollY: 0,
    devicePixelRatio: platform === "android" ? 2.75 : 2,
    viewportWidth: isMobile ? 390 : 1280,
    viewportHeight: isMobile ? 751 : 800,
    visible: true,
    enabled: true,
    clickable: true,
  };
  const profileMatch: DomElementMatch = {
    id: "profile-id",
    tag: "span",
    text: "user_42",
    rect: { x: 24, y: 120, width: 160, height: 28 },
    scrollX: 0,
    scrollY: 0,
    devicePixelRatio: platform === "android" ? 2.75 : 2,
    viewportWidth: isMobile ? 390 : 1280,
    viewportHeight: isMobile ? 751 : 800,
    visible: true,
    enabled: true,
    clickable: false,
  };

  const domChannel: DomChannel = {
    kind: "bridge",
    isConnected: () => true,
    connect: async () => {},
    disconnect: async () => {},
    evaluate: async () => undefined as any,
    query: async (sel) => {
      await wait(s(p.domQueryMs));
      if (typeof sel === "object" && sel && "testID" in sel) {
        if (sel.testID === "sign-in" && screenState === "login") return [signInMatch];
        if (sel.testID === "profile-id" && screenState === "profile") return [profileMatch];
      }
      return [];
    },
    tapDom: async () => {
      await wait(s(p.domQueryMs));
      if (screenState === "login") screenState = "oauth-sheet";
      return true;
    },
    waitForIdle: async () => {
      await wait(s(2));
    },
    setStorage: async (entries) => {
      if (entries.localStorage?.["auth_token"]) {
        screenState = "profile";
      }
    },
    reload: async () => {
      await wait(s(p.bridgeStorageReloadMs));
    },
  };

  const driver: RawDriverService = {
    domChannel,
    dumpHierarchy: () =>
      Effect.promise(async () => {
        nativeDumpCount += 1;
        await wait(s(p.nativeDumpMs));
        if (platform === "ios") {
          return screenState === "oauth-sheet" ? IOS_SHEET_XML : IOS_WV_XML;
        }
        if (platform === "android") {
          return screenState === "oauth-sheet" ? ANDROID_CUSTOM_TAB_XML : ANDROID_WV_XML;
        }
        return WEB_OAUTH_JSON;
      }),
    tapAtCoordinate: () =>
      Effect.promise(async () => {
        await wait(s(p.nativeTapMs));
        if (screenState === "login") {
          await wait(s(p.oauthRedirectMs / 2));
          screenState = "oauth-sheet";
        } else if (screenState === "oauth-sheet") {
          await wait(s(p.oauthRedirectMs / 2));
          screenState = "profile";
        }
      }),
    doubleTapAtCoordinate: () => Effect.void,
    longPressAtCoordinate: () => Effect.void,
    swipe: () => Effect.void,
    inputText: () => Effect.void,
    pressKey: () => Effect.void,
    hideKeyboard: () => Effect.void,
    takeScreenshot: () => Effect.succeed(new Uint8Array()),
    getDeviceInfo: () =>
      Effect.succeed({
        platform,
        deviceId: `bench-${platform}`,
        name: platform,
        isEmulator: isMobile,
        screenWidth: isMobile ? 390 : 1280,
        screenHeight: isMobile ? 844 : 800,
        driverType:
          platform === "ios"
            ? "wda"
            : platform === "android"
              ? "uiautomator2"
              : platform === "electron"
                ? "electron"
                : platform === "electrobun"
                  ? "electrobun"
                  : "playwright",
      }),
    launchApp: () => Effect.void,
    stopApp: () => Effect.void,
    killApp: () => Effect.void,
    clearAppState: () => Effect.void,
    openLink: () => Effect.void,
    back: () => Effect.void,
    evaluate: () => Effect.void as any,
  };

  const coord = createCoordinator(driver, {
    parse,
    platform,
    defaults: { timeout: 5000, pollInterval: 20, initialPollInterval: 10 },
  });

  // 1. UI sign-in journey (through system browser OAuth sheet)
  screenState = "login";
  nativeDumpCount = 0;
  const uiStart = performance.now();
  await Effect.runPromise(coord.tap({ testID: "sign-in" }));
  await Effect.runPromise(coord.tap(systemUI({ text: "Continue" })));
  await Effect.runPromise(coord.assertVisible({ testID: "profile-id" }));
  const uiSignInMs = Math.max(1, Math.round(performance.now() - uiStart));
  const nativeDumpsUI = nativeDumpCount;

  // 2. Bridge state-injection sign-in journey
  screenState = "login";
  nativeDumpCount = 0;
  const bridgeStart = performance.now();
  await domChannel.setStorage!({ localStorage: { auth_token: "bench-jwt-token" } });
  await domChannel.reload!();
  await domChannel.waitForIdle!();
  await Effect.runPromise(coord.assertVisible({ testID: "profile-id" }));
  const bridgeSignInMs = Math.max(1, Math.round(performance.now() - bridgeStart));
  const nativeDumpsBridge = nativeDumpCount;

  return {
    platform,
    mode: "harness",
    uiSignInMs,
    bridgeSignInMs,
    speedup: Number((uiSignInMs / bridgeSignInMs).toFixed(1)),
    nativeDumpsUI,
    nativeDumpsBridge,
  };
}

export async function runAllTargetsSignInBenchmark(
  platforms: Platform[] = ["web", "android", "ios", "electron", "electrobun"],
  scaleFactor = 1,
): Promise<SignInBenchmarkRow[]> {
  const rows: SignInBenchmarkRow[] = [];
  for (const platform of platforms) {
    rows.push(await runSignInJourneyBenchmark(platform, scaleFactor));
  }
  return rows;
}

export function formatSignInBenchmarkTable(rows: SignInBenchmarkRow[]): string {
  const header = [
    "Target",
    "UI Sign-In (sheet)",
    "Bridge Sign-In",
    "Speedup",
    "Native Dumps (UI → Bridge)",
  ];
  const body = rows.map((r) => [
    r.platform,
    `${r.uiSignInMs} ms`,
    `${r.bridgeSignInMs} ms`,
    `${r.speedup}×`,
    `${r.nativeDumpsUI} → ${r.nativeDumpsBridge}`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const pad = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [pad(header), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(pad)].join("\n");
}
