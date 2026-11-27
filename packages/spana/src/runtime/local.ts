import { Effect } from "effect";
import type { Browser } from "playwright-core";
import type { BridgeConfig, ProvConfig, WebExecutionConfig } from "../schemas/config.js";
import type { Platform } from "../schemas/selector.js";
import type { EngineConfig } from "../core/engine.js";
import type { CoordinatorConfig } from "../smart/coordinator.js";
import type { DiscoveredDevice } from "../device/discover.js";
import type { RuntimeResult } from "./types.js";
import {
  launchDirectCdpBrowser,
  makeLightweightCdpDriver,
  type DirectCdpBrowserHandle,
} from "../drivers/cdp-browser.js";
import { CdpWebSocketMultiplexer } from "../channels/cdp-client.js";
import { resolveChromiumGpuArgs } from "../drivers/wasm-utils.js";
import { parseWebHierarchy } from "../drivers/playwright-parser.js";
import { updateWarmDaemonSession } from "./daemon-manager.js";
import { allocatePort } from "../core/port-allocator.js";
import type { SpanaBridgeChannel } from "../channels/bridge-server.js";
import { resolveDriverAdapter } from "../drivers/adapter-registry.js";

async function safeCleanup(...fns: Array<() => Promise<unknown>>): Promise<void> {
  for (const fn of fns) {
    try {
      await fn();
    } catch {
      /* swallow */
    }
  }
}

async function maybeStartBridge(
  appBridge?: BridgeConfig,
  globalBridge?: BridgeConfig,
): Promise<SpanaBridgeChannel | undefined> {
  const merged = appBridge ?? globalBridge;
  if (!merged) return undefined;
  const enabled = merged.enabled ?? Boolean(merged.port || merged.url);
  if (!enabled) return undefined;

  const { createSpanaBridgeChannel } = await import("../channels/bridge-server.js");
  const channel = createSpanaBridgeChannel({
    host: merged.host ?? "127.0.0.1",
    port: merged.port ?? 9333,
    connectTimeoutMs: merged.connectTimeout ?? 5000,
  });
  await channel.start();
  return channel;
}

function buildEngineConfig(
  appId: string,
  platform: Platform,
  parseFn: CoordinatorConfig["parse"],
  config: ProvConfig,
  screenSize?: { width: number; height: number },
): EngineConfig {
  return {
    appId,
    platform,
    coordinatorConfig: {
      parse: parseFn,
      defaults: {
        timeout: config.defaults?.waitTimeout,
        pollInterval: config.defaults?.pollInterval,
        settleTimeout: config.defaults?.settleTimeout,
        initialPollInterval: config.defaults?.initialPollInterval,
        tapMode: config.defaults?.tapMode,
        platform,
        failFastWhenIdle: config.defaults?.failFastWhenIdle,
        actionStableFrames: config.defaults?.actionStableFrames,
        fillVerifyMs: config.defaults?.fillVerifyMs,
      },
      waitForIdleTimeout: config.defaults?.waitForIdleTimeout,
      typingDelay: config.defaults?.typingDelay,
      hierarchyCacheTtl: config.defaults?.hierarchyCacheTtl,
      screenWidth: screenSize?.width,
      screenHeight: screenSize?.height,
      tapMode: config.defaults?.tapMode,
      platform,
    },
    autoLaunch: true,
    flowTimeout: config.defaults?.waitTimeout ? config.defaults.waitTimeout * 10 : 60_000,
    toPassTimeout: config.defaults?.toPassTimeout,
    artifactConfig: config.artifacts,
    launchOptions: config.launchOptions,
    hooks: config.hooks,
    storybook: platform === "web" ? config.execution?.web?.storybook : undefined,
    visualRegression: config.visualRegression,
    replayCache: config.replayCache,
    agent: config.agent,
  };
}

/**
 * Resolve the effective web browser engine.
 * - `"auto"`: automatically selects direct CDP (`"cdp"`, zero Playwright pipe) for Chromium
 *   when no Playwright-only features (`wsEndpoint`, `channel`, `artifacts.har`) are requested,
 *   and falls back seamlessly to `"playwright"` otherwise.
 * - Explicit `"cdp"`, `"playwright"`, or `"lightpanda"` is respected verbatim.
 */
export function resolveWebEngine(config: ProvConfig): "playwright" | "cdp" | "lightpanda" {
  const webExecution = config.execution?.web;
  const requested = webExecution?.engine;
  if (requested === "cdp" || requested === "lightpanda" || requested === "playwright") {
    return requested;
  }
  if (requested === "auto") {
    const isChromium = (webExecution?.browser ?? "chromium") === "chromium";
    const needsPlaywrightOnly = Boolean(
      webExecution?.wsEndpoint || webExecution?.channel || config.artifacts?.har,
    );
    return isChromium && !needsPlaywrightOnly ? "cdp" : "playwright";
  }
  return "playwright";
}

export interface PrelaunchedWebBrowser {
  browserPromise: Promise<Browser>;
  ownsBrowser: boolean;
  /** Populated when `execution.web.engine === "cdp"` speculatively launches direct Chromium. */
  cdpBrowserPromise?: Promise<DirectCdpBrowserHandle>;
}

/**
 * Start launching (or connecting to a warm/CDP) browser immediately
 * so browser boot overlaps with flow discovery and TypeScript imports.
 */
function resolveWebAppUrl(
  url: string | ((ctx: { workerIndex: number; parallelIndex: number }) => string) | undefined,
  workerIndex: number,
  parallelIndex: number,
): string {
  if (typeof url === "function") {
    return url({ workerIndex, parallelIndex });
  }
  return url ?? "http://localhost:3000";
}

function getWorkerOffset(): number {
  return Number.parseInt(process.env.SPANA_WORKER_INDEX_OFFSET ?? "0", 10) || 0;
}

