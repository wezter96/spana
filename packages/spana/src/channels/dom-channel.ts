import type { Element, Bounds } from "../schemas/element.js";
import type { Selector } from "../schemas/selector.js";
import type {
  BrowserConsoleLog,
  BrowserJSError,
  BrowserMockResponse,
  BrowserRouteMatcher,
} from "../drivers/raw-driver.js";

export type DomChannelKind = "bridge" | "cdp" | "webkit-inspector" | "playwright";

export interface DomRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DomElementMatch {
  id?: string;
  tag?: string;
  text?: string;
  value?: string;
  accessibilityLabel?: string;
  rect: DomRect;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
  viewportWidth: number;
  viewportHeight: number;
  visible: boolean;
  enabled: boolean;
  clickable: boolean;
  focused?: boolean;
  attributes?: Record<string, string>;
  /** True when the matched element lives inside a ShadowRoot */
  inShadowDom?: boolean;
  /** True when the matched element lives inside a same-origin iframe */
  inIframe?: boolean;
}

export interface DomIdleOptions {
  /** Max time to wait for idle in ms. Default: 5000. */
  timeout?: number;
  /** Quiet window after network/DOM/animations settle in ms. Default: 50. */
  quietPeriodMs?: number;
}

export interface DomWaitForSelectorOptions {
  /** Max time to wait in ms. Default: 5000. */
  timeoutMs?: number;
  /** Require the matched element to be visible & enabled for pointer actions. */
  forAction?: boolean;
  /** Fail early once the DOM stays quiet and document.readyState === "complete". */
  failFastWhenIdle?: boolean;
  /** Quiet window in ms before failFastWhenIdle resolves empty. Default: 250. */
  idleQuietMs?: number;
}

export interface DomStorageEntries {
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
  cookies?: Array<{ name: string; value: string; path?: string; domain?: string }>;
  capacitorPreferences?: Record<string, string>;
}

export interface DomClearStorageOptions {
  localStorage?: boolean;
  sessionStorage?: boolean;
  cookies?: boolean;
  indexedDB?: boolean;
  capacitorPreferences?: boolean;
}

export interface DomTargetInfo {
  id: string;
  title?: string;
  url?: string;
  type?: string;
}

/**
 * Unified DOM channel interface shared across:
 *   - `spana-bridge` (in-app WebSocket bridge, same JS on all 5 targets)
 *   - Android WebView CDP (`adb forward localabstract:webview_devtools_remote_<pid>`)
 *   - iOS WKWebView WebKit Remote Inspector (`isInspectable = true`)
 *   - Electron / Electrobun CDP or WebKit Inspector
 */
export interface DomChannel {
  readonly kind: DomChannelKind;
  isConnected(): boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  evaluate<T = unknown>(script: string | ((...args: any[]) => T), ...args: any[]): Promise<T>;
  query(selector: Selector): Promise<DomElementMatch[]>;
  /** MutationObserver-reactive DOM wait: resolves immediately when a matching visible element mounts. */
  waitForSelector?(
    selector: Selector,
    opts?: DomWaitForSelectorOptions,
  ): Promise<DomElementMatch[]>;
  tapDom(selector: Selector): Promise<boolean>;
  /** Scroll a DOM element into the viewport center and return its updated bounding rect. */
  scrollIntoView?(selector: Selector): Promise<DomElementMatch | null>;
  dispatch?(
    selector: Selector,
    eventType: string,
    eventInit?: Record<string, unknown>,
  ): Promise<boolean>;
  waitForIdle?(opts?: DomIdleOptions): Promise<void>;
  setStorage?(entries: DomStorageEntries): Promise<void>;
  clearStorage?(opts?: DomClearStorageOptions): Promise<void>;
  reload?(): Promise<void>;
  mockNetwork?(matcher: BrowserRouteMatcher, response: BrowserMockResponse): Promise<void>;
  blockNetwork?(matcher: BrowserRouteMatcher): Promise<void>;
  clearNetworkMocks?(): Promise<void>;
  getConsoleLogs?(): Promise<BrowserConsoleLog[]>;
  getJSErrors?(): Promise<BrowserJSError[]>;
  listTargets?(): Promise<DomTargetInfo[]>;
  selectTarget?(targetId: string): Promise<void>;
}

