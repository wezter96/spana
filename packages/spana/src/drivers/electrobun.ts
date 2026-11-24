import { spawn, type ChildProcess } from "node:child_process";
import { Effect } from "effect";
import { DriverError } from "../errors.js";
import type { ElectrobunAppConfig, ElectrobunRenderer } from "../schemas/config.js";
import {
  resolveElectrobunEngine,
  type HostOS,
  type TargetChannel,
  type TargetEngine,
} from "../core/target-matrix.js";
import type { DomChannel } from "../channels/dom-channel.js";
import { CdpDomChannel, createCdpDomChannel } from "../channels/cdp-client.js";
import { createWebKitInspectorChannel } from "../channels/webkit-inspector.js";
import { createCompositeDomChannel } from "../channels/bridge-server.js";
import type { LaunchOptions, RawDriverService, RawHierarchy } from "./raw-driver.js";

export interface ElectrobunLaunchPlan {
  renderer: ElectrobunRenderer;
  engine: TargetEngine;
  hostOs: HostOS;
  preferredChannels: TargetChannel[];
  env: Record<string, string>;
  args: string[];
  cdpUrl?: string;
  webkitInspectorUrl?: string;
  notes: string;
}

/**
 * Resolve the exact Electrobun engine flags & environment variables for each
 * OS and renderer combination:
 *
 * - Bundled CEF (`renderer: "cef"`):
 *     Passes `--remote-debugging-port=<port>` + `ELECTROBUN_CDP_PORT=<port>`.
 *     In packaged builds, also configure `build.<os>.chromiumFlags["remote-debugging-port"]`
 *     in `electrobun.config.ts`.
 * - Windows native (`WebView2`):
 *     Sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=<port>"`
 *     and `ELECTROBUN_CDP_PORT=<port>`, then attaches via CDP.
 * - macOS native (`WKWebView`):
 *     Uses `spana-bridge` (preferred) or WebKit Remote Inspector (`webkitInspectorPort`).
 * - Linux native (`WebKitGTK`):
 *     Sets `WEBKIT_INSPECTOR_SERVER=127.0.0.1:<port>` and attaches via `spana-bridge`
 *     or WebKit Inspector / WebKitWebDriver.
 */
export function resolveElectrobunLaunchPlan(
  config: ElectrobunAppConfig,
  hostOs: HostOS = process.platform === "win32"
    ? "win32"
    : process.platform === "linux"
      ? "linux"
      : "darwin",
): ElectrobunLaunchPlan {
  const renderer: ElectrobunRenderer = config.renderer ?? "native";
  const { engine, channels } = resolveElectrobunEngine(renderer, hostOs);
  const env: Record<string, string> = { ...config.env };
  const args: string[] = [...(config.args ?? [])];

  const cdpPort = config.cdpPort ?? 9222;
  const inspectorPort = config.webkitInspectorPort ?? 9221;
  let cdpUrl = config.cdpUrl;
  let webkitInspectorUrl: string | undefined;
  let notes = "";

  if (engine === "cef") {
    env["ELECTROBUN_CDP_PORT"] = String(cdpPort);
    if (!args.some((a) => a.startsWith("--remote-debugging-port"))) {
      args.push(`--remote-debugging-port=${cdpPort}`);
    }
    cdpUrl = cdpUrl ?? `http://127.0.0.1:${cdpPort}`;
    notes =
      "CEF renderer: connects via CDP. Ensure build.<os>.chromiumFlags['remote-debugging-port'] is set in electrobun.config.ts for packaged builds.";
  } else if (engine === "webview2") {
    const existingWebView2Args = env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] ?? "";
    const debugFlag = `--remote-debugging-port=${cdpPort}`;
    env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = existingWebView2Args.includes(
      "--remote-debugging-port",
    )
      ? existingWebView2Args
      : `${existingWebView2Args} ${debugFlag}`.trim();
    env["ELECTROBUN_CDP_PORT"] = String(cdpPort);
    cdpUrl = cdpUrl ?? `http://127.0.0.1:${cdpPort}`;
    notes =
      "Windows WebView2 native renderer: injects WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS for CDP.";
  } else if (engine === "webkitgtk") {
    env["WEBKIT_INSPECTOR_SERVER"] = `127.0.0.1:${inspectorPort}`;
    webkitInspectorUrl = `http://127.0.0.1:${inspectorPort}`;
    notes = "Linux WebKitGTK native renderer: enables WEBKIT_INSPECTOR_SERVER (or spana-bridge).";
  } else {
    // macOS WKWebView
    webkitInspectorUrl = `http://127.0.0.1:${inspectorPort}`;
    notes =
      "macOS WKWebView native renderer: prefers spana-bridge over WebSocket, with WebKit Inspector fallback.";
  }

  return {
    renderer,
    engine,
    hostOs,
    preferredChannels: channels,
    env,
    args,
    cdpUrl,
    webkitInspectorUrl,
    notes,
  };
}