export function speculativelyPrelaunchWebBrowser(
  config: ProvConfig,
): PrelaunchedWebBrowser | undefined {
  const webExecution = config.execution?.web;
  const engine = resolveWebEngine(config);
  if (engine === "lightpanda") {
    return undefined;
  }

  if (engine === "cdp") {
    if (webExecution?.cdpUrl) return undefined;
    const useWarm = webExecution?.warmBrowser ?? config.execution?.warmDaemons?.enabled ?? false;
    const cdpBrowserPromise = launchDirectCdpBrowser({
      executablePath: webExecution?.executablePath,
      headless: webExecution?.headless ?? true,
      chromiumSandbox: webExecution?.chromiumSandbox,
      gpu: webExecution?.gpu,
      webgpu: webExecution?.webgpu,
      extensions: webExecution?.extensions,
      args: webExecution?.args,
      launchTimeout: webExecution?.launchTimeout,
      warmBrowser: useWarm,
      warmBrowserScope: webExecution?.warmBrowserScope
        ? `${webExecution.warmBrowserScope}-w0`
        : undefined,
      daemonStateFile: config.execution?.warmDaemons?.stateFile,
    });
    cdpBrowserPromise.catch(() => {});
    return {
      browserPromise: Promise.resolve(undefined as unknown as Browser),
      ownsBrowser: !useWarm,
      cdpBrowserPromise,
    };
  }

  const useWarm =
    (webExecution?.warmBrowser ?? config.execution?.warmDaemons?.enabled ?? false) &&
    (webExecution?.browser ?? "chromium") === "chromium";
  const ownsBrowser = !useWarm && !webExecution?.cdpUrl && !webExecution?.wsEndpoint;
  const browserPromise = import("../drivers/playwright.js").then(
    ({
      connectPlaywrightOverCDP,
      connectPlaywrightOverWS,
      ensureWarmBrowserDaemon,
      launchPlaywrightBrowser,
    }) =>
      webExecution?.wsEndpoint
        ? connectPlaywrightOverWS(webExecution.wsEndpoint, webExecution.browser)
        : webExecution?.cdpUrl
          ? connectPlaywrightOverCDP(webExecution.cdpUrl)
          : useWarm
            ? ensureWarmBrowserDaemon({
                headless: webExecution?.headless ?? true,
                executablePath: webExecution?.executablePath,
                warmBrowserScope: webExecution?.warmBrowserScope,
              }).then((r) => r.browser)
            : launchPlaywrightBrowser({
                browser: webExecution?.browser,
                headless: webExecution?.headless ?? true,
                executablePath: webExecution?.executablePath,
                channel: webExecution?.channel,
                args: [
                  ...(webExecution?.gpu || webExecution?.webgpu
                    ? resolveChromiumGpuArgs({
                        headless: webExecution?.headless ?? true,
                        gpu: webExecution?.gpu,
                        webgpu: webExecution?.webgpu,
                      })
                    : []),
                  ...(webExecution?.args ?? []),
                ],
              }),
  );

  // Prevent unhandled rejection if CLI exits early before awaiting
  browserPromise.catch(() => {});
  return { browserPromise, ownsBrowser };
}

function resolveWebDeviceOptions(webExecution?: WebExecutionConfig) {
  const device = webExecution?.device;
  const vp = webExecution?.viewport ?? device?.viewport;
  const viewport = vp ? { width: vp.width, height: vp.height } : undefined;
  const deviceScaleFactor =
    webExecution?.deviceScaleFactor ??
    webExecution?.viewport?.deviceScaleFactor ??
    device?.deviceScaleFactor ??
    device?.viewport?.deviceScaleFactor;
  const isMobile =
    webExecution?.isMobile ??
    webExecution?.mobile ??
    webExecution?.viewport?.isMobile ??
    webExecution?.viewport?.mobile ??
    device?.isMobile ??
    device?.mobile ??
    device?.viewport?.isMobile ??
    device?.viewport?.mobile;
  const hasTouch =
    webExecution?.hasTouch ??
    webExecution?.viewport?.hasTouch ??
    device?.hasTouch ??
    device?.viewport?.hasTouch;
  const userAgent = webExecution?.userAgent ?? device?.userAgent;
  return {
    viewport,
    deviceScaleFactor,
    mobile: isMobile,
    isMobile,
    hasTouch,
    userAgent,
    httpCredentials: webExecution?.httpCredentials,
  };
}

