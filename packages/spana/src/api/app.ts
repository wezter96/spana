import { Effect } from "effect";
import { DriverError } from "../errors.js";
import type {
  RawDriverService,
  LaunchOptions,
  BrowserMockResponse,
  BrowserNetworkConditions,
  BrowserRouteMatcher,
  BrowserHAR,
  BrowserConsoleLog,
  BrowserJSError,
  TouchSequence,
} from "../drivers/raw-driver.js";
import type { ExtendedSelector, Selector } from "../schemas/selector.js";
import {
  createCoordinator,
  type BackUntilVisibleOptions,
  type DismissKeyboardOptions,
  type Direction,
  type CoordinatorConfig,
  type ScrollUntilVisibleOptions,
} from "../smart/coordinator.js";
import { waitForElement, type WaitOptions } from "../smart/auto-wait.js";
import type { StepRecorder } from "../core/step-recorder.js";

export type {
  BackUntilVisibleOptions,
  DismissKeyboardOptions,
  ScrollUntilVisibleOptions,
} from "../smart/coordinator.js";
export type { BrowserConsoleLog, BrowserHAR, BrowserJSError } from "../drivers/raw-driver.js";

export interface PromiseApp {
  tap(selector: ExtendedSelector, opts?: WaitOptions): Promise<void>;
  tapXY(x: number, y: number): Promise<void>;
  doubleTap(selector: ExtendedSelector, opts?: WaitOptions): Promise<void>;
  longPress(selector: ExtendedSelector, opts?: { duration?: number } & WaitOptions): Promise<void>;
  longPressXY(x: number, y: number, opts?: { duration?: number }): Promise<void>;
  inputText(text: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  hideKeyboard(): Promise<void>;
  dismissKeyboard(opts?: DismissKeyboardOptions): Promise<void>;
  swipe(direction: Direction, opts?: { duration?: number }): Promise<void>;
  scroll(direction: Direction): Promise<void>;
  scrollUntilVisible(selector: ExtendedSelector, opts?: ScrollUntilVisibleOptions): Promise<void>;
  backUntilVisible(selector: ExtendedSelector, opts?: BackUntilVisibleOptions): Promise<void>;
  launch(opts?: LaunchOptions): Promise<void>;
  stop(): Promise<void>;
  kill(): Promise<void>;
  clearState(): Promise<void>;
  openLink(url: string): Promise<void>;
  back(): Promise<void>;
  takeScreenshot(name?: string): Promise<Uint8Array>;
  evaluate<T = unknown>(fn: ((...args: any[]) => T) | string, ...args: any[]): Promise<T>;
  mockNetwork(matcher: BrowserRouteMatcher, response: BrowserMockResponse): Promise<void>;
  blockNetwork(matcher: BrowserRouteMatcher): Promise<void>;
  clearNetworkMocks(): Promise<void>;
  setNetworkConditions(conditions: BrowserNetworkConditions): Promise<void>;
  saveCookies(path: string): Promise<void>;
  loadCookies(path: string): Promise<void>;
  saveAuthState(path: string): Promise<void>;
  loadAuthState(path: string): Promise<void>;
  downloadFile(path: string): Promise<void>;
  uploadFile(selector: Selector, path: string): Promise<void>;
  newTab(url?: string): Promise<string>;
  switchToTab(index: number): Promise<void>;
  closeTab(): Promise<void>;
  getTabIds(): Promise<string[]>;
  getConsoleLogs(): Promise<BrowserConsoleLog[]>;
  getJSErrors(): Promise<BrowserJSError[]>;
  getHAR(): Promise<BrowserHAR>;

  pinch(
    selector: ExtendedSelector,
    opts?: { scale?: number; duration?: number } & WaitOptions,
  ): Promise<void>;
  zoom(
    selector: ExtendedSelector,
    opts?: { scale?: number; duration?: number } & WaitOptions,
  ): Promise<void>;
  multiTouch(sequences: TouchSequence[]): Promise<void>;

  getText(selector: ExtendedSelector, opts?: WaitOptions): Promise<string>;
  getAttribute(
    selector: ExtendedSelector,
    name: string,
    opts?: WaitOptions,
  ): Promise<string | undefined>;
  isVisible(selector: ExtendedSelector, opts?: { timeout?: number }): Promise<boolean>;
  isEnabled(selector: ExtendedSelector, opts?: WaitOptions): Promise<boolean>;

  // WebView / hybrid context switching
  /** List available contexts (e.g. ["NATIVE_APP", "WEBVIEW_com.example.app"]). */
  getContexts(): Promise<string[]>;
  /** Get the current context ID. */
  getCurrentContext(): Promise<string>;
  /** Switch to a specific context by ID. */
  switchToContext(contextId: string): Promise<void>;
  /** Switch to the first available WebView context. */
  switchToWebView(): Promise<void>;
  /** Switch back to the native app context. */
  switchToNativeApp(): Promise<void>;
}

const describeMatcher = (matcher: BrowserRouteMatcher) =>
  typeof matcher === "string" ? matcher : matcher.toString();

export function createPromiseApp(
  driver: RawDriverService,
  appId: string,
  config: CoordinatorConfig,
  recorder?: StepRecorder,
): PromiseApp {
  const coord = createCoordinator(driver, config);

  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  const unsupportedWebFeature = (feature: string) =>
    Effect.fail(new DriverError({ message: `${feature}() is only supported on the web platform` }));

  const runStep = <A>(
    command: string,
    action: () => Promise<A>,
    opts?: { selector?: unknown; captureScreenshot?: boolean },
  ) => (recorder ? recorder.runStep(command, action, opts) : action());

  const runScreenshotStep = (
    command: string,
    action: () => Promise<Uint8Array>,
    opts?: { selector?: unknown; name?: string },
  ) => (recorder ? recorder.runScreenshotStep(command, action, opts) : action());

  return {
    tap: (selector, opts) =>
      runStep("tap", () => run(coord.tap(selector, opts)), { selector, captureScreenshot: true }),
    tapXY: (x, y) =>
      runStep("tapXY", () => run(coord.tapXY(x, y)), {
        selector: { point: { x, y } },
        captureScreenshot: true,
      }),
    doubleTap: (selector, opts) =>
      runStep("doubleTap", () => run(coord.doubleTap(selector, opts)), {
        selector,
        captureScreenshot: true,
      }),
    longPress: (selector, opts) =>
      runStep("longPress", () => run(coord.longPress(selector, opts?.duration, opts)), {
        selector,
        captureScreenshot: true,
      }),
    longPressXY: (x, y, opts) =>
      runStep("longPressXY", () => run(coord.longPressXY(x, y, opts?.duration)), {
        selector: { point: { x, y } },
        captureScreenshot: true,
      }),
    inputText: (text) =>
      runStep("inputText", () => run(coord.inputText(text)), { captureScreenshot: true }),
    pressKey: (key) =>
      runStep(`pressKey(${key})`, () => run(coord.pressKey(key)), { captureScreenshot: true }),
    hideKeyboard: () =>
      runStep("hideKeyboard", () => run(coord.hideKeyboard()), { captureScreenshot: true }),
    dismissKeyboard: (opts) =>
      runStep(
        `dismissKeyboard(${opts?.strategy ?? "auto"})`,
        () => run(coord.dismissKeyboard(opts)),
        {
          selector: { strategy: opts?.strategy ?? "auto" },
          captureScreenshot: true,
        },
      ),
    swipe: (direction, opts) =>
      runStep(`swipe(${direction})`, () => run(coord.swipe(direction, opts)), {
        captureScreenshot: true,
      }),
    scroll: (direction) =>
      runStep(`scroll(${direction})`, () => run(coord.scroll(direction)), {
        captureScreenshot: true,
      }),
    scrollUntilVisible: (selector, opts) =>
      runStep(
        `scrollUntilVisible(${opts?.direction ?? "down"})`,
        () => run(coord.scrollUntilVisible(selector, opts)),
        {
          selector: {
            target: selector,
            ...opts,
            direction: opts?.direction ?? "down",
            maxScrolls: opts?.maxScrolls ?? 5,
          },
          captureScreenshot: true,
        },
      ),
    backUntilVisible: (selector, opts) =>
      runStep(
        `backUntilVisible(${opts?.maxBacks ?? 3})`,
        () => run(coord.backUntilVisible(selector, opts)),
        {
          selector: {
            target: selector,
            ...opts,
            maxBacks: opts?.maxBacks ?? 3,
          },
          captureScreenshot: true,
        },
      ),
    launch: (opts) =>
      runStep("launch", () => run(driver.launchApp(appId, opts)), {
        selector: opts,
        captureScreenshot: true,
      }),
    stop: () => runStep("stop", () => run(driver.stopApp(appId)), { captureScreenshot: true }),
    kill: () => runStep("kill", () => run(driver.killApp(appId)), { captureScreenshot: true }),
    clearState: () =>
      runStep("clearState", () => run(driver.clearAppState(appId)), { captureScreenshot: true }),
    openLink: (url) =>
      runStep("openLink", () => run(driver.openLink(url)), {
        selector: { url },
        captureScreenshot: true,
      }),
    back: () => runStep("back", () => run(driver.back()), { captureScreenshot: true }),
    takeScreenshot: (name) =>
      runScreenshotStep(
        name ? `takeScreenshot(${name})` : "takeScreenshot",
        () => run(driver.takeScreenshot()),
        { name },
      ),
    evaluate: <T = unknown>(fn: ((...args: any[]) => T) | string, ...args: any[]) =>
      runStep("evaluate", () => run(driver.evaluate(fn as any, ...args)) as Promise<T>),
    mockNetwork: (matcher, response) =>
      runStep(
        "mockNetwork",
        () =>
          run(
            (driver.mockNetwork ?? ((..._args) => unsupportedWebFeature("mockNetwork")))(
              matcher,
              response,
            ),
          ),
        {
          selector: { matcher: describeMatcher(matcher), response },
        },
      ),
    blockNetwork: (matcher) =>
      runStep(
        "blockNetwork",
        () =>
          run(
            (driver.blockNetwork ?? ((_matcher) => unsupportedWebFeature("blockNetwork")))(matcher),
          ),
        {
          selector: { matcher: describeMatcher(matcher) },
        },
      ),
    clearNetworkMocks: () =>
      runStep("clearNetworkMocks", () =>
        run((driver.clearNetworkMocks ?? (() => unsupportedWebFeature("clearNetworkMocks")))()),
      ),
    setNetworkConditions: (conditions) =>
      runStep(
        "setNetworkConditions",
        () =>
          run(
            (
              driver.setNetworkConditions ??
              ((_conditions) => unsupportedWebFeature("setNetworkConditions"))
            )(conditions),
          ),
        { selector: conditions },
      ),
    saveCookies: (path) =>
      runStep(
        "saveCookies",
        () => run((driver.saveCookies ?? ((_path) => unsupportedWebFeature("saveCookies")))(path)),
        { selector: { path } },
      ),
    loadCookies: (path) =>
      runStep(
        "loadCookies",
        () => run((driver.loadCookies ?? ((_path) => unsupportedWebFeature("loadCookies")))(path)),
        { selector: { path } },
      ),
    saveAuthState: (path) =>
      runStep(
        "saveAuthState",
        () =>
          run((driver.saveAuthState ?? ((_path) => unsupportedWebFeature("saveAuthState")))(path)),
        { selector: { path } },
      ),
    loadAuthState: (path) =>
      runStep(
        "loadAuthState",
        () =>
          run((driver.loadAuthState ?? ((_path) => unsupportedWebFeature("loadAuthState")))(path)),
        { selector: { path } },
      ),
    downloadFile: (path) =>
      runStep(
        "downloadFile",
        () =>
          run((driver.downloadFile ?? ((_path) => unsupportedWebFeature("downloadFile")))(path)),
        { selector: { path } },
      ),
    uploadFile: (selector, path) =>
      runStep(
        "uploadFile",
        () =>
          run(
            (driver.uploadFile ?? ((_selector, _path) => unsupportedWebFeature("uploadFile")))(
              selector,
              path,
            ),
          ),
        {
          selector: { target: selector, path },
          captureScreenshot: true,
        },
      ),
    newTab: (url) =>
      runStep(
        "newTab",
        () => run((driver.newTab ?? ((_url) => unsupportedWebFeature("newTab")))(url)),
        {
          selector: url ? { url } : undefined,
          captureScreenshot: true,
        },
      ),
    switchToTab: (index) =>
      runStep(
        `switchToTab(${index})`,
        () =>
          run((driver.switchToTab ?? ((_index) => unsupportedWebFeature("switchToTab")))(index)),
        {
          selector: { index },
          captureScreenshot: true,
        },
      ),
    closeTab: () =>
      runStep(
        "closeTab",
        () => run((driver.closeTab ?? (() => unsupportedWebFeature("closeTab")))()),
        {
          captureScreenshot: true,
        },
      ),
    getTabIds: () =>
      runStep("getTabIds", () =>
        run((driver.getTabIds ?? (() => unsupportedWebFeature("getTabIds")))()),
      ),
    getConsoleLogs: () =>
      runStep("getConsoleLogs", () =>
        run((driver.getConsoleLogs ?? (() => unsupportedWebFeature("getConsoleLogs")))()),
      ),
    getJSErrors: () =>
      runStep("getJSErrors", () =>
        run((driver.getJSErrors ?? (() => unsupportedWebFeature("getJSErrors")))()),
      ),
    getHAR: () =>
      runStep("getHAR", () => run((driver.getHAR ?? (() => unsupportedWebFeature("getHAR")))())),

    pinch: (selector, opts) =>
      runStep("pinch", () => run(coord.pinch(selector, opts)), {
        selector,
        captureScreenshot: true,
      }),
    zoom: (selector, opts) =>
      runStep("zoom", () => run(coord.zoom(selector, opts)), {
        selector,
        captureScreenshot: true,
      }),
    multiTouch: (sequences) =>
      runStep("multiTouch", () => run(coord.multiTouch(sequences)), { captureScreenshot: true }),

    getText: (selector, opts) =>
      runStep("getText", () => run(coord.getText(selector, opts)), { selector }),
    getAttribute: (selector, name, opts) =>
      runStep(`getAttribute(${name})`, () => run(coord.getAttribute(selector, name, opts)), {
        selector,
      }),
    isVisible: (selector, opts) => {
      const timeout = opts?.timeout ?? 1000;
      return run(
        Effect.gen(function* () {
          const result = yield* Effect.either(
            waitForElement(
              driver,
              selector,
              config.parse,
              { timeout, pollInterval: 100 },
              undefined,
            ),
          );
          return result._tag === "Right";
        }),
      );
    },
    isEnabled: (selector, opts) =>
      runStep("isEnabled", () => run(coord.isElementEnabled(selector, opts)), { selector }),

    // WebView / hybrid context switching
    getContexts: () =>
      runStep("getContexts", () =>
        run((driver.getContexts ?? (() => Effect.succeed(["NATIVE_APP"] as string[])))()),
      ),

    getCurrentContext: () =>
      runStep("getCurrentContext", () =>
        run((driver.getCurrentContext ?? (() => Effect.succeed("NATIVE_APP")))()),
      ),

    switchToContext: (contextId) =>
      runStep(`switchToContext(${contextId})`, () =>
        run((driver.setContext ?? ((_id) => Effect.void))(contextId)),
      ),

    switchToWebView: () =>
      runStep("switchToWebView", async () => {
        const contexts = await run(
          (driver.getContexts ?? (() => Effect.succeed(["NATIVE_APP"] as string[])))(),
        );
        const webview = contexts.find((c) => c.startsWith("WEBVIEW_"));
        if (!webview) {
          throw new DriverError({
            message: `No WebView context found. Available contexts: ${contexts.join(", ")}`,
          });
        }
        await run((driver.setContext ?? ((_id) => Effect.void))(webview));
      }),

    switchToNativeApp: () =>
      runStep("switchToNativeApp", () =>
        run((driver.setContext ?? ((_id) => Effect.void))("NATIVE_APP")),
      ),
  };
}