/** Convert a DomElementMatch + resolved screen bounds into Spana's unified Element shape. */
export function domMatchToElement(match: DomElementMatch, screenBounds?: Bounds): Element {
  return {
    ...(match.id !== undefined ? { id: match.id } : {}),
    ...(match.text !== undefined ? { text: match.text } : {}),
    ...(match.value !== undefined ? { value: match.value } : {}),
    ...(match.accessibilityLabel !== undefined
      ? { accessibilityLabel: match.accessibilityLabel }
      : {}),
    ...(match.tag !== undefined ? { elementType: match.tag } : {}),
    bounds: screenBounds ?? {
      x: Math.round(match.rect.x),
      y: Math.round(match.rect.y),
      width: Math.round(match.rect.width),
      height: Math.round(match.rect.height),
    },
    enabled: match.enabled,
    visible: match.visible,
    clickable: match.clickable,
    ...(match.focused !== undefined ? { focused: match.focused } : {}),
    ...(match.attributes && Object.keys(match.attributes).length > 0
      ? { attributes: match.attributes }
      : {}),
  };
}

/**
 * Build a self-contained JS expression string for evaluating either a string
 * expression/body or a function + serializable arguments inside a remote DOM.
 */
export function buildEvaluateExpression(
  script: string | ((...args: unknown[]) => unknown),
  args: unknown[] = [],
): string {
  if (typeof script === "function") {
    const serializedArgs = args.map((arg) => JSON.stringify(arg)).join(", ");
    return `(${script.toString()})(${serializedArgs})`;
  }
  const trimmed = script.trim();
  if (/\breturn\b/.test(trimmed) && !trimmed.startsWith("(") && !trimmed.startsWith("async")) {
    const serializedArgs = args.map((arg) => JSON.stringify(arg)).join(", ");
    return `(function(){ ${trimmed} })(${serializedArgs})`;
  }
  return script;
}

/**
 * Shared in-page helper snippet that recursively pierces open Shadow DOM
 * (`el.shadowRoot`, essential for Ionic/Capacitor `ion-button`/`ion-input`)
 * and accessible same-origin `<iframe>`s (accumulating top-level viewport
 * offsets so native tap coordinates remain pixel-accurate).
 */