export async function buildWebRuntime(
  config: ProvConfig,
  prelaunched?: PrelaunchedWebBrowser,
): Promise<RuntimeResult> {
  const workerOffset = getWorkerOffset();
  const webUrl = resolveWebAppUrl(config.apps?.web?.url, workerOffset, workerOffset);
  const webExecution = config.execution?.web;
  const bridge = await maybeStartBridge(config.apps?.web?.bridge, config.execution?.bridge);

  // Check if a custom DriverAdapter was registered for ("web", engine) (modular adapter pattern)
  const requestedEngine = webExecution?.engine;
  const customAdapter = resolveDriverAdapter("web", requestedEngine);
  if (customAdapter) {
    const handle = await customAdapter.create({
      platform: "web",
      engine: requestedEngine,
      appId: webUrl,
      config,
      domChannel: bridge,
      resolvePath: (p) => p,
    });
    const driver =
      bridge && !handle.driver.domChannel
        ? { ...handle.driver, domChannel: bridge }
        : handle.driver;
    const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());
    return {
      runtime: {
        driver,
        cleanup: () =>
          safeCleanup(
            () => handle.cleanup(),
            () => bridge?.disconnect() ?? Promise.resolve(),
          ),
        metadata: {
          platform: "web",
          mode: "local",
          adapter: customAdapter.name,
          ...handle.metadata,
        },
      },
      engineConfig: buildEngineConfig(
        webUrl,
        "web",
        handle.parseHierarchy ?? parseWebHierarchy,
        config,
        {
          width: deviceInfo.screenWidth,
          height: deviceInfo.screenHeight,
        },
      ),
    };
  }

  const prelaunchedBrowser =
    prelaunched && !prelaunched.cdpBrowserPromise ? await prelaunched.browserPromise : undefined;
  let launchedDirectCdp: DirectCdpBrowserHandle | undefined;

  let rawDriver;
  const engine = resolveWebEngine(config);
  if (engine === "cdp" || engine === "lightpanda") {
    let targetCdpUrl = webExecution?.cdpUrl;
    const useContexts = engine === "cdp";
    if (!targetCdpUrl && engine === "cdp") {
      launchedDirectCdp = prelaunched?.cdpBrowserPromise
        ? await prelaunched.cdpBrowserPromise
        : await launchDirectCdpBrowser({
            executablePath: webExecution?.executablePath,
            headless: webExecution?.headless ?? true,
            chromiumSandbox: webExecution?.chromiumSandbox,
            gpu: webExecution?.gpu,
            webgpu: webExecution?.webgpu,
            extensions: webExecution?.extensions,
            args: webExecution?.args,
            launchTimeout: webExecution?.launchTimeout,
            warmBrowser:
              webExecution?.warmBrowser ?? config.execution?.warmDaemons?.enabled ?? false,
            warmBrowserScope: webExecution?.warmBrowserScope
              ? `${webExecution.warmBrowserScope}-w0`
              : undefined,
            daemonStateFile: config.execution?.warmDaemons?.stateFile,
          });
      targetCdpUrl = launchedDirectCdp.browserWsUrl;
    }
    const effectiveLocale = webExecution?.locale ?? config.defaults?.locale;
    const webDeviceOpts = resolveWebDeviceOptions(webExecution);
    const cdpEmulation =
      webExecution?.colorScheme ||
      webExecution?.reducedMotion ||
      webExecution?.timezoneId ||
      effectiveLocale ||
      webDeviceOpts.userAgent
        ? {
            colorScheme: webExecution?.colorScheme,
            reducedMotion: webExecution?.reducedMotion,
            timezoneId: webExecution?.timezoneId,
            locale: effectiveLocale,
            userAgent: webDeviceOpts.userAgent,
          }
        : undefined;
    rawDriver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: targetCdpUrl ?? "http://127.0.0.1:9222",
        baseUrl: webUrl,
        engineLabel: engine,
        viewport: webDeviceOpts.viewport,
        deviceScaleFactor: webDeviceOpts.deviceScaleFactor,
        mobile: webDeviceOpts.mobile,
        isMobile: webDeviceOpts.isMobile,
        hasTouch: webDeviceOpts.hasTouch,
        httpCredentials: webDeviceOpts.httpCredentials,
        evaluateTimeout: webExecution?.evaluateTimeout,
        useBrowserContexts: useContexts,
        freshContextPerFlow: webExecution?.freshContextPerFlow,
        contextIsolation: webExecution?.contextIsolation,
        waitUntil: webExecution?.waitUntil,
        instantAnimations: webExecution?.instantAnimations,
        blockResources: webExecution?.blockResources,
        virtualAuthenticator: webExecution?.virtualAuthenticator,
        storageState: webExecution?.storageState,
        emulation: cdpEmulation,
        sanitizeHeadlessUserAgent: !(
          webExecution?.headless === false ||
          Boolean(webDeviceOpts.userAgent) ||
          webExecution?.args?.some((a) => /^--user-agent(?:=|$)/i.test(a))
        ),
        readyExpression: webExecution?.readyExpression,
      }),
    );
  } else {
    const { makePlaywrightDriver } = await import("../drivers/playwright.js");
    const webDeviceOpts = resolveWebDeviceOptions(webExecution);
    rawDriver = await Effect.runPromise(
      makePlaywrightDriver({
        browser: webExecution?.browser,
        headless: webExecution?.headless ?? true,
        executablePath: webExecution?.executablePath,
        channel: webExecution?.channel,
        args: webExecution?.args,
        viewport: webDeviceOpts.viewport,
        deviceScaleFactor: webDeviceOpts.deviceScaleFactor,
        mobile: webDeviceOpts.mobile,
        isMobile: webDeviceOpts.isMobile,
        hasTouch: webDeviceOpts.hasTouch,
        httpCredentials: webDeviceOpts.httpCredentials,
        userAgent: webDeviceOpts.userAgent,
        locale: webExecution?.locale ?? config.defaults?.locale,
        timezoneId: webExecution?.timezoneId,
        colorScheme: webExecution?.colorScheme,
        reducedMotion: webExecution?.reducedMotion,
        baseUrl: webUrl,
        storageState: webExecution?.storageState,
        verboseLogging: webExecution?.verboseLogging,
        recordHar: Boolean(config.artifacts?.har),
        waitUntil: webExecution?.waitUntil,
        instantAnimations: webExecution?.instantAnimations,
        blockResources: webExecution?.blockResources,
        freshContextPerFlow: webExecution?.freshContextPerFlow,
        virtualAuthenticator: webExecution?.virtualAuthenticator,
        readyExpression: webExecution?.readyExpression,
        warmBrowserScope: webExecution?.warmBrowserScope,
        sharedBrowser: prelaunchedBrowser,
        cdpEndpoint: prelaunchedBrowser ? undefined : webExecution?.cdpUrl,
        wsEndpoint: prelaunchedBrowser ? undefined : webExecution?.wsEndpoint,
        warmBrowser: prelaunchedBrowser
          ? false
          : (webExecution?.warmBrowser ?? config.execution?.warmDaemons?.enabled ?? false),
      }),
    );
  }
  const driver = bridge ? { ...rawDriver, domChannel: bridge } : rawDriver;
  const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());

  return {
    runtime: {
      driver,
      cleanup: () =>
        safeCleanup(
          () => Effect.runPromise(driver.killApp("")),
          () =>
            prelaunchedBrowser && prelaunched?.ownsBrowser
              ? prelaunchedBrowser.close()
              : Promise.resolve(),
          () => (launchedDirectCdp ? launchedDirectCdp.close() : Promise.resolve()),
          () => bridge?.disconnect() ?? Promise.resolve(),
        ),
      metadata: {
        platform: "web",
        mode: "local",
      },
    },
    engineConfig: buildEngineConfig(webUrl, "web", parseWebHierarchy, config, {
      width: deviceInfo.screenWidth,
      height: deviceInfo.screenHeight,
    }),
  };
}

