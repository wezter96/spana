import { Effect } from "effect";
import { DriverError } from "../errors.js";
import type {
  RawDriverService,
  LaunchOptions,
  BrowserMockResponse,
  BrowserNetworkConditions,
  BrowserRouteMatcher,
} from "../drivers/raw-driver.js";
import type { Platform, Selector, ExtendedSelector } from "../schemas/selector.js";
import type { Element } from "../schemas/element.js";
import { makePlaywrightDriver } from "../drivers/playwright.js";
import { createUiAutomator2Driver } from "../drivers/uiautomator2/driver.js";
import { createWDADriver } from "../drivers/wda/driver.js";
import { parseWebHierarchy } from "../drivers/playwright-parser.js";
import { parseAndroidHierarchy } from "../drivers/uiautomator2/pagesource.js";
import { parseIOSHierarchy } from "../drivers/wda/pagesource.js";
import { flattenElements, findElementExtended, centerOf } from "../smart/element-matcher.js";
import { setupUiAutomator2 } from "../drivers/uiautomator2/installer.js";
import { setupWDA } from "../drivers/wda/installer.js";
import { allocatePort } from "../core/port-allocator.js";
import { firstAndroidDevice } from "../device/android.js";
import { firstIOSSimulatorWithApp, bootSimulator } from "../device/ios.js";
import { findDeviceById } from "../device/discover.js";
import type { BrowserName } from "../schemas/config.js";

export type Direction = "up" | "down" | "left" | "right";

export interface ConnectOptions {
  platform: Platform;
  device?: string; // device ID override
  baseUrl?: string; // for web
  packageName?: string; // for android
  bundleId?: string; // for ios
  headless?: boolean; // for web (default true)
  browser?: BrowserName; // for web (default chromium)
  storageState?: string; // for web
}

export interface SuggestedSelector {
  suggestedSelector: Selector;
  elementType?: string;
  text?: string;
  accessibilityLabel?: string;
  bounds: { x: number; y: number; width: number; height: number };
  id?: string;
}

export class Session {
  private driver: RawDriverService;
  private appId: string;
  readonly platform: Platform;
  private parse: (raw: string) => Element;
  private cleanups: (() => void)[];

  constructor(
    driver: RawDriverService,
    platform: Platform,
    parse: (raw: string) => Element,
    appId = "",
    cleanups: (() => void)[] = [],
  ) {
    this.driver = driver;
    this.platform = platform;
    this.parse = parse;
    this.appId = appId;
    this.cleanups = cleanups;
  }

  // ---------------------------------------------------------------------------
  // Hierarchy & selectors
  // ---------------------------------------------------------------------------

  async hierarchy(): Promise<Element> {
    const raw = await Effect.runPromise(this.driver.dumpHierarchy());
    return this.parse(raw);
  }

  async selectors(): Promise<SuggestedSelector[]> {
    const root = await this.hierarchy();
    const all = flattenElements(root);

    return all
      .filter((el) => el.visible !== false && (el.id || el.text || el.accessibilityLabel))
      .map((el) => {
        let suggestedSelector: Selector;
        if (el.id) {
          suggestedSelector = { testID: el.id };
        } else if (el.accessibilityLabel) {
          suggestedSelector = { accessibilityLabel: el.accessibilityLabel };
        } else if (el.text) {
          suggestedSelector = { text: el.text };
        } else {
          suggestedSelector = el.text ?? "";
        }

        return {
          suggestedSelector,
          elementType: el.elementType,
          text: el.text,
          accessibilityLabel: el.accessibilityLabel,
          bounds: el.bounds,
          id: el.id,
        };
      });
  }

  // ---------------------------------------------------------------------------
  // Touch actions
  // ---------------------------------------------------------------------------

  async tap(selector: ExtendedSelector): Promise<void> {
    const root = await this.hierarchy();
    const el = findElementExtended(root, selector);
    if (!el) throw new Error(`Element not found: ${JSON.stringify(selector)}`);
    const { x, y } = centerOf(el);
    await Effect.runPromise(this.driver.tapAtCoordinate(x, y));
  }

  async tapXY(x: number, y: number): Promise<void> {
    await Effect.runPromise(this.driver.tapAtCoordinate(x, y));
  }

