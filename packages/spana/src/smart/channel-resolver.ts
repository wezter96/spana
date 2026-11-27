import { Effect } from "effect";
import type { Bounds, Element } from "../schemas/element.js";
import {
  isComposableDomSelector,
  isRelativeSelector,
  isSystemUISelector,
  isTestIDSelector,
  type ExtendedSelector,
  type Platform,
  type Selector,
  type TapMode,
} from "../schemas/selector.js";
import type { RawDriverService } from "../drivers/raw-driver.js";
import { DriverError } from "../errors.js";

/** Returns true if `err` is an explicit invalid CSS / unsupported selector error that must never be swallowed. */
export function isInvalidSelectorError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return msg.includes("Invalid CSS selector") || msg.includes("Unsupported selector");
}
import {
  domMatchToElement,
  type DomChannel,
  type DomElementMatch,
} from "../channels/dom-channel.js";
import {
  findActionElementExtended,
  findElementExtended,
  flattenElements,
} from "./element-matcher.js";
import type { HierarchyCache } from "./hierarchy-cache.js";

export type ResolvedChannel = "dom" | "native";

export interface ResolvedElementResult {
  element: Element;
  channel: ResolvedChannel;
  /** Raw DOM match when resolved via DOM channel */
  domMatch?: DomElementMatch;
  /** Resolved WebView frame in native coordinates (when mapped to native coords) */
  webViewFrame?: Bounds;
}

const WEBVIEW_TYPES = new Set([
  "XCUIElementTypeWebView",
  "android.webkit.WebView",
  "WebView",
  "WKWebView",
]);

const WEBVIEW_FRAME_CACHE_TTL_MS = 10_000;

interface CachedWebViewFrame {
  frame: Bounds | undefined;
  viewportWidth: number;
  viewportHeight: number;
  cachedAt: number;
}

const webViewFrameCache = new WeakMap<object, CachedWebViewFrame>();

/** Explicitly invalidate the cached WebView frame for a driver (e.g. after navigation or rotation). */
export function invalidateWebViewFrameCache(driver: RawDriverService<any, any>): void {
  webViewFrameCache.delete(driver as object);
}

/**
 * Locate the active WebView container's frame inside a parsed native
 * accessibility hierarchy (iOS `XCUIElementTypeWebView` or Android
 * `android.webkit.WebView`). Picks the largest visible WebView container so
 * tiny auxiliary/ad webviews don't win over the primary Capacitor WebView.
 */
export function findWebViewFrame(nativeRoot: Element): Bounds | undefined {
  const all = flattenElements(nativeRoot);
  const webviews = all.filter(
    (el) =>
      el.visible !== false &&
      el.bounds.width > 0 &&
      el.bounds.height > 0 &&
      ((el.elementType && WEBVIEW_TYPES.has(el.elementType)) ||
        (el.elementType?.toLowerCase().includes("webview") ?? false)),
  );

  if (webviews.length === 0) {
    return undefined;
  }

  // Prefer the largest visible WebView by area
  webviews.sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height);
  return webviews[0]!.bounds;
}

export interface CoordinateMappingOptions {
  /**
   * Override coordinate scale factor (CSS px -> native coordinate units).
   * When omitted, derived automatically from `webViewFrame.width / match.viewportWidth`,
   * falling back to `devicePixelRatio` on Android (physical pixels) and `1` on iOS (logical points).
   */
  scaleOverride?: number;
  platform?: Platform;
  /**
   * Optional explicit scroll offset adjustment if a caller provides document-relative
   * coordinates instead of viewport-relative `getBoundingClientRect()` coordinates.
   * Default: false (because `getBoundingClientRect()` is already viewport-relative).
   */
  subtractScrollOffset?: boolean;
}

/**
 * Convert a DOM element's `getBoundingClientRect()` into native screen
 * coordinates using the WebView's native frame, viewport/DPR scale, and
 * optional scroll adjustment.
 *
 * - On iOS (WDA): native coordinates are logical points (~1× CSS px).
 *   `webViewFrame.width / viewportWidth` is ~1.0, and `webViewFrame.y` adds
 *   the status bar / safe-area / native header offset.
 * - On Android (UiAutomator2): native coordinates are physical pixels
 *   (`CSS px × devicePixelRatio`). `webViewFrame.width / viewportWidth`
 *   equals `devicePixelRatio` automatically (e.g. 1080 / 393 ≈ 2.75).
 */