/**
 * Create `workerCount` isolated web runtimes sharded across
 * `Math.ceil(workerCount / maxContextsPerBrowser)` browser processes
 * (default: 4 multiplexed contexts per browser on Direct CDP, 2 on Playwright —
 * minimizing browser launch overhead while multiplexing N workers over 1 WebSocket per browser).
 * Supports both direct CDP (`engine: "cdp"`, zero Playwright pipe) and Playwright.
 */
export async function buildWebRuntimePool(
  config: ProvConfig,
  workerCount: number,
  prelaunched?: PrelaunchedWebBrowser,
): Promise<RuntimeResult[]> {
  const webExecution = config.execution?.web;
  const engine = resolveWebEngine(config);
  if (workerCount <= 1 || engine === "lightpanda") {
    return [await buildWebRuntime(config, prelaunched)];
  }

  const workerOffset = getWorkerOffset();
  const maxPerBrowser = Math.max(
    1,
    webExecution?.maxContextsPerBrowser ?? (engine === "cdp" ? 4 : 2),
  );

  // Direct CDP multi-browser worker pool (zero Playwright Node client↔server pipe,
  // multiplexing all workers in a browser bucket over ONE shared WebSocket!)
  if (engine === "cdp") {
    const useExternalCdp = Boolean(webExecution?.cdpUrl);
    const browserCount = useExternalCdp ? 1 : Math.ceil(workerCount / maxPerBrowser);
    const handles: Array<{
      cdpUrl: string;
      handle?: DirectCdpBrowserHandle;
      mux?: CdpWebSocketMultiplexer;
      remaining: number;
    }> = [];

    if (useExternalCdp) {
      handles.push({ cdpUrl: webExecution!.cdpUrl!, remaining: workerCount });
    } else {
      const useWarm = webExecution?.warmBrowser ?? config.execution?.warmDaemons?.enabled ?? false;
      const baseScope = webExecution?.warmBrowserScope ?? "pool";
      const launched = await Promise.all(
        Array.from({ length: browserCount }, (_v, bIdx) =>
          bIdx === 0 && prelaunched?.cdpBrowserPromise
            ? prelaunched.cdpBrowserPromise
            : launchDirectCdpBrowser({
                executablePath: webExecution?.executablePath,
                headless: webExecution?.headless ?? true,
                chromiumSandbox: webExecution?.chromiumSandbox,
                gpu: webExecution?.gpu,
                webgpu: webExecution?.webgpu,
                extensions: webExecution?.extensions,
                args: webExecution?.args,
                launchTimeout: webExecution?.launchTimeout,
                warmBrowser: useWarm,
                warmBrowserScope: `${baseScope}-w${bIdx}`,
                daemonStateFile: config.execution?.warmDaemons?.stateFile,
              }),
        ),
      );
      for (const h of launched) {
        handles.push({ cdpUrl: h.browserWsUrl, handle: h, remaining: 0 });
      }
      for (let i = 0; i < workerCount; i++) {
        handles[i % handles.length]!.remaining += 1;
      }
    }

    for (const bucket of handles) {
      if (
        bucket.remaining > 1 &&
        (bucket.cdpUrl.startsWith("ws://") || bucket.cdpUrl.startsWith("wss://"))
      ) {
        bucket.mux = new CdpWebSocketMultiplexer(bucket.cdpUrl);
      }
    }

    const effectivePoolLocale = webExecution?.locale ?? config.defaults?.locale;
    const poolWebDeviceOpts = resolveWebDeviceOptions(webExecution);
    const poolEmulation =
      webExecution?.colorScheme ||
      webExecution?.reducedMotion ||
      webExecution?.timezoneId ||
      effectivePoolLocale ||
      poolWebDeviceOpts.userAgent
        ? {
            colorScheme: webExecution?.colorScheme,
            reducedMotion: webExecution?.reducedMotion,
            timezoneId: webExecution?.timezoneId,
            locale: effectivePoolLocale,
            userAgent: poolWebDeviceOpts.userAgent,
          }
        : undefined;

    const results: RuntimeResult[] = await Promise.all(
      Array.from({ length: workerCount }, async (_v, i) => {
        const bucket = handles[i % handles.length]!;
        const workerWebUrl = resolveWebAppUrl(
          config.apps?.web?.url,
          workerOffset + i,
          workerOffset + i,
        );
        const driver = await Effect.runPromise(
          makeLightweightCdpDriver({
            cdpUrl: bucket.cdpUrl,
            baseUrl: workerWebUrl,
            engineLabel: "cdp",
            viewport: poolWebDeviceOpts.viewport,
            deviceScaleFactor: poolWebDeviceOpts.deviceScaleFactor,
            mobile: poolWebDeviceOpts.mobile,
            isMobile: poolWebDeviceOpts.isMobile,
            hasTouch: poolWebDeviceOpts.hasTouch,
            httpCredentials: poolWebDeviceOpts.httpCredentials,
            evaluateTimeout: webExecution?.evaluateTimeout,
            useBrowserContexts: true,
            useInjectedRuntime: true,
            ...(bucket.mux ? { createWebSocket: () => bucket.mux!.createVirtualSocket() } : {}),
            freshContextPerFlow: webExecution?.freshContextPerFlow,
            contextIsolation: webExecution?.contextIsolation,
            waitUntil: webExecution?.waitUntil,
            instantAnimations: webExecution?.instantAnimations,
            blockResources: webExecution?.blockResources,
            virtualAuthenticator: webExecution?.virtualAuthenticator,
            storageState: webExecution?.storageState,
            emulation: poolEmulation,
            sanitizeHeadlessUserAgent: !(
              webExecution?.headless === false ||
              Boolean(poolWebDeviceOpts.userAgent) ||
              webExecution?.args?.some((a) => /^--user-agent(?:=|$)/i.test(a))
            ),
            readyExpression: webExecution?.readyExpression,
          }),
        );
        const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());
        let cleaned = false;
        return {
          runtime: {
            driver,
            cleanup: () =>
              safeCleanup(async () => {
                if (cleaned) return;
                cleaned = true;
                await Effect.runPromise(driver.killApp(""));
                bucket.remaining -= 1;
                if (bucket.remaining <= 0 && bucket.handle) {
                  await bucket.handle.close();
                }
              }),
            metadata: {
              platform: "web",
              mode: "local",
              deviceId: `cdp-context-${i + 1}`,
            },
          },
          engineConfig: buildEngineConfig(workerWebUrl, "web", parseWebHierarchy, config, {
            width: deviceInfo.screenWidth,
            height: deviceInfo.screenHeight,
          }),
        } satisfies RuntimeResult;
      }),
    );
    return results;
  }

  const {
    connectPlaywrightOverCDP,
    connectPlaywrightOverWS,
    ensureWarmBrowserDaemon,
    launchPlaywrightBrowser,
    makePlaywrightDriver,
  } = await import("../drivers/playwright.js");

  const useWarm =
    (webExecution?.warmBrowser ?? config.execution?.warmDaemons?.enabled ?? false) &&
    (webExecution?.browser ?? "chromium") === "chromium";
  const singleExternalEndpoint = Boolean(webExecution?.cdpUrl || webExecution?.wsEndpoint);
  const browserCount = singleExternalEndpoint ? 1 : Math.ceil(workerCount / maxPerBrowser);

  const launchOneBrowser = async (
    idx: number,
  ): Promise<{ browser: Browser; owns: boolean; remaining: number }> => {
    if (idx === 0 && prelaunched) {
      return {
        browser: await prelaunched.browserPromise,
        owns: prelaunched.ownsBrowser,
        remaining: 0,
      };
    }
    if (webExecution?.wsEndpoint) {
      return {
        browser: await connectPlaywrightOverWS(webExecution.wsEndpoint, webExecution.browser),
        owns: false,
        remaining: 0,
      };
    }
    if (webExecution?.cdpUrl) {
      return {
        browser: await connectPlaywrightOverCDP(webExecution.cdpUrl),
        owns: false,
        remaining: 0,
      };
    }
    if (idx === 0 && useWarm) {
      const warm = await ensureWarmBrowserDaemon({
        headless: webExecution?.headless ?? true,
        executablePath: webExecution?.executablePath,
        warmBrowserScope: webExecution?.warmBrowserScope,
      });
      return { browser: warm.browser, owns: false, remaining: 0 };
    }
    return {
      browser: await launchPlaywrightBrowser({
        browser: webExecution?.browser,
        headless: webExecution?.headless ?? true,
        executablePath: webExecution?.executablePath,
        channel: webExecution?.channel,
        args: webExecution?.args,
      }),
      owns: true,
      remaining: 0,
    };
  };

  const browserBuckets = await Promise.all(
    Array.from({ length: browserCount }, (_v, idx) => launchOneBrowser(idx)),
  );
  for (let i = 0; i < workerCount; i++) {
    browserBuckets[i % browserBuckets.length]!.remaining += 1;
  }

  const poolPwDeviceOpts = resolveWebDeviceOptions(webExecution);
  const results: RuntimeResult[] = [];
  for (let i = 0; i < workerCount; i++) {
    const bucket = browserBuckets[i % browserBuckets.length]!;
    const workerWebUrl = resolveWebAppUrl(
      config.apps?.web?.url,
      workerOffset + i,
      workerOffset + i,
    );
    const driver = await Effect.runPromise(
      makePlaywrightDriver({
        browser: webExecution?.browser,
        headless: webExecution?.headless ?? true,
        executablePath: webExecution?.executablePath,
        channel: webExecution?.channel,
        args: webExecution?.args,
        viewport: poolPwDeviceOpts.viewport,
        deviceScaleFactor: poolPwDeviceOpts.deviceScaleFactor,
        mobile: poolPwDeviceOpts.mobile,
        isMobile: poolPwDeviceOpts.isMobile,
        hasTouch: poolPwDeviceOpts.hasTouch,
        httpCredentials: poolPwDeviceOpts.httpCredentials,
        userAgent: poolPwDeviceOpts.userAgent,
        locale: webExecution?.locale ?? config.defaults?.locale,
        timezoneId: webExecution?.timezoneId,
        colorScheme: webExecution?.colorScheme,
        reducedMotion: webExecution?.reducedMotion,
        baseUrl: workerWebUrl,
        storageState: webExecution?.storageState,
        verboseLogging: webExecution?.verboseLogging,
        sharedBrowser: bucket.browser,
        recordHar: Boolean(config.artifacts?.har),
        waitUntil: webExecution?.waitUntil,
        instantAnimations: webExecution?.instantAnimations,
        blockResources: webExecution?.blockResources,
        freshContextPerFlow: webExecution?.freshContextPerFlow,
        virtualAuthenticator: webExecution?.virtualAuthenticator,
        readyExpression: webExecution?.readyExpression,
        warmBrowserScope: webExecution?.warmBrowserScope,
      }),
    );
    const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());
    let cleaned = false;

    results.push({
      runtime: {
        driver,
        cleanup: () =>
          safeCleanup(async () => {
            if (cleaned) return;
            cleaned = true;
            await Effect.runPromise(driver.killApp(""));
            bucket.remaining -= 1;
            if (bucket.remaining <= 0 && bucket.owns) {
              await bucket.browser.close();
            }
          }),
        metadata: {
          platform: "web",
          mode: "local",
          deviceId: `playwright-context-${i + 1}`,
        },
      },
      engineConfig: buildEngineConfig(workerWebUrl, "web", parseWebHierarchy, config, {
        width: deviceInfo.screenWidth,
        height: deviceInfo.screenHeight,
      }),
    });
  }

  return results;
}