  async doubleTap(selector: ExtendedSelector): Promise<void> {
    const root = await this.hierarchy();
    const el = findElementExtended(root, selector);
    if (!el) throw new Error(`Element not found: ${JSON.stringify(selector)}`);
    const { x, y } = centerOf(el);
    await Effect.runPromise(this.driver.doubleTapAtCoordinate(x, y));
  }

  async longPress(selector: ExtendedSelector, opts?: { duration?: number }): Promise<void> {
    const root = await this.hierarchy();
    const el = findElementExtended(root, selector);
    if (!el) throw new Error(`Element not found: ${JSON.stringify(selector)}`);
    const { x, y } = centerOf(el);
    await Effect.runPromise(this.driver.longPressAtCoordinate(x, y, opts?.duration ?? 1000));
  }

  async longPressXY(x: number, y: number, opts?: { duration?: number }): Promise<void> {
    await Effect.runPromise(this.driver.longPressAtCoordinate(x, y, opts?.duration ?? 1000));
  }

  // ---------------------------------------------------------------------------
  // Gestures
  // ---------------------------------------------------------------------------

  async swipe(direction: Direction, opts?: { duration?: number }): Promise<void> {
    const info = await Effect.runPromise(this.driver.getDeviceInfo());
    const cx = info.screenWidth / 2;
    const cy = info.screenHeight / 2;
    const dist = Math.min(info.screenWidth, info.screenHeight) * 0.3;
    const dur = opts?.duration ?? 300;

    const vectors: Record<Direction, [number, number, number, number]> = {
      up: [cx, cy + dist, cx, cy - dist],
      down: [cx, cy - dist, cx, cy + dist],
      left: [cx + dist, cy, cx - dist, cy],
      right: [cx - dist, cy, cx + dist, cy],
    };
    const [sx, sy, ex, ey] = vectors[direction];
    await Effect.runPromise(this.driver.swipe(sx, sy, ex, ey, dur));
  }

  async scroll(direction: Direction): Promise<void> {
    await this.swipe(direction, { duration: 500 });
  }

  // ---------------------------------------------------------------------------
  // Text input
  // ---------------------------------------------------------------------------

  async inputText(text: string): Promise<void> {
    await Effect.runPromise(this.driver.inputText(text));
  }

  async pressKey(key: string): Promise<void> {
    await Effect.runPromise(this.driver.pressKey(key));
  }

  async hideKeyboard(): Promise<void> {
    await Effect.runPromise(this.driver.hideKeyboard());
  }

  // ---------------------------------------------------------------------------
  // App lifecycle
  // ---------------------------------------------------------------------------

  async launch(opts?: LaunchOptions): Promise<void> {
    await Effect.runPromise(this.driver.launchApp(this.appId, opts));
  }

  async stop(): Promise<void> {
    await Effect.runPromise(this.driver.stopApp(this.appId));
  }

  async kill(): Promise<void> {
    await Effect.runPromise(this.driver.killApp(this.appId));
  }