export interface ElectrobunDriverOptions extends ElectrobunAppConfig {
  /** Optional spana-bridge DOM channel (recommended for cross-OS consistency on Electrobun) */
  domChannel?: DomChannel;
  hostOs?: HostOS;
  /** Optional custom spawner for testing */
  spawnProcess?: typeof spawn;
  /** Skip spawning executable (e.g. attach-only mode) */
  attachOnly?: boolean;
}

const DOM_HIERARCHY_WALK_SCRIPT = `
  (function() {
    function walk(el) {
      if (!el) return null;
      var rect = el.getBoundingClientRect();
      var style = window.getComputedStyle(el);
      var viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      var viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      var isVisible = style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      var intersectsViewport = rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;
      return {
        tag: el.tagName.toLowerCase(),
        id: el.getAttribute("data-testid") || el.getAttribute("testID") || undefined,
        text: el.childNodes.length === 1 && el.childNodes[0] && el.childNodes[0].nodeType === 3
          ? (el.childNodes[0].textContent || "").trim() || undefined
          : undefined,
        value: (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")
          ? (el.value !== undefined ? String(el.value) : undefined)
          : undefined,
        accessibilityLabel: el.getAttribute("aria-label") || undefined,
        role: el.getAttribute("role") || undefined,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        enabled: !el.hasAttribute("disabled"),
        visible: isVisible && rect.width > 0 && rect.height > 0 && intersectsViewport,
        clickable: el.tagName === "BUTTON" || el.tagName === "A" || el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.getAttribute("role") === "button" || el.onclick !== null,
        attributes: (function() { var a = {}; for (var i = 0; i < el.attributes.length; i++) { var attr = el.attributes[i]; a[attr.name] = attr.value; } return Object.keys(a).length > 0 ? a : undefined; })(),
        children: Array.from(el.children).map(walk).filter(Boolean)
      };
    }
    return walk(document.body);
  })()
`;

