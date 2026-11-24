import { Effect } from "effect";
import { DriverError } from "../errors.js";
import type { RawDriverService, RawHierarchy } from "./raw-driver.js";
import { CdpDomChannel, type WebSocketFactory } from "../channels/cdp-client.js";

export interface LightweightCdpDriverOptions {
  /**
   * HTTP CDP endpoint (e.g. `"http://127.0.0.1:9222"` for Lightpanda or Chrome `--remote-debugging-port`)
   * OR direct WebSocket debugger URL (`"ws://127.0.0.1:9222/devtools/page/..."`).
   */
  cdpUrl: string;
  /** Optional base URL used when `launchApp()` receives a relative path. */
  baseUrl?: string;
  /** Engine label reported in `getDeviceInfo()` (e.g. `"lightpanda"` or `"cdp"`). */
  engineLabel?: string;
  /** Optional viewport dimensions reported to coordinator (default: 1280×720). */
  viewport?: { width: number; height: number };
  /** Injectable fetch & WebSocket factory for tests. */
  fetchFn?: typeof fetch;
  createWebSocket?: WebSocketFactory;
}

const CDP_DUMP_HIERARCHY_SCRIPT = `(() => {
  function walk(el) {
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
    const style = window.getComputedStyle ? window.getComputedStyle(el) : { display: "block", visibility: "visible", opacity: "1" };
    const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && parseFloat(style.opacity || "1") !== 0;
    const tag = (el.tagName || "").toLowerCase();
    return {
      id: el.getAttribute?.("data-testid") || el.getAttribute?.("testID") || el.id || undefined,
      text: el.children?.length === 0 ? (el.textContent || "").trim() || undefined : undefined,
      accessibilityLabel: el.getAttribute?.("aria-label") || undefined,
      elementType: tag,
      bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      visible,
      enabled: !el.hasAttribute?.("disabled"),
      clickable: tag === "button" || tag === "a" || tag === "input" || el.getAttribute?.("role") === "button",
      children: Array.from(el.children || []).map(walk),
    };
  }
  return document.body ? JSON.stringify(walk(document.body)) : JSON.stringify({ bounds: { x: 0, y: 0, width: 0, height: 0 }, children: [] });
})()`;

/**
 * Lightweight CDP-direct browser driver for **Lightpanda**, remote CDP grids,
 * or headless Chrome `--remote-debugging-port` — zero Playwright client overhead!
 *
 * Attaches `CdpDomChannel` directly so `{ testID }` queries (including Shadow DOM
 * & same-origin `<iframe>` piercing) resolve in ~1 ms without full DOM dumps.
 */