export function domRectToScreenBounds(
  match: DomElementMatch,
  webViewFrame?: Bounds,
  options: CoordinateMappingOptions = {},
): Bounds {
  const frameX = webViewFrame?.x ?? 0;
  const frameY = webViewFrame?.y ?? 0;

  let scale = options.scaleOverride;
  if (scale === undefined) {
    if (webViewFrame && webViewFrame.width > 0 && match.viewportWidth > 0) {
      scale = webViewFrame.width / match.viewportWidth;
    } else if (options.platform === "android") {
      scale = match.devicePixelRatio || 1;
    } else {
      scale = 1;
    }
  }

  const relX = options.subtractScrollOffset ? match.rect.x - match.scrollX : match.rect.x;
  const relY = options.subtractScrollOffset ? match.rect.y - match.scrollY : match.rect.y;

  return {
    x: Math.round(frameX + relX * scale),
    y: Math.round(frameY + relY * scale),
    width: Math.round(match.rect.width * scale),
    height: Math.round(match.rect.height * scale),
  };
}

/**
 * Returns true if the element's center lies outside the visible WebView viewport
 * so we know to auto-scroll it into view before issuing a native coordinate tap.
 */
export function isOffscreenInViewport(match: DomElementMatch): boolean {
  if (match.viewportWidth <= 0 || match.viewportHeight <= 0) return false;
  const centerX = match.rect.x + match.rect.width / 2;
  const centerY = match.rect.y + match.rect.height / 2;
  return (
    centerX < 0 || centerY < 0 || centerX > match.viewportWidth || centerY > match.viewportHeight
  );
}

/**
 * Select the best visible match returned by `DomChannel.query()`.
 * Mirrors Spana's native matcher: prefer visible, in-bounds, clickable, deepest.
 */
export function pickBestDomMatch(matches: DomElementMatch[]): DomElementMatch | undefined {
  const visible = matches.filter((m) => m.visible);
  if (visible.length === 0) return undefined;

  const clickable = visible.filter((m) => m.clickable);
  if (clickable.length > 0) {
    return clickable[clickable.length - 1];
  }
  return visible[visible.length - 1];
}

function getNativeHierarchy<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  parse: (raw: string) => Element,
  cache?: HierarchyCache,
): Effect.Effect<Element, DriverError> {
  if (cache) return cache.get(driver as unknown as RawDriverService, parse);
  return Effect.gen(function* () {
    const raw = yield* driver.dumpHierarchy();
    return parse(raw);
  });
}

export interface ChannelResolveOptions {
  /** Whether we're resolving for a touch/click action (maps to screen coords unless tapMode === "dom") */
  forAction?: boolean;
  /** Default "native" (real touch via native driver). Opt-in "dom" skips native coordinate mapping. */
  tapMode?: TapMode;
  platform?: Platform;
}

/**
 * Channel-hiding resolver — core of Spana's web-first architecture:
 *
 *   1. If selector is explicitly marked `systemUI` (e.g. SFSafariViewController,
 *      Chrome Custom Tabs, OS permission dialogs), query the native tree directly.
 *   2. If selector is `{ testID }` (or a simple non-relative selector when the
 *      DOM channel is already connected) and a `domChannel` exists on the driver,
 *      query the DOM first (~1ms, locale-independent).
 *      - For assertions/reads or `tapMode: "dom"`, return immediately without
 *        fetching the native page source.
 *      - For real native taps (`tapMode: "native"`), fetch/cache the native
 *        hierarchy once to locate the WebView frame, convert the DOM rect into
 *        screen coordinates, and return the screen-positioned element.
 *   3. Otherwise, or if step 2 finds nothing (out-of-process browser sheet or
 *      native chrome), fall back seamlessly to the native accessibility tree.
 */