const SHARED_DOM_TRAVERSAL_HELPERS = `
  function collectRoots(root, offsetX, offsetY, inShadow, inIframe, out) {
    if (!root) return;
    out.push({ root: root, offsetX: offsetX, offsetY: offsetY, inShadow: inShadow, inIframe: inIframe });
    var nodes = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.shadowRoot) {
        collectRoots(el.shadowRoot, offsetX, offsetY, true, inIframe, out);
      }
      if (el.tagName === "IFRAME") {
        try {
          var frameDoc = el.contentDocument;
          if (frameDoc) {
            var frameRect = el.getBoundingClientRect();
            collectRoots(frameDoc, offsetX + frameRect.left, offsetY + frameRect.top, inShadow, true, out);
          }
        } catch (e) {}
      }
    }
  }
  function findAcrossRoots(sel) {
    var roots = [];
    collectRoots(document, 0, 0, false, false, roots);
    var hits = [];
    var seen = typeof Set !== "undefined" ? new Set() : null;
    function pushHit(el, ctx) {
      if (seen) {
        if (seen.has(el)) return;
        seen.add(el);
      }
      hits.push({ el: el, offsetX: ctx.offsetX, offsetY: ctx.offsetY, inShadow: ctx.inShadow, inIframe: ctx.inIframe });
    }
    if (typeof sel === "object" && sel !== null && "point" in sel) {
      var atPt = document.elementFromPoint(sel.point.x, sel.point.y);
      if (atPt) pushHit(atPt, { offsetX: 0, offsetY: 0, inShadow: false, inIframe: false });
      return hits;
    }
    var esc = function(v) {
      return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : String(v).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"');
    };
    for (var r = 0; r < roots.length; r++) {
      var ctx = roots[r];
      var root = ctx.root;
      if (!root.querySelectorAll) continue;
      if (typeof sel === "object" && sel !== null && "testID" in sel) {
        var tid = esc(sel.testID);
        var found = root.querySelectorAll('[data-testid="' + tid + '"], [testID="' + tid + '"]');
        for (var i = 0; i < found.length; i++) pushHit(found[i], ctx);
      } else if (typeof sel === "object" && sel !== null && "accessibilityLabel" in sel) {
        var lbl = esc(sel.accessibilityLabel);
        var foundLbl = root.querySelectorAll('[aria-label="' + lbl + '"]');
        for (var j = 0; j < foundLbl.length; j++) pushHit(foundLbl[j], ctx);
      } else if (typeof sel === "string" || (typeof sel === "object" && sel !== null && "text" in sel)) {
        var needle = (typeof sel === "string" ? sel : sel.text).toLowerCase();
        var all = root.querySelectorAll("*");
        for (var k = 0; k < all.length; k++) {
          var node = all[k];
          var directText = "";
          for (var c = 0; c < node.childNodes.length; c++) {
            if (node.childNodes[c].nodeType === 3) directText += node.childNodes[c].textContent || "";
          }
          var trimmedDirect = directText.trim().toLowerCase();
          var inputVal = (node.tagName === "INPUT" || node.tagName === "BUTTON") ? String(node.value || "").toLowerCase() : "";
          if ((trimmedDirect && trimmedDirect.includes(needle)) || (inputVal && inputVal.includes(needle))) {
            pushHit(node, ctx);
          }
        }
      }
    }
    return hits;
  }
  function isClickable(el) {
    var tag = el.tagName;
    if (tag === "BUTTON" || tag === "A" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return true;
    var role = el.getAttribute && el.getAttribute("role");
    if (role === "button" || role === "link" || role === "tab" || role === "checkbox" || role === "switch") return true;
    if (typeof el.onclick === "function") return true;
    var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var cursor = win.getComputedStyle(el).cursor;
    return cursor === "pointer";
  }
  function isVisible(el, rect) {
    if (rect.width <= 0 || rect.height <= 0) return false;
    var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var style = win.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity || "1") === 0) return false;
    return true;
  }
  function toMatch(hit) {
    var el = hit.el;
    var rect = el.getBoundingClientRect();
    var attrs = {};
    if (el.attributes) {
      for (var i = 0; i < el.attributes.length; i++) {
        attrs[el.attributes[i].name] = el.attributes[i].value;
      }
    }
    var tag = el.tagName ? el.tagName.toLowerCase() : undefined;
    var val = (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")
      ? String(el.value ?? "")
      : undefined;
    var text = (el.innerText || el.textContent || "").trim() || undefined;
    return {
      id: el.getAttribute("data-testid") || el.getAttribute("testID") || undefined,
      tag: tag,
      text: text,
      value: val,
      accessibilityLabel: el.getAttribute("aria-label") || undefined,
      rect: { x: rect.x + hit.offsetX, y: rect.y + hit.offsetY, width: rect.width, height: rect.height },
      scrollX: window.scrollX || window.pageXOffset || 0,
      scrollY: window.scrollY || window.pageYOffset || 0,
      devicePixelRatio: window.devicePixelRatio || 1,
      viewportWidth: (window.visualViewport && window.visualViewport.width) || window.innerWidth || document.documentElement.clientWidth || 0,
      viewportHeight: (window.visualViewport && window.visualViewport.height) || window.innerHeight || document.documentElement.clientHeight || 0,
      visible: isVisible(el, rect),
      enabled: !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true",
      clickable: isClickable(el),
      focused: document.activeElement === el,
      attributes: attrs,
      inShadowDom: hit.inShadow || undefined,
      inIframe: hit.inIframe || undefined
    };
  }
`;

/**
 * Self-contained DOM query script evaluated over CDP / WebKit Inspector when
 * `spana-bridge` is not injected. Pierces open Shadow DOM & same-origin iframes.
 */
export function buildDomQueryScript(selector: Selector): string {
  const serialized = JSON.stringify(selector);
  return `(function(sel) {
    ${SHARED_DOM_TRAVERSAL_HELPERS}
    return findAcrossRoots(sel).map(toMatch);
  })(${serialized})`;
}

/**
 * Self-contained DOM scroll-into-view script that centers the matched element
 * in the viewport and returns its fresh post-scroll `DomElementMatch`.
 */