export function makeLightweightCdpDriver(
  options: LightweightCdpDriverOptions,
): Effect.Effect<RawDriverService, DriverError> {
  return Effect.gen(function* () {
    const isWs = options.cdpUrl.startsWith("ws://") || options.cdpUrl.startsWith("wss://");
    const cdpChannel = new CdpDomChannel({
      endpointUrl: isWs
        ? options.cdpUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/devtools\/.*$/, "")
        : options.cdpUrl,
      ...(isWs ? { webSocketUrl: options.cdpUrl } : {}),
      fetchFn: options.fetchFn,
      createWebSocket: options.createWebSocket,
    });

    yield* Effect.tryPromise({
      try: () => cdpChannel.connect(),
      catch: (e) =>
        new DriverError({
          message: `Failed to connect lightweight CDP browser at ${options.cdpUrl}: ${e}`,
        }),
    });

    const width = options.viewport?.width ?? 1280;
    const height = options.viewport?.height ?? 720;
    const label = options.engineLabel ?? "cdp";

    const navigate = async (rawUrl: string) => {
      const target =
        rawUrl.startsWith("http://") || rawUrl.startsWith("https://") || rawUrl === "about:blank"
          ? rawUrl
          : options.baseUrl
            ? `${options.baseUrl.replace(/\/$/, "")}/${rawUrl.replace(/^\//, "")}`
            : rawUrl;
      await cdpChannel.sendCommand("Page.enable").catch(() => {});
      await cdpChannel.sendCommand("Page.navigate", { url: target });
    };

    const service: RawDriverService = {
      domChannel: cdpChannel,

      dumpHierarchy: () =>
        Effect.tryPromise({
          try: async () => {
            const raw = await cdpChannel.evaluate<string>(CDP_DUMP_HIERARCHY_SCRIPT);
            return (raw ?? "{}") as RawHierarchy;
          },
          catch: (e) => new DriverError({ message: `CDP dumpHierarchy failed: ${e}` }),
        }),

      tapAtCoordinate: (x, y) =>
        Effect.tryPromise({
          try: async () => {
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x,
              y,
              button: "left",
              clickCount: 1,
            });
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x,
              y,
              button: "left",
              clickCount: 1,
            });
          },
          catch: (e) => new DriverError({ message: `CDP tap failed at (${x}, ${y}): ${e}` }),
        }),

      doubleTapAtCoordinate: (x, y) =>
        Effect.tryPromise({
          try: async () => {
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x,
              y,
              button: "left",
              clickCount: 2,
            });
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x,
              y,
              button: "left",
              clickCount: 2,
            });
          },
          catch: (e) => new DriverError({ message: `CDP doubleTap failed: ${e}` }),
        }),

      longPressAtCoordinate: (x, y, duration) =>
        Effect.tryPromise({
          try: async () => {
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x,
              y,
              button: "left",
              clickCount: 1,
            });
            await new Promise((r) => setTimeout(r, duration));
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x,
              y,
              button: "left",
              clickCount: 1,
            });
          },
          catch: (e) => new DriverError({ message: `CDP longPress failed: ${e}` }),
        }),

      swipe: (startX, startY, endX, endY) =>
        Effect.tryPromise({
          try: async () => {
            const dx = startX - endX;
            const dy = startY - endY;
            await cdpChannel.evaluate(`window.scrollBy(${dx}, ${dy})`);
          },
          catch: (e) => new DriverError({ message: `CDP swipe failed: ${e}` }),
        }),

      inputText: (text) =>
        Effect.tryPromise({
          try: async () => {
            await cdpChannel.sendCommand("Input.insertText", { text });
          },
          catch: (e) => new DriverError({ message: `CDP inputText failed: ${e}` }),
        }),

      pressKey: (key) =>
        Effect.tryPromise({
          try: async () => {
            await cdpChannel.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key });
            await cdpChannel.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key });
          },
          catch: (e) => new DriverError({ message: `CDP pressKey failed: ${e}` }),
        }),

      hideKeyboard: () => Effect.void,

      takeScreenshot: () =>
        Effect.tryPromise({
          try: async () => {
            const res = (await cdpChannel.sendCommand("Page.captureScreenshot", {
              format: "png",
            })) as {
              data?: string;
            };
            return new Uint8Array(Buffer.from(res?.data ?? "", "base64"));
          },
          catch: (e) => new DriverError({ message: `CDP screenshot failed: ${e}` }),
        }),

      getDeviceInfo: () =>
        Effect.succeed({
          platform: "web" as const,
          deviceId: `${label}:${options.cdpUrl}`,
          name: `${label} (CDP-direct)`,
          isEmulator: true,
          screenWidth: width,
          screenHeight: height,
          driverType: "cdp" as any,
        }),

      launchApp: (url, opts) =>
        Effect.tryPromise({
          try: async () => {
            if (opts?.clearState) {
              await cdpChannel.evaluate(
                "try { localStorage.clear(); sessionStorage.clear(); } catch {}",
              );
            }
            await navigate(url);
          },
          catch: (e) => new DriverError({ message: `CDP launchApp failed: ${e}` }),
        }),

      stopApp: () =>
        Effect.tryPromise({
          try: () => navigate("about:blank"),
          catch: (e) => new DriverError({ message: `CDP stopApp failed: ${e}` }),
        }),

      killApp: () =>
        Effect.tryPromise({
          try: () => cdpChannel.disconnect(),
          catch: (e) => new DriverError({ message: `CDP disconnect failed: ${e}` }),
        }),

      clearAppState: () =>
        Effect.tryPromise({
          try: async () => {
            await cdpChannel.evaluate(
              "try { localStorage.clear(); sessionStorage.clear(); } catch {}",
            );
          },
          catch: (e) => new DriverError({ message: `CDP clearAppState failed: ${e}` }),
        }),

      openLink: (url) =>
        Effect.tryPromise({
          try: () => navigate(url),
          catch: (e) => new DriverError({ message: `CDP openLink failed: ${e}` }),
        }),

      back: () =>
        Effect.tryPromise({
          try: async () => {
            await cdpChannel.evaluate("window.history.back()");
          },
          catch: (e) => new DriverError({ message: `CDP back failed: ${e}` }),
        }),

      evaluate: (fn, ...args) =>
        Effect.tryPromise({
          try: async () => {
            if (typeof fn === "string") {
              return (await cdpChannel.evaluate(fn)) as any;
            }
            const serializedArgs = args.map((a) => JSON.stringify(a)).join(", ");
            return (await cdpChannel.evaluate(`(${fn.toString()})(${serializedArgs})`)) as any;
          },
          catch: (e) => new DriverError({ message: `CDP evaluate failed: ${e}` }),
        }),
    };

    return service;
  });
}