  async clearState(): Promise<void> {
    await Effect.runPromise(this.driver.clearAppState(this.appId));
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  async openLink(url: string): Promise<void> {
    await Effect.runPromise(this.driver.openLink(url));
  }

  async back(): Promise<void> {
    await Effect.runPromise(this.driver.back());
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async screenshot(): Promise<Uint8Array> {
    return Effect.runPromise(this.driver.takeScreenshot());
  }

  async evaluate<T = unknown>(fn: ((...args: any[]) => T) | string, ...args: any[]): Promise<T> {
    return Effect.runPromise(this.driver.evaluate(fn as any, ...args)) as Promise<T>;
  }

  async mockNetwork(matcher: BrowserRouteMatcher, response: BrowserMockResponse): Promise<void> {
    const effect =
      this.driver.mockNetwork?.(matcher, response) ??
      Effect.fail(
        new DriverError({ message: "mockNetwork() is only supported on the web platform" }),
      );
    await Effect.runPromise(effect);
  }

  async blockNetwork(matcher: BrowserRouteMatcher): Promise<void> {
    const effect =
      this.driver.blockNetwork?.(matcher) ??
      Effect.fail(
        new DriverError({ message: "blockNetwork() is only supported on the web platform" }),
      );
    await Effect.runPromise(effect);
  }

  async clearNetworkMocks(): Promise<void> {
    const effect =
      this.driver.clearNetworkMocks?.() ??
      Effect.fail(
        new DriverError({ message: "clearNetworkMocks() is only supported on the web platform" }),
      );
    await Effect.runPromise(effect);
  }

  async setNetworkConditions(conditions: BrowserNetworkConditions): Promise<void> {
    const effect =
      this.driver.setNetworkConditions?.(conditions) ??
      Effect.fail(
        new DriverError({
          message: "setNetworkConditions() is only supported on the web platform",
        }),
      );
    await Effect.runPromise(effect);
  }

  async saveCookies(path: string): Promise<void> {
    const effect =
      this.driver.saveCookies?.(path) ??
      Effect.fail(
        new DriverError({ message: "saveCookies() is only supported on the web platform" }),
      );
    await Effect.runPromise(effect);
  }

  async loadCookies(path: string): Promise<void> {
    const effect =
      this.driver.loadCookies?.(path) ??
      Effect.fail(
        new DriverError({ message: "loadCookies() is only supported on the web platform" }),
      );
    await Effect.runPromise(effect);
  }

  async saveAuthState(path: string): Promise<void> {
    const effect =
      this.driver.saveAuthState?.(path) ??
      Effect.fail(
        new DriverError({ message: "saveAuthState() is only supported on the web platform" }),
      );
    await Effect.runPromise(effect);
  }

  async loadAuthState(path: string): Promise<void> {
    const effect =
      this.driver.loadAuthState?.(path) ??
      Effect.fail(
        new DriverError({ message: "loadAuthState() is only supported on the web platform" }),
      );
    await Effect.runPromise(effect);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async disconnect(): Promise<void> {
    try {
      await Effect.runPromise(this.driver.killApp(""));
    } catch {
      // ignore
    }
    for (const cleanup of this.cleanups) {
      try {
        cleanup();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Connect to a device and create a persistent session */
export async function connect(opts: ConnectOptions): Promise<Session> {
  if (opts.platform === "web") {
    const baseUrl = opts.baseUrl ?? "http://localhost:3000";
    const driver = await Effect.runPromise(
      makePlaywrightDriver({
        browser: opts.browser,
        headless: opts.headless ?? true,
        baseUrl,
        storageState: opts.storageState,
      }),
    );
    await Effect.runPromise(driver.launchApp(baseUrl));
    return new Session(driver, "web", parseWebHierarchy, baseUrl);
  }

  if (opts.platform === "android") {
    const device = opts.device
      ? (() => {
          const found = findDeviceById(opts.device!);
          if (!found || found.platform !== "android")
            throw new Error(`Android device not found: ${opts.device}`);
          return {
            serial: found.id,
            state: "device" as const,
            type: found.type as "emulator" | "device",
          };
        })()
      : firstAndroidDevice();
    if (!device) throw new Error("No Android device connected");
    const hostPort = allocatePort(8200);
    const conn = await setupUiAutomator2(device.serial, hostPort);
    const packageName = opts.packageName ?? "";
    const driver = await Effect.runPromise(
      createUiAutomator2Driver(conn.host, conn.port, device.serial, packageName),
    );
    return new Session(driver, "android", parseAndroidHierarchy, packageName, [conn.cleanup]);
  }

  if (opts.platform === "ios") {
    const bundleId = opts.bundleId ?? "";
    const sim = opts.device
      ? (() => {
          const found = findDeviceById(opts.device!);
          if (!found || found.platform !== "ios")
            throw new Error(`iOS device not found: ${opts.device}`);
          return {
            udid: found.id,
            name: found.name,
            state: found.state as "Booted" | "Shutdown",
            runtime: "",
            isAvailable: true,
          };
        })()
      : firstIOSSimulatorWithApp(bundleId);
    if (!sim) throw new Error("No iOS simulator available");
    if (sim.state !== "Booted") bootSimulator(sim.udid);
    const wdaPort = allocatePort(8100);
    const conn = await setupWDA(sim.udid, wdaPort);
    const driver = await Effect.runPromise(
      createWDADriver(conn.host, conn.port, bundleId, sim.udid),
    );
    return new Session(driver, "ios", parseIOSHierarchy, bundleId, [conn.cleanup]);
  }

  throw new Error(`Unsupported platform: ${opts.platform}`);
}