export async function buildElectronRuntime(
  config: ProvConfig,
  resolveFromConfig: (p: string) => string,
): Promise<RuntimeResult> {
  const electronCfg = config.apps?.electron ?? {};
  const bridge = await maybeStartBridge(electronCfg.bridge, config.execution?.bridge);

  const customAdapter = resolveDriverAdapter("electron");
  if (customAdapter) {
    const appId = electronCfg.url ?? electronCfg.entry ?? "electron";
    const handle = await customAdapter.create({
      platform: "electron",
      appId,
      config,
      domChannel: bridge,
      resolvePath: resolveFromConfig,
    });
    const driver =
      bridge && !handle.driver.domChannel
        ? { ...handle.driver, domChannel: bridge }
        : handle.driver;
    const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());
    return {
      runtime: {
        driver,
        cleanup: () =>
          safeCleanup(
            () => handle.cleanup(),
            () => bridge?.disconnect() ?? Promise.resolve(),
          ),
        metadata: {
          platform: "electron",
          mode: "local",
          adapter: customAdapter.name,
          ...handle.metadata,
        },
      },
      engineConfig: buildEngineConfig(
        appId,
        "electron",
        handle.parseHierarchy ?? parseWebHierarchy,
        config,
        {
          width: deviceInfo.screenWidth,
          height: deviceInfo.screenHeight,
        },
      ),
    };
  }

  const { makeElectronDriver } = await import("../drivers/electron.js");
  const driver = await Effect.runPromise(
    makeElectronDriver({
      entry: electronCfg.entry ? resolveFromConfig(electronCfg.entry) : undefined,
      executablePath: electronCfg.executablePath
        ? resolveFromConfig(electronCfg.executablePath)
        : undefined,
      args: electronCfg.args,
      cwd: electronCfg.cwd ? resolveFromConfig(electronCfg.cwd) : undefined,
      env: {
        ...electronCfg.env,
        ...(bridge?.url ? { SPANA_BRIDGE: "1", SPANA_BRIDGE_URL: bridge.url } : {}),
      },
      cdpUrl: electronCfg.cdpUrl,
      cdpPort: electronCfg.cdpPort,
      url: electronCfg.url,
      domChannel: bridge,
    }),
  );
  const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());

  return {
    runtime: {
      driver,
      cleanup: () =>
        safeCleanup(
          () => Effect.runPromise(driver.killApp("")),
          () => bridge?.disconnect() ?? Promise.resolve(),
        ),
      metadata: {
        platform: "electron",
        mode: "local",
        deviceId: deviceInfo.deviceId,
      },
    },
    engineConfig: buildEngineConfig(
      electronCfg.url ?? electronCfg.entry ?? "electron",
      "electron",
      parseWebHierarchy,
      config,
      {
        width: deviceInfo.screenWidth,
        height: deviceInfo.screenHeight,
      },
    ),
  };
}

