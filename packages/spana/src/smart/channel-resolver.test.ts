import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { parseIOSHierarchy } from "../drivers/wda/pagesource.js";
import { parseAndroidHierarchy } from "../drivers/uiautomator2/pagesource.js";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { DomChannel, DomElementMatch } from "../channels/dom-channel.js";
import { systemUI } from "../schemas/selector.js";
import {
  domRectToScreenBounds,
  findWebViewFrame,
  resolveElementAcrossChannels,
} from "./channel-resolver.js";
import { createCoordinator } from "./coordinator.js";
import { analyzeStepQuality } from "../report/selector-guardrails.js";

/**
 * Recorded iOS WDA XML fixture: Capacitor WKWebView login form.
 * Notice `data-testid="sign-in"` does NOT appear anywhere in the native XML;
 * only `XCUIElementTypeWebView` frame (x=0, y=59, width=390, height=751) and
 * localized button copy appear natively.
 */
const IOS_WKWEBVIEW_LOGIN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Acme" label="Acme" enabled="true" visible="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeWindow type="XCUIElementTypeWindow" enabled="true" visible="true" x="0" y="0" width="390" height="844">
      <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" x="0" y="0" width="390" height="844">
        <XCUIElementTypeWebView type="XCUIElementTypeWebView" enabled="true" visible="true" x="0" y="59" width="390" height="751">
          <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" x="0" y="59" width="390" height="751">
            <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="Logga in" label="Logga in" enabled="true" visible="true" x="24" y="140" width="200" height="32" />
            <XCUIElementTypeButton type="XCUIElementTypeButton" label="Logga in med SSO" enabled="true" visible="true" x="24" y="359" width="342" height="48" />
          </XCUIElementTypeOther>
        </XCUIElementTypeWebView>
      </XCUIElementTypeOther>
    </XCUIElementTypeWindow>
  </XCUIElementTypeApplication>
</AppiumAUT>`;

/**
 * Recorded iOS WDA XML fixture: out-of-process SFSafariViewController OAuth sheet.
 * No DOM channel can inspect this sheet; only WDA's accessibility tree sees it.
 */
const IOS_SF_SAFARI_OAUTH_SHEET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Acme" label="Acme" enabled="true" visible="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeWindow type="XCUIElementTypeWindow" enabled="true" visible="true" x="0" y="0" width="390" height="844">
      <XCUIElementTypeOther type="XCUIElementTypeOther" name="SFBrowserView" enabled="true" visible="true" x="0" y="54" width="390" height="790">
        <XCUIElementTypeNavigationBar type="XCUIElementTypeNavigationBar" name="TopBrowserBar" enabled="true" visible="true" x="0" y="54" width="390" height="50">
          <XCUIElementTypeButton type="XCUIElementTypeButton" name="Done" label="Done" enabled="true" visible="true" x="12" y="60" width="54" height="38" />
        </XCUIElementTypeNavigationBar>
        <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" x="0" y="104" width="390" height="740">
          <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" value="Authorize Acme?" label="Authorize Acme?" enabled="true" visible="true" x="40" y="240" width="310" height="36" />
          <XCUIElementTypeButton type="XCUIElementTypeButton" value="Continue" label="Continue" enabled="true" visible="true" x="40" y="520" width="310" height="48" />
        </XCUIElementTypeOther>
      </XCUIElementTypeOther>
    </XCUIElementTypeWindow>
  </XCUIElementTypeApplication>
</AppiumAUT>`;

/**
 * Recorded Android UiAutomator2 XML fixture: Capacitor android.webkit.WebView
 * on a 1080×2400 screen (viewportWidth=393, DPR=2.75, status bar=84px).
 */
const ANDROID_CAPACITOR_WEBVIEW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <android.widget.FrameLayout bounds="[0,0][1080,2400]" enabled="true">
    <android.webkit.WebView class="android.webkit.WebView" bounds="[0,84][1080,2268]" enabled="true" clickable="false">
      <android.view.View text="Sign in" bounds="[66,909][1014,1041]" enabled="true" clickable="true" />
    </android.webkit.WebView>
  </android.widget.FrameLayout>