export function buildDomScrollIntoViewScript(selector: Selector): string {
  const serialized = JSON.stringify(selector);
  return `(function(sel) {
    ${SHARED_DOM_TRAVERSAL_HELPERS}
    var hits = findAcrossRoots(sel);
    if (hits.length === 0) return null;
    var hit = hits[hits.length - 1];
    if (typeof hit.el.scrollIntoView === "function") {
      try { hit.el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); }
      catch (e) { try { hit.el.scrollIntoView(true); } catch (e2) {} }
    }
    return toMatch(hit);
  })(${serialized})`;
}

/**
 * Self-contained DOM synthetic tap script for `tapMode: "dom"`.
 * Pierces open Shadow DOM & same-origin iframes.
 */
export function buildDomTapScript(selector: Selector): string {
  const serialized = JSON.stringify(selector);
  return `(function(sel) {
    ${SHARED_DOM_TRAVERSAL_HELPERS}
    var hits = findAcrossRoots(sel);
    if (hits.length === 0) return false;
    var hit = hits[hits.length - 1];
    var el = hit.el;
    if (typeof el.scrollIntoView === "function") {
      try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch (e) {}
    }
    var rect = el.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var init = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy };
    try { el.dispatchEvent(new PointerEvent("pointerdown", init)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent("mousedown", init)); } catch (e) {}
    if (typeof el.focus === "function") { try { el.focus(); } catch (e) {} }
    try { el.dispatchEvent(new PointerEvent("pointerup", init)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent("mouseup", init)); } catch (e) {}
    if (typeof el.click === "function") { el.click(); }
    else { el.dispatchEvent(new MouseEvent("click", init)); }
    return true;
  })(${serialized})`;
}

/**
 * Self-contained MutationObserver-reactive DOM wait script.
 * Resolves synchronously (< 1ms) if the element is already visible, otherwise
 * listens for DOM mutations so async renders resolve in ~1-2ms instead of
 * waiting on 50-200ms poll ticks. Optionally supports `failFastWhenIdle`.
 */
export function buildDomWaitForSelectorScript(
  selector: Selector,
  opts: DomWaitForSelectorOptions = {},
): string {
  const serialized = JSON.stringify(selector);
  const timeoutMs = Math.max(10, Math.round(opts.timeoutMs ?? 5000));
  const forAction = Boolean(opts.forAction);
  const failFastWhenIdle = Boolean(opts.failFastWhenIdle);
  const idleQuietMs = Math.max(50, Math.round(opts.idleQuietMs ?? 250));

  return `(function(sel, timeoutMs, forAction, failFastWhenIdle, idleQuietMs) {
    ${SHARED_DOM_TRAVERSAL_HELPERS}
    function check() {
      var hits = findAcrossRoots(sel).map(toMatch);
      var filtered = hits.filter(function(m) {
        return m.visible && (!forAction || m.enabled);
      });
      return filtered.length > 0 ? filtered : null;
    }
    var immediate = check();
    if (immediate) return immediate;

    return new Promise(function(resolve) {
      var done = false;
      var observer = null;
      var timeoutTimer = null;
      var fallbackInterval = null;
      var idleTimer = null;

      function finish(result) {
        if (done) return;
        done = true;
        if (observer) { try { observer.disconnect(); } catch (e) {} }
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (fallbackInterval) clearInterval(fallbackInterval);
        if (idleTimer) clearTimeout(idleTimer);
        resolve(result);
      }

      function armIdleTimer() {
        if (!failFastWhenIdle) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(function() {
          if (document.readyState === "complete") {
            var hit = check();
            finish(hit || []);
          } else {
            armIdleTimer();
          }
        }, idleQuietMs);
      }

      function onChange() {
        var hit = check();
        if (hit) {
          finish(hit);
          return;
        }
        armIdleTimer();
      }

      timeoutTimer = setTimeout(function() {
        finish(check() || []);
      }, timeoutMs);

      fallbackInterval = setInterval(function() {
        var hit = check();
        if (hit) finish(hit);
      }, 250);

      if (typeof MutationObserver !== "undefined") {
        var root = document.documentElement || document.body || document;
        if (root) {
          observer = new MutationObserver(onChange);
          observer.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true
          });
        }
      }

      armIdleTimer();
    });
  })(${serialized}, ${timeoutMs}, ${forAction}, ${failFastWhenIdle}, ${idleQuietMs})`;
}