export async function buildElectrobunRuntime(
  config: ProvConfig,
  resolveFromConfig: (p: string) => string,
): Promise<RuntimeResult> {
  const electrobunCfg = config.apps?.electrobun ?? {};
  const bridge = await maybeStartBridge(electrobunCfg.bridge, config.execution?.bridge);

  const customAdapter = resolveDriverAdapter("electrobun");
  if (customAdapter) {
    const appId = electrobunCfg.url ?? electrobunCfg.executablePath ?? "electrobun";
    const handle = await customAdapter.create({
      platform: "electrobun",
      appId,
      config,
      domChannel: bridge,
      resolvePath: resolveFromConfig,
    });
    const driver =
      bridge && !handle.driver.domChannel
        ? { ...handle.driver, domChannel: bridge }
        : handle.driver;
    const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());
    return {
      runtime: {
        driver,
        cleanup: () =>
          safeCleanup(
            () => handle.cleanup(),
            () => bridge?.disconnect() ?? Promise.resolve(),
          ),
        metadata: {
          platform: "electrobun",
          mode: "local",
          adapter: customAdapter.name,
          ...handle.metadata,
        },
      },
      engineConfig: buildEngineConfig(
        appId,
        "electrobun",
        handle.parseHierarchy ?? parseWebHierarchy,
        config,
        {
          width: deviceInfo.screenWidth,
          height: deviceInfo.screenHeight,
        },
      ),
    };
  }

  const { makeElectrobunDriver } = await import("../drivers/electrobun.js");
  const driver = await Effect.runPromise(
    makeElectrobunDriver({
      executablePath: electrobunCfg.executablePath
        ? resolveFromConfig(electrobunCfg.executablePath)
        : undefined,
      appDir: electrobunCfg.appDir ? resolveFromConfig(electrobunCfg.appDir) : undefined,
      args: electrobunCfg.args,
      cwd: electrobunCfg.cwd ? resolveFromConfig(electrobunCfg.cwd) : undefined,
      env: {
        ...electrobunCfg.env,
        ...(bridge?.url ? { SPANA_BRIDGE: "1", SPANA_BRIDGE_URL: bridge.url } : {}),
      },
      renderer: electrobunCfg.renderer,
      cdpUrl: electrobunCfg.cdpUrl,
      cdpPort: electrobunCfg.cdpPort,
      webkitInspectorPort: electrobunCfg.webkitInspectorPort,
      url: electrobunCfg.url,
      domChannel: bridge,
    }),
  );
  const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());

  return {
    runtime: {
      driver,
      cleanup: () =>
        safeCleanup(
          () => Effect.runPromise(driver.killApp("")),
          () => bridge?.disconnect() ?? Promise.resolve(),
        ),
      metadata: {
        platform: "electrobun",
        mode: "local",
        deviceId: deviceInfo.deviceId,
      },
    },
    engineConfig: buildEngineConfig(
      electrobunCfg.url ?? electrobunCfg.executablePath ?? "electrobun",
      "electrobun",
      parseWebHierarchy,
      config,
      {
        width: deviceInfo.screenWidth,
        height: deviceInfo.screenHeight,
      },
    ),
  };
}

