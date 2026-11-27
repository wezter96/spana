import { Duration, Effect } from "effect";
import { DriverError, ElementNotFoundError, WaitTimeoutError } from "../errors.js";
import type { Element } from "../schemas/element.js";
import type { ExtendedSelector, Platform, Selector, TapMode } from "../schemas/selector.js";
import {
  isComposableDomSelector,
  isSystemUISelector,
  isTestIDSelector,
} from "../schemas/selector.js";
import type { RawDriverService } from "../drivers/raw-driver.js";
import { formatSelector } from "./element-matcher.js";
import type { HierarchyCache } from "./hierarchy-cache.js";
import { diagnoseElementNotFound, formatDiagnostic } from "./diagnostics.js";
import {
  isInvalidSelectorError,
  resolveElementAcrossChannels,
  type ResolvedElementResult,
} from "./channel-resolver.js";
import { buildDomActionabilityDiagScript, domMatchToElement } from "../channels/dom-channel.js";

export interface WaitOptions {
  timeout?: number; // default 5000ms
  pollInterval?: number; // default 200ms
  settleTimeout?: number; // default 0ms — wait for hierarchy to stabilize before returning
  /** Starting poll interval for adaptive polling. Default: 50ms. Set equal to pollInterval to disable adaptive backoff. */
  initialPollInterval?: number;
  /** Tap dispatch mode when resolved via DOM channel: "native" (default, real touch) or "dom" (fast synthetic click). */
  tapMode?: TapMode;
  /** Platform hint for coordinate scaling (android physical px vs ios logical pt). */
  platform?: Platform;
  /** Fail early on web when DOM stays idle and document is complete instead of waiting full timeout. */
  failFastWhenIdle?: boolean;
  /** Quiet window in ms before failFastWhenIdle resolves empty. Default: 250. */
  idleQuietMs?: number;
  /** Consecutive stable animation frames required before pointer actions on web. Default: 2. */
  actionStableFrames?: number;
  /** Post-fill remount verification delay in ms (default: 12). Set 0 for synchronous verify. */
  fillVerifyMs?: number;
  /** Skip actionability checks (enabled, hit-test, stability) when performing an action (Playwright `{ force: true }`). */
  force?: boolean;
  /** Arm the moving-target tap guard inside `waitForSelector` so Direct CDP taps need 0 extra eval RTTs. */
  armTapGuard?: boolean;
}

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_POLL_INTERVAL = 200;
const DEFAULT_INITIAL_POLL_INTERVAL = 50;
const DEFAULT_SETTLE_TIMEOUT = 0;

/** Parse a raw hierarchy string (JSON from web, XML from native — caller provides parser) */
type HierarchyParser = (raw: string) => Element;

/** Get the hierarchy root — uses cache if provided, otherwise dumps fresh. */
function getHierarchy<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  parse: HierarchyParser,
  cache?: HierarchyCache,
): Effect.Effect<Element, DriverError> {
  if (cache) return cache.get(driver as unknown as RawDriverService, parse);
  return Effect.gen(function* () {
    const raw = yield* driver.dumpHierarchy();
    return parse(raw);
  });
}

/** Calculate next poll interval with linear backoff from initial to max. */
function nextInterval(elapsed: number, timeout: number, initial: number, max: number): number {
  if (initial >= max) return max;
  const rampDuration = timeout / 2;
  const progress = Math.min(elapsed / rampDuration, 1);
  return Math.round(initial + (max - initial) * progress);
}

/** Wait for `bridge.idle()` when a connected DOM channel supports it (non-fatal). */
function maybeWaitForBridgeIdle<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  timeout: number,
): Effect.Effect<void> {
  const domChannel = driver.domChannel;
  if (!domChannel || !domChannel.isConnected() || !domChannel.waitForIdle) {
    return Effect.void;
  }
  return Effect.tryPromise({
    try: () => domChannel.waitForIdle!({ timeout: Math.min(timeout, 2500) }),
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.void));
}