</hierarchy>`;

function createStubDomChannel(
  matchesByTestId: Record<string, DomElementMatch[]>,
  opts: { connected?: boolean; onTapDom?: (sel: unknown) => void } = {},
): DomChannel & { queryCount: number; tapDomCount: number; idleCount: number } {
  let connected = opts.connected ?? true;
  const ch = {
    kind: "bridge" as const,
    queryCount: 0,
    tapDomCount: 0,
    idleCount: 0,
    isConnected: () => connected,
    connect: async () => {
      connected = true;
    },
    disconnect: async () => {
      connected = false;
    },
    evaluate: async () => undefined as any,
    query: async (selector: any) => {
      ch.queryCount += 1;
      if (typeof selector === "object" && selector && "testID" in selector) {
        return matchesByTestId[selector.testID] ?? [];
      }
      return [];
    },
    tapDom: async (selector: any) => {
      ch.tapDomCount += 1;
      opts.onTapDom?.(selector);
      return true;
    },
    waitForIdle: async () => {
      ch.idleCount += 1;
    },
  };
  return ch;
}

function createFakeDriver(
  hierarchyRef: { xml: string },
  domChannel?: DomChannel,
): { driver: RawDriverService; taps: Array<{ x: number; y: number }>; dumps: number } {
  const state = {
    taps: [] as Array<{ x: number; y: number }>,
    dumps: 0,
  };

  const driver: RawDriverService = {
    domChannel,
    dumpHierarchy: () =>
      Effect.sync(() => {
        state.dumps += 1;
        return hierarchyRef.xml;
      }),
    tapAtCoordinate: (x, y) =>
      Effect.sync(() => {
        state.taps.push({ x, y });
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
        platform: "ios",
        deviceId: "sim-1",
        name: "iPhone 16",
        isEmulator: true,
        screenWidth: 390,
        screenHeight: 844,
        driverType: "wda",
      }),
    launchApp: () => Effect.void,
    stopApp: () => Effect.void,
    killApp: () => Effect.void,
    clearAppState: () => Effect.void,
    openLink: () => Effect.void,
    back: () => Effect.void,
    evaluate: () => Effect.void as any,
  };

  return {
    driver,
    taps: state.taps,
    get dumps() {
      return state.dumps;
    },
  };
}

describe("Channel-hiding resolver & coordinate conversion", () => {
  test("finds XCUIElementTypeWebView and android.webkit.WebView frames accurately", () => {
    const iosRoot = parseIOSHierarchy(IOS_WKWEBVIEW_LOGIN_XML);
    expect(findWebViewFrame(iosRoot)).toEqual({ x: 0, y: 59, width: 390, height: 751 });

    const androidRoot = parseAndroidHierarchy(ANDROID_CAPACITOR_WEBVIEW_XML);
    expect(findWebViewFrame(androidRoot)).toEqual({ x: 0, y: 84, width: 1080, height: 2184 });
  });

  test("converts DOM rect to iOS logical points and Android physical pixels", () => {
    const iosMatch: DomElementMatch = {
      id: "sign-in",
      rect: { x: 24, y: 300, width: 342, height: 48 },
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 3,
      viewportWidth: 390,
      viewportHeight: 751,
      visible: true,
      enabled: true,
      clickable: true,
    };
    const iosBounds = domRectToScreenBounds(
      iosMatch,
      { x: 0, y: 59, width: 390, height: 751 },
      { platform: "ios" },
    );
    // y = 59 (safe area / webview frame) + 300 * (390/390) = 359
    expect(iosBounds).toEqual({ x: 24, y: 359, width: 342, height: 48 });

    const androidMatch: DomElementMatch = {
      id: "sign-in",
      rect: { x: 24, y: 300, width: 345, height: 48 },
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 2.75,
      viewportWidth: 393,
      viewportHeight: 794,
      visible: true,
      enabled: true,
      clickable: true,
    };
    const androidBounds = domRectToScreenBounds(
      androidMatch,
      { x: 0, y: 84, width: 1080, height: 2184 },
      { platform: "android" },
    );
    // scale = 1080 / 393 ≈ 2.748 -> x ≈ 66, y ≈ 84 + 824 = 908, width ≈ 948, height ≈ 132
    expect(androidBounds.x).toBe(66);
    expect(androidBounds.y).toBe(908);
    expect(androidBounds.width).toBe(948);
    expect(androidBounds.height).toBe(132);
  });

  test("iOS OAuth journey: DOM finds testID -> native WDA taps converted point -> native tree taps SFSafariViewController Continue", async () => {
    const screen = { xml: IOS_WKWEBVIEW_LOGIN_XML };
    const domChannel = createStubDomChannel({
      "sign-in": [
        {
          id: "sign-in",
          tag: "button",
          text: "Logga in med SSO",
          rect: { x: 24, y: 300, width: 342, height: 48 },
          scrollX: 0,
          scrollY: 0,
          devicePixelRatio: 3,
          viewportWidth: 390,
          viewportHeight: 751,
          visible: true,
          enabled: true,
          clickable: true,
        },
      ],
      "profile-id": [
        {
          id: "profile-id",
          tag: "span",
          text: "user_42",
          rect: { x: 16, y: 80, width: 120, height: 24 },
          scrollX: 0,
          scrollY: 0,
          devicePixelRatio: 3,
          viewportWidth: 390,
          viewportHeight: 751,
          visible: true,
          enabled: true,
          clickable: false,
        },
      ],
    });

    const fake = createFakeDriver(screen, domChannel);
    const coord = createCoordinator(fake.driver, {
      parse: parseIOSHierarchy,
      platform: "ios",
      defaults: { timeout: 500, pollInterval: 20, initialPollInterval: 10 },
    });

    // Step 1: tap({ testID: "sign-in" }) — found via DOM, tapped natively at center (24+171=195, 59+300+24=383)
    await Effect.runPromise(coord.tap({ testID: "sign-in" }));
    expect(fake.taps[0]).toEqual({ x: 195, y: 383 });
    expect(domChannel.tapDomCount).toBe(0);

    // Step 2: SFSafariViewController opens — tap(systemUI({ text: "Continue" }))
    screen.xml = IOS_SF_SAFARI_OAUTH_SHEET_XML;
    const domQueriesBeforeSystemTap = domChannel.queryCount;
    await Effect.runPromise(coord.tap(systemUI({ text: "Continue" })));
    // systemUI skips DOM channel completely and taps native button center (40+155=195, 520+24=544)
    expect(domChannel.queryCount).toBe(domQueriesBeforeSystemTap);
    expect(fake.taps[1]).toEqual({ x: 195, y: 544 });

    // Step 3: Back in WKWebView — assertVisible({ testID: "profile-id" }) hits DOM only (0 native dumps!)
    screen.xml = IOS_WKWEBVIEW_LOGIN_XML;
    const dumpsBeforeAssert = fake.dumps;
    const profileEl = await Effect.runPromise(coord.assertVisible({ testID: "profile-id" }));
    expect(profileEl.id).toBe("profile-id");
    expect(profileEl.text).toBe("user_42");
    expect(fake.dumps).toBe(dumpsBeforeAssert);
  });

  test("tapMode: 'dom' dispatches DOM tap directly with zero native hierarchy dumps", async () => {
    const screen = { xml: IOS_WKWEBVIEW_LOGIN_XML };
    const domChannel = createStubDomChannel({
      "sign-in": [
        {
          id: "sign-in",
          tag: "button",
          rect: { x: 24, y: 300, width: 342, height: 48 },
          scrollX: 0,
          scrollY: 0,
          devicePixelRatio: 3,
          viewportWidth: 390,
          viewportHeight: 751,
          visible: true,
          enabled: true,
          clickable: true,
        },
      ],
    });
    const fake = createFakeDriver(screen, domChannel);
    const coord = createCoordinator(fake.driver, {
      parse: parseIOSHierarchy,
      platform: "ios",
    });

    await Effect.runPromise(coord.tap({ testID: "sign-in" }, { tapMode: "dom" }));
    expect(domChannel.tapDomCount).toBe(1);
    expect(fake.taps).toHaveLength(0);
    expect(fake.dumps).toBe(0);
  });

  test("non-systemUI text selector falls back seamlessly from DOM to native SFSafariViewController", async () => {
    const screen = { xml: IOS_SF_SAFARI_OAUTH_SHEET_XML };
    const domChannel = createStubDomChannel({});
    const fake = createFakeDriver(screen, domChannel);

    const resolved = await Effect.runPromise(
      resolveElementAcrossChannels(
        fake.driver,
        { text: "Continue" },
        parseIOSHierarchy,
        undefined,
        {
          forAction: true,
          platform: "ios",
        },
      ),
    );

    expect(resolved?.channel).toBe("native");
    expect(resolved?.element.accessibilityLabel).toBe("Continue");
  });

  test("selector guardrails allow systemUI-labeled selectors without text-heavy warnings", () => {
    const warnings = analyzeStepQuality([
      { command: "tap", selector: { testID: "sign-in" }, status: "passed", durationMs: 10 },
      {
        command: "tap",
        selector: systemUI({ text: "Continue" }),
        status: "passed",
        durationMs: 20,
      },
      {
        command: "tap",
        selector: systemUI({ accessibilityLabel: "Allow" }),
        status: "passed",
        durationMs: 20,
      },
    ]);
    expect(warnings.filter((w) => w.rule === "text-heavy")).toHaveLength(0);
  });

  test("auto-scrolls offscreen DOM elements into viewport before converting coordinates for native tap", async () => {
    const screen = { xml: IOS_WKWEBVIEW_LOGIN_XML };
    let scrollCalls = 0;

    const offscreenMatch: DomElementMatch = {
      id: "footer-submit",
      tag: "button",
      text: "Submit",
      rect: { x: 24, y: 1450, width: 342, height: 48 },
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 3,
      viewportWidth: 390,
      viewportHeight: 751,
      visible: true,
      enabled: true,
      clickable: true,
    };

    const scrolledMatch: DomElementMatch = {
      ...offscreenMatch,
      rect: { x: 24, y: 340, width: 342, height: 48 },
      scrollY: 1110,
    };

    const domChannel: DomChannel = {
      ...createStubDomChannel({ "footer-submit": [offscreenMatch] }),
      scrollIntoView: async () => {
        scrollCalls += 1;
        return scrolledMatch;
      },
    };

    const fake = createFakeDriver(screen, domChannel);
    const coord = createCoordinator(fake.driver, {
      parse: parseIOSHierarchy,
      platform: "ios",
    });

    await Effect.runPromise(coord.tap({ testID: "footer-submit" }));
    expect(scrollCalls).toBe(1);
    expect(fake.taps[0]).toEqual({ x: 195, y: 423 });
  });
});