export function resolveElementAcrossChannels<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  selector: ExtendedSelector<T>,
  parse: (raw: string) => Element,
  cache?: HierarchyCache,
  options: ChannelResolveOptions = {},
): Effect.Effect<ResolvedElementResult | undefined, DriverError> {
  return Effect.gen(function* () {
    const domChannel: DomChannel | undefined = driver.domChannel;
    const isSystemUI = isSystemUISelector(selector);
    const forAction = options.forAction ?? false;
    const tapMode: TapMode = options.tapMode ?? "native";

    // Step 1 & 2: Try DOM channel first for testID selectors (and simple
    // selectors when a DOM channel is already connected), unless explicitly systemUI.
    const canTryDom =
      !isSystemUI &&
      !isRelativeSelector(selector) &&
      domChannel !== undefined &&
      (isTestIDSelector(selector) || isComposableDomSelector(selector) || domChannel.isConnected());

    if (canTryDom) {
      const domMatches = yield* Effect.tryPromise({
        try: async () => {
          if (!domChannel.isConnected()) {
            // Only attempt lazy connect for DOM-targeted queries so non-webview
            // native apps don't stall on every text query.
            if (!isTestIDSelector(selector) && !isComposableDomSelector(selector)) return [];
            try {
              await domChannel.connect();
            } catch {
              return [];
            }
          }
          return await domChannel.query(selector as Selector);
        },
        catch: (err) => {
          if (isInvalidSelectorError(err)) {
            return new DriverError({
              message: err instanceof Error ? err.message : String(err),
            });
          }
          return null;
        },
      }).pipe(
        Effect.catch((err) =>
          err instanceof DriverError ? Effect.fail(err) : Effect.succeed([] as DomElementMatch[]),
        ),
      );

      const best = pickBestDomMatch(domMatches);
      if (best) {
        if (!forAction || tapMode === "dom") {
          return {
            element: domMatchToElement(best),
            channel: "dom" as const,
            domMatch: best,
          };
        }

        // Auto-scroll offscreen DOM elements into the viewport before mapping
        // coordinates for a native touch so taps never miss below the fold.
        let targetMatch = best;
        if (isOffscreenInViewport(best) && domChannel.scrollIntoView) {
          const scrolled = yield* Effect.tryPromise({
            try: () => domChannel.scrollIntoView!(selector as Selector),
            catch: () => null,
          }).pipe(Effect.catch(() => Effect.succeed(null)));
          if (scrolled) {
            targetMatch = scrolled;
          }
        }

        // On pure web targets, the viewport IS the screen frame (0 native dumps!).
        if (options.platform === "web") {
          const webFrame: Bounds = {
            x: 0,
            y: 0,
            width: targetMatch.viewportWidth,
            height: targetMatch.viewportHeight,
          };
          const screenBounds = domRectToScreenBounds(targetMatch, webFrame, {
            platform: "web",
          });
          return {
            element: domMatchToElement(targetMatch, screenBounds),
            channel: "dom" as const,
            domMatch: targetMatch,
            webViewFrame: webFrame,
          };
        }

        // Convert DOM rect -> native screen coordinates using cached WebView frame
        // (eliminates ~90% of native WDA/UiAutomator2 XML dumps across consecutive WebView taps;
        // auto-invalidates if viewport dimensions change, e.g. on orientation rotation).
        const now = Date.now();
        const cachedFrame = webViewFrameCache.get(driver as object);
        let webViewFrame: Bounds | undefined;
        if (
          cachedFrame &&
          cachedFrame.viewportWidth === targetMatch.viewportWidth &&
          cachedFrame.viewportHeight === targetMatch.viewportHeight &&
          now - cachedFrame.cachedAt < WEBVIEW_FRAME_CACHE_TTL_MS
        ) {
          webViewFrame = cachedFrame.frame;
        } else {
          const nativeRoot = yield* getNativeHierarchy(driver, parse, cache);
          webViewFrame = findWebViewFrame(nativeRoot);
          webViewFrameCache.set(driver as object, {
            frame: webViewFrame,
            viewportWidth: targetMatch.viewportWidth,
            viewportHeight: targetMatch.viewportHeight,
            cachedAt: now,
          });
        }

        const screenBounds = domRectToScreenBounds(targetMatch, webViewFrame, {
          platform: options.platform,
        });
        return {
          element: domMatchToElement(targetMatch, screenBounds),
          channel: "dom" as const,
          domMatch: targetMatch,
          webViewFrame,
        };
      }
    }

    // Step 3: Query the native accessibility tree (handles system sheets,
    // SFSafariViewController, ASWebAuthenticationSession, Chrome Custom Tabs,
    // permission dialogs, and native chrome).
    const nativeRoot = yield* getNativeHierarchy(driver, parse, cache);
    const nativeEl = forAction
      ? findActionElementExtended(nativeRoot, selector)
      : findElementExtended(nativeRoot, selector);

    if (!nativeEl) {
      return undefined;
    }

    return {
      element: nativeEl,
      channel: "native" as const,
    };
  });
}