function isRelativeSelectorLike(selector: ExtendedSelector<any>): boolean {
  if (typeof selector !== "object" || selector === null) return false;
  return (
    "below" in selector ||
    "above" in selector ||
    "leftOf" in selector ||
    "rightOf" in selector ||
    "childOf" in selector
  );
}

/** Poll until an element matching selector is resolved via DOM or native channel. */
function waitForResolvedAcrossChannels<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  selector: ExtendedSelector<T>,
  parse: HierarchyParser,
  forAction: boolean,
  opts?: WaitOptions,
  cache?: HierarchyCache,
): Effect.Effect<ResolvedElementResult, ElementNotFoundError | WaitTimeoutError | DriverError> {
  const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;
  const pollInterval = opts?.pollInterval ?? DEFAULT_POLL_INTERVAL;
  const initialPollInterval = opts?.initialPollInterval ?? DEFAULT_INITIAL_POLL_INTERVAL;
  const settleTimeout = opts?.settleTimeout ?? DEFAULT_SETTLE_TIMEOUT;

  return Effect.gen(function* () {
    const start = Date.now();
    let waitedForIdle = false;
    let isFirstPoll = true;
    const canReactiveDomWait =
      !isSystemUISelector(selector) &&
      !isRelativeSelectorLike(selector) &&
      (opts?.platform === "web" || isTestIDSelector(selector) || isComposableDomSelector(selector));

    // Single-round-trip web fast path: waitForSelector performs visibility, enabled,
    // scrollIntoView, hit-test, and 2-rAF stability checks inside ONE in-page evaluate,
    // returning the final DomElementMatch directly with zero extra query round trips.
    // Never treat an early empty/failed answer (e.g. page reload/navigation mid-wait)
    // as final before `timeout` expires unless `failFastWhenIdle` is enabled (2.28).
    const initialDomChannel = driver.domChannel;
    if (
      opts?.platform === "web" &&
      canReactiveDomWait &&
      settleTimeout === 0 &&
      initialDomChannel?.isConnected() &&
      initialDomChannel.waitForSelector
    ) {
      let lastReactiveErrorMsg: string | undefined;
      let sawEmptyArray = false;
      let attemptIdx = 0;

      while (attemptIdx === 0 || Date.now() - start < timeout) {
        attemptIdx += 1;
        const remaining = Math.max(10, timeout - (Date.now() - start));
        const reactiveMatches = yield* Effect.tryPromise({
          try: () =>
            initialDomChannel.waitForSelector!(selector as Selector, {
              timeoutMs: remaining,
              forAction: opts?.force ? false : forAction,
              checkHitTest: opts?.force ? false : undefined,
              failFastWhenIdle: opts?.failFastWhenIdle,
              idleQuietMs: opts?.idleQuietMs,
              ...(opts?.force
                ? { stableFrames: 0 }
                : opts?.actionStableFrames !== undefined
                  ? { stableFrames: opts.actionStableFrames }
                  : {}),
              ...(opts?.armTapGuard && !opts?.force ? { armTapGuard: true } : {}),
            }),
          catch: (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            lastReactiveErrorMsg = msg;
            if (isInvalidSelectorError(err) || /context closed/i.test(msg)) {
              return new DriverError({ message: msg });
            }
            return null;
          },
        }).pipe(
          Effect.catch((err) =>
            err instanceof DriverError ? Effect.fail(err) : Effect.succeed(null),
          ),
        );

        if (Array.isArray(reactiveMatches) && reactiveMatches.length > 0) {
          const match = reactiveMatches[reactiveMatches.length - 1]!;
          return {
            element: domMatchToElement(match),
            channel: "dom" as const,
            tapMode: opts?.tapMode ?? "native",
            domMatch: match,
          };
        }
        if (Array.isArray(reactiveMatches) && reactiveMatches.length === 0) {
          sawEmptyArray = true;
          if (opts?.failFastWhenIdle || Date.now() - start >= timeout) {
            break;
          }
          // Page likely reloaded or document swapped mid-wait — retry in new document until deadline (2.28)
          const waitMs = Math.min(50, Math.max(10, timeout - (Date.now() - start)));
          yield* Effect.sleep(Duration.millis(waitMs));
          continue;
        }
        if (lastReactiveErrorMsg && /Iframe matching .* not found/i.test(lastReactiveErrorMsg)) {
          return yield* new ElementNotFoundError({
            message: `${lastReactiveErrorMsg} — selector: ${formatSelector(selector)}`,
            selector,
            timeoutMs: timeout,
          });
        }
        if (Date.now() - start >= timeout) {
          break;
        }
        // Transient navigation/execution context error before deadline — retry in new document
        const retryWait = Math.min(60, Math.max(10, timeout - (Date.now() - start)));
        yield* Effect.sleep(Duration.millis(retryWait));
      }

      if (sawEmptyArray || forAction || Date.now() - start >= timeout) {
        const actionDiag = yield* Effect.tryPromise({
          try: () =>
            initialDomChannel.evaluate<{
              found?: boolean;
              visible?: boolean;
              enabled?: boolean;
              obstructedBy?: string;
              matchCount?: number;
              visibleCount?: number;
              detachedAfterScroll?: boolean;
            }>(buildDomActionabilityDiagScript(selector as Selector)),
          catch: () => null,
        }).pipe(Effect.catch(() => Effect.succeed(null)));

        if (forAction && actionDiag?.found && actionDiag.obstructedBy) {
          return yield* new ElementNotFoundError({
            message: `Element is covered by ${actionDiag.obstructedBy} (not actionable within ${timeout}ms) — selector: ${formatSelector(selector)}`,
            selector,
            timeoutMs: timeout,
          });
        }
        if (forAction && actionDiag?.found && actionDiag.visible && actionDiag.enabled === false) {
          return yield* new ElementNotFoundError({
            message: `Element is disabled (not actionable within ${timeout}ms) — selector: ${formatSelector(selector)}`,
            selector,
            timeoutMs: timeout,
          });
        }
        const extraHints: string[] = [];
        if (actionDiag?.found && !actionDiag.visible && (actionDiag.matchCount ?? 0) > 0) {
          extraHints.push(
            `Matched ${actionDiag.matchCount} element(s) (${actionDiag.visibleCount ?? 0} visible); picked match is hidden`,
          );
        }
        if (actionDiag?.detachedAfterScroll) {
          extraHints.push("Element detached from the DOM after scrolling");
        }
        if (lastReactiveErrorMsg && !sawEmptyArray) {
          extraHints.push(`Last error: ${lastReactiveErrorMsg}`);
        }
        if (cache) cache.invalidate();
        const diagRoot = yield* getHierarchy(driver, parse, cache).pipe(
          Effect.catch(() =>
            Effect.succeed({ bounds: { x: 0, y: 0, width: 0, height: 0 }, children: [] }),
          ),
        );
        const diagnostic = diagnoseElementNotFound(diagRoot, selector);
        const diagMessage = formatDiagnostic(diagnostic);
        const hintSuffix = extraHints.length > 0 ? `\n${extraHints.join("\n")}` : "";
        return yield* new ElementNotFoundError({
          message: `Element not found within ${timeout}ms — selector: ${formatSelector(selector)}${hintSuffix}\n${diagMessage}`,
          selector,
          timeoutMs: timeout,
        });
      }
    }

    while (isFirstPoll || Date.now() - start < timeout) {
      if (!isFirstPoll && cache) cache.invalidate();
      isFirstPoll = false;

      const resolved = yield* resolveElementAcrossChannels(driver, selector, parse, cache, {
        forAction,
        tapMode: opts?.tapMode,
        platform: opts?.platform,
      });

      if (resolved) {
        if (settleTimeout > 0) {
          yield* Effect.sleep(Duration.millis(settleTimeout));
          if (cache) cache.invalidate();
          const settled = yield* resolveElementAcrossChannels(driver, selector, parse, cache, {
            forAction,
            tapMode: opts?.tapMode,
            platform: opts?.platform,
          });
          if (settled) return settled;
        } else {
          return resolved;
        }
      }

      // Reactive MutationObserver wait inside the browser/WebView DOM channel:
      // wakes up in ~1-2ms as soon as the element mounts instead of sleeping 50-200ms per poll tick.
      const domChannel = driver.domChannel;
      if (canReactiveDomWait && domChannel?.isConnected() && domChannel.waitForSelector) {
        const remaining = Math.max(0, timeout - (Date.now() - start));
        if (remaining > 0) {
          const reactiveResult = yield* Effect.tryPromise({
            try: () =>
              domChannel.waitForSelector!(selector as Selector, {
                timeoutMs: Math.min(remaining, opts?.platform === "web" ? remaining : 1000),
                forAction,
                failFastWhenIdle: opts?.failFastWhenIdle,
                idleQuietMs: opts?.idleQuietMs,
                ...(opts?.actionStableFrames !== undefined
                  ? { stableFrames: opts.actionStableFrames }
                  : {}),
                ...(opts?.armTapGuard && !opts?.force ? { armTapGuard: true } : {}),
              }),
            catch: () => null,
          }).pipe(Effect.catch(() => Effect.succeed(null)));

          if (Array.isArray(reactiveResult) && reactiveResult.length > 0) {
            // Element mounted! Loop immediately to resolve coordinates & return without sleeping.
            continue;
          }
          if (
            Array.isArray(reactiveResult) &&
            reactiveResult.length === 0 &&
            opts?.failFastWhenIdle &&
            opts?.platform === "web"
          ) {
            // Page is idle & document.readyState === "complete" — fail fast instead of burning full timeout.
            break;
          }
        }
      }

      // If the element isn't in the DOM yet and spana-bridge is connected,
      // wait once for in-flight network/animations/renders to settle instead of blind polling.
      if (!waitedForIdle && driver.domChannel?.isConnected() && driver.domChannel.waitForIdle) {
        waitedForIdle = true;
        const remaining = Math.max(0, timeout - (Date.now() - start));
        if (remaining > 0) {
          yield* maybeWaitForBridgeIdle(driver, Math.min(remaining, 1500));
          continue;
        }
      }

      const elapsed = Date.now() - start;
      const interval = nextInterval(elapsed, timeout, initialPollInterval, pollInterval);
      yield* Effect.sleep(Duration.millis(interval));
    }

    // Capture diagnostic info from the last hierarchy
    if (cache) cache.invalidate();
    const diagRoot = yield* getHierarchy(driver, parse, cache);
    const diagnostic = diagnoseElementNotFound(diagRoot, selector);
    const diagMessage = formatDiagnostic(diagnostic);

    return yield* new ElementNotFoundError({
      message: `Element not found within ${timeout}ms — selector: ${formatSelector(selector)}\n${diagMessage}`,
      selector,
      timeoutMs: timeout,
    });
  });
}

