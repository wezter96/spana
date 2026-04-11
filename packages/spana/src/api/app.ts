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
import { mergeLaunchOptions } from "../drivers/launch-options.js";
import type { StorybookConfig } from "../schemas/config.js";
import type { ExtendedSelector, Selector, Platform } from "../schemas/selector.js";
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
import { buildStorybookUrl, type StorybookOpenOptions } from "./storybook.js";

export type {
  BackUntilVisibleOptions,
  DismissKeyboardOptions,
  ScrollUntilVisibleOptions,
} from "../smart/coordinator.js";
export type { BrowserConsoleLog, BrowserHAR, BrowserJSError } from "../drivers/raw-driver.js";
export type { StorybookOpenOptions } from "./storybook.js";

export interface PromiseApp<T extends string = string, R extends string = string> {
  tap(selector: ExtendedSelector<T>, opts?: WaitOptions): Promise<void>;
  tapXY(x: number, y: number): Promise<void>;
  doubleTap(selector: ExtendedSelector<T>, opts?: WaitOptions): Promise<void>;
  longPress(
    selector: ExtendedSelector<T>,
    opts?: { duration?: number } & WaitOptions,
  ): Promise<void>;
  longPressXY(x: number, y: number, opts?: { duration?: number }): Promise<void>;
  inputText(text: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  hideKeyboard(): Promise<void>;
  dismissKeyboard(opts?: DismissKeyboardOptions): Promise<void>;
  swipe(direction: Direction, opts?: { duration?: number }): Promise<void>;
  scroll(direction: Direction): Promise<void>;
  scrollUntilVisible(
    selector: ExtendedSelector<T>,
    opts?: ScrollUntilVisibleOptions<T>,
  ): Promise<void>;
  backUntilVisible(selector: ExtendedSelector<T>, opts?: BackUntilVisibleOptions<T>): Promise<void>;
  launch(opts?: LaunchOptions<R>): Promise<void>;
  stop(): Promise<void>;
  kill(): Promise<void>;
  clearState(): Promise<void>;
  openLink(url: R): Promise<void>;
  openStory(storyId: string, opts?: StorybookOpenOptions): Promise<void>;
  back(): Promise<void>;
  takeScreenshot(name?: string): Promise<Uint8Array>;
  evaluate<Result = unknown>(
    fn: ((...args: any[]) => Result) | string,
    ...args: any[]
  ): Promise<Result>;
  mockNetwork(matcher: BrowserRouteMatcher, response: BrowserMockResponse): Promise<void>;
  blockNetwork(matcher: BrowserRouteMatcher): Promise<void>;
  clearNetworkMocks(): Promise<void>;
  setNetworkConditions(conditions: BrowserNetworkConditions): Promise<void>;
  saveCookies(path: string): Promise<void>;
  loadCookies(path: string): Promise<void>;
  saveAuthState(path: string): Promise<void>;
  loadAuthState(path: string): Promise<void>;
  downloadFile(path: string): Promise<void>;
  uploadFile(selector: Selector<T>, path: string): Promise<void>;
  newTab(url?: R): Promise<string>;
  switchToTab(index: number): Promise<void>;
  closeTab(): Promise<void>;
  getTabIds(): Promise<string[]>;
  getConsoleLogs(): Promise<BrowserConsoleLog[]>;
  getJSErrors(): Promise<BrowserJSError[]>;
  getHAR(): Promise<BrowserHAR>;

  pinch(
    selector: ExtendedSelector<T>,
    opts?: { scale?: number; duration?: number } & WaitOptions,
  ): Promise<void>;
  zoom(
    selector: ExtendedSelector<T>,
    opts?: { scale?: number; duration?: number } & WaitOptions,
  ): Promise<void>;
  multiTouch(sequences: TouchSequence[]): Promise<void>;

  getText(selector: ExtendedSelector<T>, opts?: WaitOptions): Promise<string>;
  getAttribute(
    selector: ExtendedSelector<T>,
    name: string,
    opts?: WaitOptions,
  ): Promise<string | undefined>;
  isVisible(selector: ExtendedSelector<T>, opts?: { timeout?: number }): Promise<boolean>;
  isEnabled(selector: ExtendedSelector<T>, opts?: WaitOptions): Promise<boolean>;

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

export interface PromiseAppOptions<R extends string = string> {
  platform?: Platform;
  storybook?: StorybookConfig;
  launchOptions?: LaunchOptions<R>;
}

const describeMatcher = (matcher: BrowserRouteMatcher) =>
  typeof matcher === "string" ? matcher : matcher.toString();

export function createPromiseApp<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  appId: string,
  config: CoordinatorConfig,
  recorder?: StepRecorder,
  options: PromiseAppOptions<R> = {},
): PromiseApp<T, R> {
  const coord = createCoordinator<T, R>(driver, config);
  const platform =
    options.platform ??
    (appId.startsWith("http://") || appId.startsWith("https://") ? "web" : undefined);

  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  const unsupportedWebFeature = (feature: string) =>
    Effect.fail(new DriverError({ message: `${feature}() is only supported on the web platform` }));

  const optionalMethod = <A extends any[], Ret>(
    name: string,
    method: ((...args: A) => Effect.Effect<Ret, DriverError>) | undefined,
  ): ((...args: A) => Effect.Effect<Ret, DriverError>) =>
    method ?? ((..._args: A) => unsupportedWebFeature(name));

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
    launch: (opts) => {
      const mergedLaunchOptions = mergeLaunchOptions(options.launchOptions, opts);
      return runStep("launch", () => run(driver.launchApp(appId, mergedLaunchOptions)), {
        selector: mergedLaunchOptions,
        captureScreenshot: true,
      });
    },
    stop: () => runStep("stop", () => run(driver.stopApp(appId)), { captureScreenshot: true }),
    kill: () => runStep("kill", () => run(driver.killApp(appId)), { captureScreenshot: true }),
    clearState: () =>
      runStep("clearState", () => run(driver.clearAppState(appId)), { captureScreenshot: true }),
    openLink: (url) =>
      runStep("openLink", () => run(driver.openLink(url)), {
        selector: { url },
        captureScreenshot: true,
      }),
    openStory: (storyId, opts) =>
      runStep(
        `openStory(${storyId})`,
        async () => {
          if (platform !== "web") {
            await run(unsupportedWebFeature("openStory"));
            return;
          }

          const url = buildStorybookUrl(storyId, opts, {
            appBaseUrl: appId,
            storybook: options.storybook,
          });
          await run(driver.openLink(url));
        },
        {
          selector: {
            storyId,
            viewMode: opts?.viewMode ?? "story",
            args: opts?.args,
            globals: opts?.globals,
            baseUrl: opts?.baseUrl,
          },
          captureScreenshot: true,
        },
      ),
    back: () => runStep("back", () => run(driver.back()), { captureScreenshot: true }),
    takeScreenshot: (name) =>
      runScreenshotStep(
        name ? `takeScreenshot(${name})` : "takeScreenshot",
        () => run(driver.takeScreenshot()),
        { name },
      ),
    evaluate: <Result = unknown>(fn: ((...args: any[]) => Result) | string, ...args: any[]) =>
      runStep("evaluate", () => run(driver.evaluate(fn as any, ...args)) as Promise<Result>),
    mockNetwork: (matcher, response) =>
      runStep(
        "mockNetwork",
        () => run(optionalMethod("mockNetwork", driver.mockNetwork)(matcher, response)),
        {
          selector: { matcher: describeMatcher(matcher), response },
        },
      ),
    blockNetwork: (matcher) =>
      runStep(
        "blockNetwork",
        () => run(optionalMethod("blockNetwork", driver.blockNetwork)(matcher)),
        {
          selector: { matcher: describeMatcher(matcher) },
        },
      ),
    clearNetworkMocks: () =>
      runStep("clearNetworkMocks", () =>
        run(optionalMethod("clearNetworkMocks", driver.clearNetworkMocks)()),
      ),
    setNetworkConditions: (conditions) =>
      runStep(
        "setNetworkConditions",
        () => run(optionalMethod("setNetworkConditions", driver.setNetworkConditions)(conditions)),
        { selector: conditions },
      ),
    saveCookies: (path) =>
      runStep("saveCookies", () => run(optionalMethod("saveCookies", driver.saveCookies)(path)), {
        selector: { path },
      }),
    loadCookies: (path) =>
      runStep("loadCookies", () => run(optionalMethod("loadCookies", driver.loadCookies)(path)), {
        selector: { path },
      }),
    saveAuthState: (path) =>
      runStep(
        "saveAuthState",
        () => run(optionalMethod("saveAuthState", driver.saveAuthState)(path)),
        { selector: { path } },
      ),
    loadAuthState: (path) =>
      runStep(
        "loadAuthState",
        () => run(optionalMethod("loadAuthState", driver.loadAuthState)(path)),
        { selector: { path } },
      ),
    downloadFile: (path) =>
      runStep(
        "downloadFile",
        () => run(optionalMethod("downloadFile", driver.downloadFile)(path)),
        { selector: { path } },
      ),
    uploadFile: (selector, path) =>
      runStep(
        "uploadFile",
        () => run(optionalMethod("uploadFile", driver.uploadFile)(selector, path)),
        {
          selector: { target: selector, path },
          captureScreenshot: true,
        },
      ),
    newTab: (url) =>
      runStep("newTab", () => run(optionalMethod("newTab", driver.newTab)(url)), {
        selector: url ? { url } : undefined,
        captureScreenshot: true,
      }),
    switchToTab: (index) =>
      runStep(
        `switchToTab(${index})`,
        () => run(optionalMethod("switchToTab", driver.switchToTab)(index)),
        {
          selector: { index },
          captureScreenshot: true,
        },
      ),
    closeTab: () =>
      runStep("closeTab", () => run(optionalMethod("closeTab", driver.closeTab)()), {
        captureScreenshot: true,
      }),
    getTabIds: () =>
      runStep("getTabIds", () => run(optionalMethod("getTabIds", driver.getTabIds)())),
    getConsoleLogs: () =>
      runStep("getConsoleLogs", () =>
        run(optionalMethod("getConsoleLogs", driver.getConsoleLogs)()),
      ),
    getJSErrors: () =>
      runStep("getJSErrors", () => run(optionalMethod("getJSErrors", driver.getJSErrors)())),
    getHAR: () => runStep("getHAR", () => run(optionalMethod("getHAR", driver.getHAR)())),

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
