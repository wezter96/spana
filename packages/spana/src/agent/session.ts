import { Effect } from "effect";
import { DriverError } from "../errors.js";
import type {
  RawDriverService,
  LaunchOptions,
  BrowserMockResponse,
  BrowserNetworkConditions,
  BrowserRouteMatcher,
  BrowserConsoleLog,
  BrowserJSError,
} from "../drivers/raw-driver.js";
import type { Platform, Selector, ExtendedSelector } from "../schemas/selector.js";
import type { Element } from "../schemas/element.js";
import { makePlaywrightDriver } from "../drivers/playwright.js";
import { makeElectronDriver } from "../drivers/electron.js";
import { makeElectrobunDriver } from "../drivers/electrobun.js";
import { createUiAutomator2Driver } from "../drivers/uiautomator2/driver.js";
import { createWDADriver } from "../drivers/wda/driver.js";
import { parseWebHierarchy } from "../drivers/playwright-parser.js";
import { parseAndroidHierarchy } from "../drivers/uiautomator2/pagesource.js";
import { parseIOSHierarchy } from "../drivers/wda/pagesource.js";
import { flattenElements } from "../smart/element-matcher.js";
import {
  createCoordinator,
  type BackUntilVisibleOptions,
  type DismissKeyboardOptions,
  type ScrollUntilVisibleOptions,
} from "../smart/coordinator.js";
import { setupUiAutomator2 } from "../drivers/uiautomator2/installer.js";
import { setupWDA } from "../drivers/wda/installer.js";
import { allocatePort } from "../core/port-allocator.js";
import { firstAndroidDevice } from "../device/android.js";
import {
  bootSimulator,
  connectPhysicalDevice,
  firstIOSPhysicalDevice,
  firstIOSSimulatorWithApp,
} from "../device/ios.js";
import { findDeviceById } from "../device/discover.js";
import type { BrowserName, StorybookConfig } from "../schemas/config.js";
import { buildStorybookUrl, type StorybookOpenOptions } from "../api/storybook.js";
import { createPromiseApp, type PromiseApp } from "../api/app.js";

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
  verboseLogging?: boolean; // for web
  storybook?: StorybookConfig; // for web
  entry?: string; // for electron
  executablePath?: string; // for electron / electrobun
  cdpUrl?: string; // for electron / electrobun
  cdpPort?: number; // for electron / electrobun
  renderer?: "native" | "cef"; // for electrobun
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
  private storybook?: StorybookConfig;
  private coordinatorPromise?: Promise<ReturnType<typeof createCoordinator>>;

  constructor(
    driver: RawDriverService,
    platform: Platform,
    parse: (raw: string) => Element,
    appId = "",
    cleanups: (() => void)[] = [],
    storybook?: StorybookConfig,
  ) {
    this.driver = driver;
    this.platform = platform;
    this.parse = parse;
    this.appId = appId;
    this.cleanups = cleanups;
    this.storybook = storybook;
  }

  private async coordinator() {
    this.coordinatorPromise ??= Effect.runPromise(this.driver.getDeviceInfo()).then((info) =>
      createCoordinator(this.driver, {
        parse: this.parse,
        screenWidth: info.screenWidth,
        screenHeight: info.screenHeight,
      }),
    );

    return this.coordinatorPromise;
  }

  private appPromise?: Promise<PromiseApp>;

  // Reuse the flow `app` implementation for queries and helpers the Session does not implement itself.
  private async app(): Promise<PromiseApp> {
    this.appPromise ??= Effect.runPromise(this.driver.getDeviceInfo()).then((info) =>
      createPromiseApp(
        this.driver,
        this.appId,
        { parse: this.parse, screenWidth: info.screenWidth, screenHeight: info.screenHeight },
        undefined,
        { platform: this.platform, storybook: this.storybook },
      ),
    );
    return this.appPromise;
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
    const coordinator = await this.coordinator();
    await Effect.runPromise(coordinator.tap(selector, { timeout: 1 }));
  }

  async tapXY(x: number, y: number): Promise<void> {
    const coordinator = await this.coordinator();
    await Effect.runPromise(coordinator.tapXY(x, y));
  }

  async doubleTap(selector: ExtendedSelector): Promise<void> {
    const coordinator = await this.coordinator();
    await Effect.runPromise(coordinator.doubleTap(selector, { timeout: 1 }));
  }

  async longPress(selector: ExtendedSelector, opts?: { duration?: number }): Promise<void> {
    const coordinator = await this.coordinator();
    await Effect.runPromise(coordinator.longPress(selector, opts?.duration, { timeout: 1 }));
  }

  async longPressXY(x: number, y: number, opts?: { duration?: number }): Promise<void> {
    const coordinator = await this.coordinator();
    await Effect.runPromise(coordinator.longPressXY(x, y, opts?.duration));
  }

  // ---------------------------------------------------------------------------
  // Gestures
  // ---------------------------------------------------------------------------

  async swipe(direction: Direction, opts?: { duration?: number }): Promise<void> {
    const coordinator = await this.coordinator();
    await Effect.runPromise(coordinator.swipe(direction, opts));
  }

  async scroll(direction: Direction): Promise<void> {
    const coordinator = await this.coordinator();
    await Effect.runPromise(coordinator.scroll(direction));
  }

  async scrollUntilVisible(
    selector: ExtendedSelector,
    opts?: ScrollUntilVisibleOptions,
  ): Promise<void> {
    const coordinator = await this.coordinator();
    await Effect.runPromise(coordinator.scrollUntilVisible(selector, opts));
  }

  async backUntilVisible(
    selector: ExtendedSelector,
    opts?: BackUntilVisibleOptions,
  ): Promise<void> {
    const coordinator = await this.coordinator();
    await Effect.runPromise(coordinator.backUntilVisible(selector, opts));
  }

  // ---------------------------------------------------------------------------
  // Text input
  // ---------------------------------------------------------------------------

  async inputText(text: string): Promise<void> {
    const coordinator = await this.coordinator();
    await Effect.runPromise(coordinator.inputText(text));
  }

  async pressKey(key: string): Promise<void> {
    const coordinator = await this.coordinator();
    await Effect.runPromise(coordinator.pressKey(key));
  }

  async hideKeyboard(): Promise<void> {
    const coordinator = await this.coordinator();
    await Effect.runPromise(coordinator.hideKeyboard());
  }

  async dismissKeyboard(opts?: DismissKeyboardOptions): Promise<void> {
    const coordinator = await this.coordinator();
    await Effect.runPromise(coordinator.dismissKeyboard(opts));
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

  async openStory(storyId: string, opts?: StorybookOpenOptions): Promise<void> {
    if (this.platform !== "web") {
      throw new DriverError({ message: "openStory() is only supported on the web platform" });
    }

    const url = buildStorybookUrl(storyId, opts, {
      appBaseUrl: this.appId,
      storybook: this.storybook,
    });
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

  async getConsoleLogs(): Promise<BrowserConsoleLog[]> {
    const effect =
      this.driver.getConsoleLogs?.() ??
      Effect.fail(
        new DriverError({ message: "getConsoleLogs() is only supported on the web platform" }),
      );
    return Effect.runPromise(effect);
  }

  async getJSErrors(): Promise<BrowserJSError[]> {
    const effect =
      this.driver.getJSErrors?.() ??
      Effect.fail(
        new DriverError({ message: "getJSErrors() is only supported on the web platform" }),
      );
    return Effect.runPromise(effect);
  }

  // ---------------------------------------------------------------------------
  // Delegated to the flow `app` API
  // ---------------------------------------------------------------------------

  async getText(...a: Parameters<PromiseApp["getText"]>) {
    return (await this.app()).getText(...a);
  }
  async getAttribute(...a: Parameters<PromiseApp["getAttribute"]>) {
    return (await this.app()).getAttribute(...a);
  }
  async isVisible(...a: Parameters<PromiseApp["isVisible"]>) {
    return (await this.app()).isVisible(...a);
  }
  async isEnabled(...a: Parameters<PromiseApp["isEnabled"]>) {
    return (await this.app()).isEnabled(...a);
  }
  async pinch(...a: Parameters<PromiseApp["pinch"]>) {
    return (await this.app()).pinch(...a);
  }
  async zoom(...a: Parameters<PromiseApp["zoom"]>) {
    return (await this.app()).zoom(...a);
  }
  async multiTouch(...a: Parameters<PromiseApp["multiTouch"]>) {
    return (await this.app()).multiTouch(...a);
  }
  async downloadFile(...a: Parameters<PromiseApp["downloadFile"]>) {
    return (await this.app()).downloadFile(...a);
  }
  async uploadFile(...a: Parameters<PromiseApp["uploadFile"]>) {
    return (await this.app()).uploadFile(...a);
  }
  async newTab(...a: Parameters<PromiseApp["newTab"]>) {
    return (await this.app()).newTab(...a);
  }
  async switchToTab(...a: Parameters<PromiseApp["switchToTab"]>) {
    return (await this.app()).switchToTab(...a);
  }
  async closeTab() {
    return (await this.app()).closeTab();
  }
  async getTabIds() {
    return (await this.app()).getTabIds();
  }
  async getHAR() {
    return (await this.app()).getHAR();
  }
  async getContexts() {
    return (await this.app()).getContexts();
  }
  async getCurrentContext() {
    return (await this.app()).getCurrentContext();
  }
  async switchToContext(...a: Parameters<PromiseApp["switchToContext"]>) {
    return (await this.app()).switchToContext(...a);
  }
  async switchToWebView() {
    return (await this.app()).switchToWebView();
  }
  async switchToNativeApp() {
    return (await this.app()).switchToNativeApp();
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
        verboseLogging: opts.verboseLogging,
      }),
    );
    await Effect.runPromise(driver.launchApp(baseUrl));
    return new Session(driver, "web", parseWebHierarchy, baseUrl, [], opts.storybook);
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
    const target = opts.device ? findDeviceById(opts.device) : null;
    if (opts.device && (!target || target.platform !== "ios")) {
      throw new Error(`iOS device not found: ${opts.device}`);
    }

    if (target?.type === "device") {
      const conn = connectPhysicalDevice(target.id);
      const driver = await Effect.runPromise(createWDADriver(conn.host, conn.port, bundleId));
      return new Session(driver, "ios", parseIOSHierarchy, bundleId, [conn.cleanup]);
    }

    const sim =
      target?.type === "simulator"
        ? {
            udid: target.id,
            name: target.name,
            state: target.state as "Booted" | "Shutdown",
            runtime: "",
            isAvailable: true,
          }
        : firstIOSSimulatorWithApp(bundleId);

    if (sim) {
      if (sim.state !== "Booted") bootSimulator(sim.udid);
      const wdaPort = allocatePort(8100);
      const conn = await setupWDA(sim.udid, wdaPort);
      const driver = await Effect.runPromise(
        createWDADriver(conn.host, conn.port, bundleId, sim.udid),
      );
      return new Session(driver, "ios", parseIOSHierarchy, bundleId, [conn.cleanup]);
    }

    const physicalDevice = firstIOSPhysicalDevice();
    if (physicalDevice) {
      const conn = connectPhysicalDevice(physicalDevice.udid);
      const driver = await Effect.runPromise(createWDADriver(conn.host, conn.port, bundleId));
      return new Session(driver, "ios", parseIOSHierarchy, bundleId, [conn.cleanup]);
    }

    throw new Error("No iOS simulator or physical device available");
  }

  if (opts.platform === "electron") {
    const driver = await Effect.runPromise(
      makeElectronDriver({
        entry: opts.entry,
        executablePath: opts.executablePath,
        cdpUrl: opts.cdpUrl,
        cdpPort: opts.cdpPort,
        url: opts.baseUrl,
      }),
    );
    return new Session(
      driver,
      "electron",
      parseWebHierarchy,
      opts.baseUrl ?? opts.entry ?? "electron",
      [],
    );
  }

  if (opts.platform === "electrobun") {
    const driver = await Effect.runPromise(
      makeElectrobunDriver({
        executablePath: opts.executablePath,
        cdpUrl: opts.cdpUrl,
        cdpPort: opts.cdpPort,
        renderer: opts.renderer,
        url: opts.baseUrl,
      }),
    );
    return new Session(driver, "electrobun", parseWebHierarchy, opts.baseUrl ?? "electrobun", []);
  }

  throw new Error(`Unsupported platform: ${opts.platform}`);
}