/** Poll until an element matching selector is found (returns resolved metadata). */
export function waitForResolvedElementResult<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  selector: ExtendedSelector<T>,
  parse: HierarchyParser,
  forAction: boolean,
  opts?: WaitOptions,
  cache?: HierarchyCache,
): Effect.Effect<ResolvedElementResult, ElementNotFoundError | WaitTimeoutError | DriverError> {
  return waitForResolvedAcrossChannels(driver, selector, parse, forAction, opts, cache);
}

/** Poll until an element matching selector is found. */
export function waitForElement<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  selector: ExtendedSelector<T>,
  parse: HierarchyParser,
  opts?: WaitOptions,
  cache?: HierarchyCache,
): Effect.Effect<Element, ElementNotFoundError | WaitTimeoutError | DriverError> {
  return waitForResolvedAcrossChannels(driver, selector, parse, false, opts, cache).pipe(
    Effect.map((r) => r.element),
  );
}

/** Poll until an actionable element matching selector is found. */
export function waitForActionElement<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  selector: ExtendedSelector<T>,
  parse: HierarchyParser,
  opts?: WaitOptions,
  cache?: HierarchyCache,
): Effect.Effect<Element, ElementNotFoundError | WaitTimeoutError | DriverError> {
  return waitForResolvedAcrossChannels(driver, selector, parse, true, opts, cache).pipe(
    Effect.map((r) => r.element),
  );
}