export function makeElectrobunDriver(
  options: ElectrobunDriverOptions,
): Effect.Effect<RawDriverService, DriverError> {
  return Effect.gen(function* () {
    const plan = resolveElectrobunLaunchPlan(options, options.hostOs);
    let childProcess: ChildProcess | null = null;

    if (options.executablePath && !options.attachOnly && !options.cdpUrl) {
      const spawner = options.spawnProcess ?? spawn;
      childProcess = spawner(options.executablePath, plan.args, {
        cwd: options.cwd ?? options.appDir,
        env: { ...process.env, ...plan.env },
        stdio: "ignore",
        detached: true,
      });
      childProcess.unref();
    }

    const channels: DomChannel[] = [];
    if (options.domChannel) {
      channels.push(options.domChannel);
    }

    let cdpChannel: CdpDomChannel | undefined;
    if (plan.cdpUrl) {
      cdpChannel = createCdpDomChannel({ endpointUrl: plan.cdpUrl });
      channels.push(cdpChannel);
    } else if (plan.webkitInspectorUrl) {
      channels.push(createWebKitInspectorChannel({ endpointUrl: plan.webkitInspectorUrl }));
    }

    if (channels.length === 0) {
      return yield* new DriverError({
        message:
          "Electrobun target requires spana-bridge, a CDP port/URL (CEF/WebView2), or WebKit Inspector configuration.",
      });
    }

    const domChannel: DomChannel =
      channels.length === 1 ? channels[0]! : createCompositeDomChannel(channels);

    const clickViaDomPoint = async (x: number, y: number, doubleClick = false) => {
      if (cdpChannel?.isConnected()) {
        await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          clickCount: doubleClick ? 2 : 1,
        });
        await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          clickCount: doubleClick ? 2 : 1,
        });
        return;
      }
      await domChannel.evaluate(`((px, py, isDouble) => {
        var el = document.elementFromPoint(px, py);
        if (!el) return;
        var init = { bubbles: true, cancelable: true, clientX: px, clientY: py };
        el.dispatchEvent(new MouseEvent("mousedown", init));
        if (typeof el.focus === "function") el.focus();
        el.dispatchEvent(new MouseEvent("mouseup", init));
        if (typeof el.click === "function") el.click();
        if (isDouble) el.dispatchEvent(new MouseEvent("dblclick", init));
      })(${JSON.stringify(x)}, ${JSON.stringify(y)}, ${JSON.stringify(doubleClick)})`);
    };

    const service: RawDriverService = {
      domChannel,

      dumpHierarchy: () =>
        Effect.tryPromise({
          try: async (): Promise<RawHierarchy> => {
            const tree = await domChannel.evaluate(DOM_HIERARCHY_WALK_SCRIPT);
            return JSON.stringify(tree);
          },
          catch: (e) => new DriverError({ message: `Electrobun dumpHierarchy failed: ${e}` }),
        }),

      tapAtCoordinate: (x, y) =>
        Effect.tryPromise({
          try: () => clickViaDomPoint(x, y, false),
          catch: (e) => new DriverError({ message: `Electrobun tap failed at (${x}, ${y}): ${e}` }),
        }),

      doubleTapAtCoordinate: (x, y) =>
        Effect.tryPromise({
          try: () => clickViaDomPoint(x, y, true),
          catch: (e) =>
            new DriverError({ message: `Electrobun doubleTap failed at (${x}, ${y}): ${e}` }),
        }),

      longPressAtCoordinate: (x, y, duration) =>
        Effect.tryPromise({
          try: async () => {
            await domChannel.evaluate(`((px, py) => {
              var el = document.elementFromPoint(px, py);
              if (el) el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: px, clientY: py }));
            })(${JSON.stringify(x)}, ${JSON.stringify(y)})`);
            await new Promise((r) => setTimeout(r, duration));
            await domChannel.evaluate(`((px, py) => {
              var el = document.elementFromPoint(px, py);
              if (el) el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: px, clientY: py }));
            })(${JSON.stringify(x)}, ${JSON.stringify(y)})`);
          },
          catch: (e) => new DriverError({ message: `Electrobun longPress failed: ${e}` }),
        }),

      swipe: (startX, startY, endX, endY, duration) =>
        Effect.tryPromise({
          try: async () => {
            await domChannel.evaluate(
              `window.scrollBy(${JSON.stringify(startX - endX)}, ${JSON.stringify(startY - endY)})`,
            );
            await new Promise((r) => setTimeout(r, duration));
          },
          catch: (e) => new DriverError({ message: `Electrobun swipe failed: ${e}` }),
        }),

      inputText: (text) =>
        Effect.tryPromise({
          try: async () => {
            if (cdpChannel?.isConnected()) {
              await cdpChannel.sendCommand("Input.insertText", { text });
              return;
            }
            await domChannel.evaluate(`((value) => {
              var active = document.activeElement;
              if (active && "value" in active) {
                active.value = String(active.value || "") + value;
                active.dispatchEvent(new Event("input", { bubbles: true }));
                active.dispatchEvent(new Event("change", { bubbles: true }));
              }
            })(${JSON.stringify(text)})`);
          },
          catch: (e) => new DriverError({ message: `Electrobun inputText failed: ${e}` }),
        }),

      pressKey: (key) =>
        Effect.tryPromise({
          try: async () => {
            if (cdpChannel?.isConnected()) {
              await cdpChannel.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key });
              await cdpChannel.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key });
              return;
            }
            await domChannel.evaluate(`((k) => {
              var target = document.activeElement || document.body;
              target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
              target.dispatchEvent(new KeyboardEvent("keyup", { key: k, bubbles: true }));
            })(${JSON.stringify(key)})`);
          },
          catch: (e) => new DriverError({ message: `Electrobun pressKey failed: ${e}` }),
        }),

      hideKeyboard: () => Effect.void,

      takeScreenshot: () =>
        Effect.tryPromise({
          try: async () => {
            if (cdpChannel?.isConnected()) {
              const res = await cdpChannel.sendCommand<{ data?: string }>(
                "Page.captureScreenshot",
                { format: "png" },
              );
              if (res?.data) {
                return Uint8Array.from(Buffer.from(res.data, "base64"));
              }
            }
            throw new Error(
              "Screenshots on Electrobun require a CDP-capable engine (CEF or WebView2).",
            );
          },
          catch: (e) => new DriverError({ message: `Electrobun takeScreenshot failed: ${e}` }),
        }),

      getDeviceInfo: () =>
        Effect.tryPromise({
          try: async () => {
            let dims = { width: 1280, height: 800 };
            try {
              const measured = await domChannel.evaluate<{ width: number; height: number }>(
                "({ width: window.innerWidth || 1280, height: window.innerHeight || 800 })",
              );
              if (measured?.width && measured?.height) dims = measured;
            } catch {
              // fallback to defaults before DOM attaches
            }
            return {
              platform: "electrobun" as const,
              deviceId: plan.cdpUrl ?? plan.webkitInspectorUrl ?? `electrobun-${plan.engine}`,
              name: `Electrobun (${plan.engine})`,
              isEmulator: false,
              screenWidth: dims.width,
              screenHeight: dims.height,
              driverType: "electrobun" as const,
            };
          },
          catch: (e) => new DriverError({ message: `Electrobun getDeviceInfo failed: ${e}` }),
        }),

      launchApp: (appRef, opts?: LaunchOptions) =>
        Effect.tryPromise({
          try: async () => {
            await domChannel.connect();
            if (opts?.clearState) {
              if (domChannel.clearStorage) {
                await domChannel.clearStorage({
                  localStorage: true,
                  sessionStorage: true,
                  cookies: true,
                  indexedDB: true,
                });
              }
            }
            const targetUrl =
              opts?.deepLink ??
              options.url ??
              (appRef && (appRef.startsWith("http://") || appRef.startsWith("https://"))
                ? appRef
                : undefined);
            if (targetUrl) {
              await domChannel.evaluate(`window.location.href = ${JSON.stringify(targetUrl)}`);
            }
          },
          catch: (e) => new DriverError({ message: `Electrobun launchApp failed: ${e}` }),
        }),

      stopApp: () => Effect.void,

      killApp: () =>
        Effect.tryPromise({
          try: async () => {
            await domChannel.disconnect().catch(() => {});
            if (childProcess) {
              try {
                childProcess.kill();
              } catch {
                // already exited
              }
              childProcess = null;
            }
          },
          catch: (e) => new DriverError({ message: `Electrobun killApp failed: ${e}` }),
        }),

      clearAppState: () =>
        Effect.tryPromise({
          try: async () => {
            if (domChannel.clearStorage) {
              await domChannel.clearStorage({
                localStorage: true,
                sessionStorage: true,
                cookies: true,
                indexedDB: true,
              });
            } else {
              await domChannel.evaluate(`(() => {
                try { localStorage.clear(); } catch {}
                try { sessionStorage.clear(); } catch {}
              })()`);
            }
          },
          catch: (e) => new DriverError({ message: `Electrobun clearAppState failed: ${e}` }),
        }),

      resetFast: () =>
        Effect.tryPromise({
          try: async () => {
            if (domChannel.clearStorage) {
              await domChannel.clearStorage({
                localStorage: true,
                sessionStorage: true,
                cookies: true,
                indexedDB: true,
              });
            }
            if (domChannel.reload) {
              await domChannel.reload();
            } else {
              await domChannel.evaluate("window.location.reload()");
            }
          },
          catch: (e) => new DriverError({ message: `Electrobun resetFast failed: ${e}` }),
        }),

      openLink: (url) =>
        Effect.tryPromise({
          try: async () => {
            await domChannel.evaluate(`window.location.href = ${JSON.stringify(url)}`);
          },
          catch: (e) => new DriverError({ message: `Electrobun openLink failed: ${e}` }),
        }),

      back: () =>
        Effect.tryPromise({
          try: async () => {
            await domChannel.evaluate("window.history.back()");
          },
          catch: (e) => new DriverError({ message: `Electrobun back failed: ${e}` }),
        }),

      evaluate: <T = unknown>(script: string | ((...args: unknown[]) => T), ...args: unknown[]) =>
        Effect.tryPromise({
          try: () => domChannel.evaluate<T>(script, ...args),
          catch: (e) => new DriverError({ message: `Electrobun evaluate failed: ${e}` }),
        }),

      mockNetwork: (matcher, response) =>
        Effect.tryPromise({
          try: async () => {
            if (!domChannel.mockNetwork) {
              throw new Error("mockNetwork() on Electrobun requires spana-bridge");
            }
            await domChannel.mockNetwork(matcher, response);
          },
          catch: (e) => new DriverError({ message: `Electrobun mockNetwork failed: ${e}` }),
        }),

      blockNetwork: (matcher) =>
        Effect.tryPromise({
          try: async () => {
            if (!domChannel.blockNetwork) {
              throw new Error("blockNetwork() on Electrobun requires spana-bridge");
            }
            await domChannel.blockNetwork(matcher);
          },
          catch: (e) => new DriverError({ message: `Electrobun blockNetwork failed: ${e}` }),
        }),

      clearNetworkMocks: () =>
        Effect.tryPromise({
          try: async () => {
            if (domChannel.clearNetworkMocks) await domChannel.clearNetworkMocks();
          },
          catch: (e) => new DriverError({ message: `Electrobun clearNetworkMocks failed: ${e}` }),
        }),

      getConsoleLogs: () =>
        Effect.tryPromise({
          try: async () => (domChannel.getConsoleLogs ? domChannel.getConsoleLogs() : []),
          catch: (e) => new DriverError({ message: `Electrobun getConsoleLogs failed: ${e}` }),
        }),

      getJSErrors: () =>
        Effect.tryPromise({
          try: async () => (domChannel.getJSErrors ? domChannel.getJSErrors() : []),
          catch: (e) => new DriverError({ message: `Electrobun getJSErrors failed: ${e}` }),
        }),
    };

    return service;
  });
}