export async function buildLocalAndroidRuntime(
  config: ProvConfig,
  targetDevice: DiscoveredDevice | null,
  resolveFromConfig: (p: string) => string,
): Promise<RuntimeResult | null> {
  const [
    { createUiAutomator2Driver },
    { parseAndroidHierarchy },
    { setupUiAutomator2 },
    { adbReverse, adbReverseRemove, ensureAndroidDevice },
  ] = await Promise.all([
    import("../drivers/uiautomator2/driver.js"),
    import("../drivers/uiautomator2/pagesource.js"),
    import("../drivers/uiautomator2/installer.js"),
    import("../device/android.js"),
  ]);
  const customAdapter = resolveDriverAdapter("android");
  if (customAdapter) {
    const packageName = config.apps?.android?.packageName ?? "";
    const bridge = await maybeStartBridge(config.apps?.android?.bridge, config.execution?.bridge);
    const handle = await customAdapter.create({
      platform: "android",
      appId: packageName,
      config,
      domChannel: bridge,
      resolvePath: resolveFromConfig,
    });
    const driver =
      bridge && !handle.driver.domChannel
        ? { ...handle.driver, domChannel: bridge }
        : handle.driver;
    const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());
    return {
      runtime: {
        driver,
        cleanup: () =>
          safeCleanup(
            () => handle.cleanup(),
            () => bridge?.disconnect() ?? Promise.resolve(),
          ),
        metadata: {
          platform: "android",
          mode: "local",
          adapter: customAdapter.name,
          ...handle.metadata,
        },
      },
      engineConfig: buildEngineConfig(
        packageName,
        "android",
        handle.parseHierarchy ?? parseAndroidHierarchy,
        config,
        {
          width: deviceInfo.screenWidth,
          height: deviceInfo.screenHeight,
        },
      ),
    };
  }

  const device =
    targetDevice?.platform === "android"
      ? {
          serial: targetDevice.id,
          state: "device" as const,
          type: targetDevice.type as "emulator" | "device",
        }
      : ensureAndroidDevice();
  if (!device) {
    console.log("No Android device/emulator available. Skipping android platform.");
    return null;
  }
  const packageName = config.apps?.android?.packageName ?? "";
  const androidAppPath = config.apps?.android?.appPath;
  if (androidAppPath && packageName) {
    try {
      const { adbShell, adbInstall } = await import("../device/android.js");
      const output = adbShell(device.serial, `pm list packages ${packageName}`);
      if (!output.includes(packageName)) {
        console.log(`Installing ${packageName} on Android device...`);
        adbInstall(device.serial, resolveFromConfig(androidAppPath));
      }
    } catch {
      console.log(`Installing ${packageName} on Android device...`);
      const { adbInstall } = await import("../device/android.js");
      adbInstall(device.serial, resolveFromConfig(androidAppPath));
    }
  }
  const hostPort = allocatePort(8200);
  const warmDaemons = config.execution?.warmDaemons;
  const bridge = await maybeStartBridge(config.apps?.android?.bridge, config.execution?.bridge);

  // Automatically reverse-forward the bridge port over USB/ADB so both physical
  // Android phones and emulators can connect directly to ws://127.0.0.1:<port>.
  const reversedBridgePort = bridge?.port ?? null;
  if (reversedBridgePort !== null) {
    try {
      adbReverse(device.serial, reversedBridgePort, reversedBridgePort);
    } catch {
      // Best-effort — emulators still reach host via 10.0.2.2
    }
  }

  try {
    const conn = await setupUiAutomator2(device.serial, hostPort, {
      warm: warmDaemons?.enabled,
      daemonStateFile: warmDaemons?.stateFile,
    });
    const driver = await Effect.runPromise(
      createUiAutomator2Driver(conn.host, conn.port, device.serial, packageName, {
        domChannel: bridge,
        cdpPort: config.apps?.android?.cdpPort,
      }),
    );
    const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());

    return {
      runtime: {
        driver,
        cleanup: () =>
          safeCleanup(
            () => Effect.runPromise(driver.killApp("")),
            () => bridge?.disconnect() ?? Promise.resolve(),
            () => {
              if (reversedBridgePort !== null) {
                adbReverseRemove(device.serial, reversedBridgePort);
              }
              return Promise.resolve();
            },
            () => conn.cleanup?.() ?? Promise.resolve(),
          ),
        metadata: {
          platform: "android",
          mode: "local",
          deviceId: device.serial,
        },
      },
      engineConfig: buildEngineConfig(packageName, "android", parseAndroidHierarchy, config, {
        width: deviceInfo.screenWidth,
        height: deviceInfo.screenHeight,
      }),
    };
  } catch (e) {
    await bridge?.disconnect().catch(() => {});
    console.log(`Android setup failed on ${device.serial}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export async function buildLocalIOSRuntime(
  config: ProvConfig,
  targetDevice: DiscoveredDevice | null,
  resolveFromConfig: (p: string) => string,
): Promise<RuntimeResult | null> {
  const [
    { createWDADriver },
    { parseIOSHierarchy },
    { setupWDA },
    { ensureIOSSimulator, firstIOSPhysicalDevice, connectPhysicalDevice, ensureAppInstalled },
  ] = await Promise.all([
    import("../drivers/wda/driver.js"),
    import("../drivers/wda/pagesource.js"),
    import("../drivers/wda/installer.js"),
    import("../device/ios.js"),
  ]);
  const customAdapter = resolveDriverAdapter("ios");
  if (customAdapter) {
    const bundleId = config.apps?.ios?.bundleId ?? "";
    const bridge = await maybeStartBridge(config.apps?.ios?.bridge, config.execution?.bridge);
    const handle = await customAdapter.create({
      platform: "ios",
      appId: bundleId,
      config,
      domChannel: bridge,
      resolvePath: resolveFromConfig,
    });
    const driver =
      bridge && !handle.driver.domChannel
        ? { ...handle.driver, domChannel: bridge }
        : handle.driver;
    const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());
    return {
      runtime: {
        driver,
        cleanup: () =>
          safeCleanup(
            () => handle.cleanup(),
            () => bridge?.disconnect() ?? Promise.resolve(),
          ),
        metadata: {
          platform: "ios",
          mode: "local",
          adapter: customAdapter.name,
          ...handle.metadata,
        },
      },
      engineConfig: buildEngineConfig(
        bundleId,
        "ios",
        handle.parseHierarchy ?? parseIOSHierarchy,
        config,
        {
          width: deviceInfo.screenWidth,
          height: deviceInfo.screenHeight,
        },
      ),
    };
  }

  const bundleId = config.apps?.ios?.bundleId ?? "";
  const iosAppPath = config.apps?.ios?.appPath;
  const signing = config.apps?.ios?.signing;
  const snapshotMaxDepth = config.defaults?.snapshotMaxDepth ?? 100;
  const warmDaemons = config.execution?.warmDaemons;
  const bridge = await maybeStartBridge(config.apps?.ios?.bridge, config.execution?.bridge);

  const createIOSRuntime = async (
    deviceId: string,
    conn: { host: string; port: number; cleanup?: () => void; warmSessionId?: string },
    simulatorUdid?: string,
  ): Promise<RuntimeResult> => {
    const reuseSession = warmDaemons?.enabled && warmDaemons.reuseSession !== false;
    const driver = await Effect.runPromise(
      createWDADriver(conn.host, conn.port, bundleId, simulatorUdid, snapshotMaxDepth, {
        domChannel: bridge,
        webkitInspectorUrl: config.apps?.ios?.webkitInspectorUrl,
        webkitInspectorPort: config.apps?.ios?.webkitInspectorPort,
        autoStartInspectorProxy: true,
        warmSessionId: reuseSession ? conn.warmSessionId : undefined,
        onSessionCreated: reuseSession
          ? (sessionId) =>
              updateWarmDaemonSession("wda", deviceId, sessionId, bundleId, warmDaemons?.stateFile)
          : undefined,
      }),
    );
    const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());

    return {
      runtime: {
        driver,
        cleanup: () =>
          safeCleanup(
            () => Effect.runPromise(driver.killApp("")),
            () => bridge?.disconnect() ?? Promise.resolve(),
            () => conn.cleanup?.() ?? Promise.resolve(),
          ),
        metadata: {
          platform: "ios",
          mode: "local",
          deviceId,
        },
      },
      engineConfig: buildEngineConfig(bundleId, "ios", parseIOSHierarchy, config, {
        width: deviceInfo.screenWidth,
        height: deviceInfo.screenHeight,
      }),
    };
  };

  const connectPhysicalRuntime = async (
    physicalDevice: { udid: string; name: string },
    allowSimulatorFallback: boolean,
  ): Promise<RuntimeResult | null> => {
    let conn: { host: string; port: number; cleanup?: () => void } | undefined;

    try {
      console.log(`Found physical iOS device: ${physicalDevice.name} (${physicalDevice.udid})`);
      if (iosAppPath && bundleId) {
        ensureAppInstalled({
          udid: physicalDevice.udid,
          bundleId,
          appPath: resolveFromConfig(iosAppPath),
          isPhysicalDevice: true,
        });
      }

      if (signing?.teamId) {
        const { setupWDAForDevice } = await import("../drivers/wda/installer.js");
        const wdaPort = allocatePort(8100);
        conn = await setupWDAForDevice(
          physicalDevice.udid,
          wdaPort,
          signing.teamId,
          signing.signingIdentity,
          { warm: warmDaemons?.enabled, daemonStateFile: warmDaemons?.stateFile },
        );
      } else {
        conn = connectPhysicalDevice(physicalDevice.udid);
      }

      return await createIOSRuntime(physicalDevice.udid, conn);
    } catch (e) {
      if (conn?.cleanup) {
        try {
          await conn.cleanup();
        } catch (cleanupError) {
          console.warn(
            `Failed to clean up physical device tunnel: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`,
          );
        }
      }

      if (!allowSimulatorFallback) {
        await bridge?.disconnect().catch(() => {});
        console.log(
          `iOS setup failed for device ${physicalDevice.udid}: ${e instanceof Error ? e.message : e}`,
        );
        return null;
      }

      console.log(
        `Physical device setup failed (${physicalDevice.name}): ${e instanceof Error ? e.message : e}. Falling back to simulator.`,
      );
      return null;
    }
  };

  // If a specific simulator was targeted, use it directly
  if (targetDevice?.platform === "ios" && targetDevice.type === "simulator") {
    if (iosAppPath && bundleId) {
      ensureAppInstalled({
        udid: targetDevice.id,
        bundleId,
        appPath: resolveFromConfig(iosAppPath),
        isPhysicalDevice: false,
      });
    }
    const wdaPort = allocatePort(8100);
    try {
      const conn = await setupWDA(targetDevice.id, wdaPort, {
        warm: warmDaemons?.enabled,
        daemonStateFile: warmDaemons?.stateFile,
      });
      return await createIOSRuntime(targetDevice.id, conn, targetDevice.id);
    } catch (e) {
      await bridge?.disconnect().catch(() => {});
      console.log(
        `iOS setup failed for device ${targetDevice.id}: ${e instanceof Error ? e.message : e}`,
      );
      return null;
    }
  }

  if (targetDevice?.platform === "ios" && targetDevice.type === "device") {
    return connectPhysicalRuntime({ udid: targetDevice.id, name: targetDevice.name }, false);
  }

  // Try physical device first, fall back to simulator
  const physicalDevice = firstIOSPhysicalDevice();
  if (physicalDevice) {
    const runtime = await connectPhysicalRuntime(physicalDevice, true);
    if (runtime) {
      return runtime;
    }
  }

  // Fall back to simulator
  const simulator = ensureIOSSimulator(bundleId);
  if (!simulator) {
    await bridge?.disconnect().catch(() => {});
    console.log("No iOS simulator or physical device available. Skipping ios platform.");
    return null;
  }
  if (iosAppPath && bundleId) {
    ensureAppInstalled({
      udid: simulator.udid,
      bundleId,
      appPath: resolveFromConfig(iosAppPath),
      isPhysicalDevice: false,
    });
  }
  const wdaPort = allocatePort(8100);
  try {
    const conn = await setupWDA(simulator.udid, wdaPort, {
      warm: warmDaemons?.enabled,
      daemonStateFile: warmDaemons?.stateFile,
    });
    return await createIOSRuntime(simulator.udid, conn, simulator.udid);
  } catch (e) {
    await bridge?.disconnect().catch(() => {});
    console.log(`iOS setup failed on ${simulator.name}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