/** Poll until element matching selector is NOT visible */
export function waitForNotVisible<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  selector: ExtendedSelector<T>,
  parse: HierarchyParser,
  opts?: WaitOptions,
  cache?: HierarchyCache,
): Effect.Effect<void, WaitTimeoutError | DriverError> {
  const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;
  const pollInterval = opts?.pollInterval ?? DEFAULT_POLL_INTERVAL;
  const initialPollInterval = opts?.initialPollInterval ?? DEFAULT_INITIAL_POLL_INTERVAL;

  return Effect.gen(function* () {
    const start = Date.now();
    let waitedForIdle = false;
    let isFirstPoll = true;

    // Single-round-trip MutationObserver wait on web/DOM channels (zero runner polling)
    const domChannel = driver.domChannel;
    const canReactiveHidden =
      !isSystemUISelector(selector) &&
      !isRelativeSelectorLike(selector) &&
      (opts?.platform === "web" || isTestIDSelector(selector) || isComposableDomSelector(selector));

    if (canReactiveHidden && domChannel?.isConnected() && domChannel.waitForHidden) {
      let hiddenAttempt = 0;
      while (hiddenAttempt === 0 || Date.now() - start < timeout) {
        hiddenAttempt += 1;
        const remaining = Math.max(10, timeout - (Date.now() - start));
        const hidden = yield* Effect.tryPromise({
          try: () => domChannel.waitForHidden!(selector as Selector, { timeoutMs: remaining }),
          catch: (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            return isInvalidSelectorError(err) || /context closed/i.test(msg)
              ? new DriverError({ message: msg })
              : null;
          },
        }).pipe(
          Effect.catch((err) =>
            err instanceof DriverError ? Effect.fail(err) : Effect.succeed(null),
          ),
        );

        if (hidden === true) return;
        if (hidden === false && Date.now() - start >= timeout) {
          return yield* new WaitTimeoutError({
            message: `Element still visible after ${timeout}ms — selector: ${formatSelector(selector)}`,
            selector,
            timeoutMs: timeout,
          });
        }
        if (Date.now() - start >= timeout) break;
        yield* Effect.sleep(
          Duration.millis(Math.min(50, Math.max(10, timeout - (Date.now() - start)))),
        );
      }
    }

    while (isFirstPoll || Date.now() - start < timeout) {
      if (!isFirstPoll && cache) cache.invalidate();
      isFirstPoll = false;

      const resolved = yield* resolveElementAcrossChannels(driver, selector, parse, cache, {
        forAction: false,
        platform: opts?.platform,
      });
      if (!resolved) return;

      if (!waitedForIdle && driver.domChannel?.isConnected() && driver.domChannel.waitForIdle) {
        waitedForIdle = true;
        const remaining = Math.max(0, timeout - (Date.now() - start));
        if (remaining > 0) {
          yield* maybeWaitForBridgeIdle(driver, Math.min(remaining, 1500));
          continue;
        }
      }

      const elapsed = Date.now() - start;
      const interval = nextInterval(elapsed, timeout, initialPollInterval, pollInterval);
      yield* Effect.sleep(Duration.millis(interval));
    }
    return yield* new WaitTimeoutError({
      message: `Element still visible after ${timeout}ms — selector: ${formatSelector(selector)}`,
      selector,
      timeoutMs: timeout,
    });
  });
}
