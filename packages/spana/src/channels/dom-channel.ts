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
}

export interface DomIdleOptions {
  /** Max time to wait for idle in ms. Default: 5000. */
  timeout?: number;
  /** Quiet window after network/DOM/animations settle in ms. Default: 50. */
  quietPeriodMs?: number;
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
  tapDom(selector: Selector): Promise<boolean>;
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
  // Support `return ...` style scripts passed from WebDriver-style callers
  if (/\breturn\b/.test(trimmed) && !trimmed.startsWith("(") && !trimmed.startsWith("async")) {
    const serializedArgs = args.map((arg) => JSON.stringify(arg)).join(", ");
    return `(function(){ ${trimmed} })(${serializedArgs})`;
  }
  return script;
}

/**
 * Self-contained DOM query script evaluated over CDP / WebKit Inspector when
 * `spana-bridge` is not injected. Mirrors `spana-bridge`'s `query(selector)`
 * return shape (`DomElementMatch[]`).
 */
export function buildDomQueryScript(selector: Selector): string {
  const serialized = JSON.stringify(selector);
  return `(function(sel) {
    function isClickable(el) {
      var tag = el.tagName;
      if (tag === "BUTTON" || tag === "A" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return true;
      var role = el.getAttribute && el.getAttribute("role");
      if (role === "button" || role === "link" || role === "tab" || role === "checkbox" || role === "switch") return true;
      if (typeof el.onclick === "function") return true;
      var cursor = window.getComputedStyle(el).cursor;
      return cursor === "pointer";
    }
    function isVisible(el, rect) {
      if (rect.width <= 0 || rect.height <= 0) return false;
      var style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity || "1") === 0) return false;
      return true;
    }
    function toMatch(el) {
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
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        scrollX: window.scrollX || window.pageXOffset || 0,
        scrollY: window.scrollY || window.pageYOffset || 0,
        devicePixelRatio: window.devicePixelRatio || 1,
        viewportWidth: (window.visualViewport && window.visualViewport.width) || window.innerWidth || document.documentElement.clientWidth || 0,
        viewportHeight: (window.visualViewport && window.visualViewport.height) || window.innerHeight || document.documentElement.clientHeight || 0,
        visible: isVisible(el, rect),
        enabled: !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true",
        clickable: isClickable(el),
        focused: document.activeElement === el,
        attributes: attrs
      };
    }
    var candidates = [];
    if (typeof sel === "object" && sel !== null && "testID" in sel) {
      var esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(sel.testID) : sel.testID.replace(/"/g, '\\\\"');
      candidates = Array.from(document.querySelectorAll('[data-testid="' + esc + '"], [testID="' + esc + '"]'));
    } else if (typeof sel === "object" && sel !== null && "accessibilityLabel" in sel) {
      var escLabel = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(sel.accessibilityLabel) : sel.accessibilityLabel.replace(/"/g, '\\\\"');
      candidates = Array.from(document.querySelectorAll('[aria-label="' + escLabel + '"]'));
    } else if (typeof sel === "string" || (typeof sel === "object" && sel !== null && "text" in sel)) {
      var needle = (typeof sel === "string" ? sel : sel.text).toLowerCase();
      var all = Array.from(document.querySelectorAll("*"));
      for (var j = 0; j < all.length; j++) {
        var node = all[j];
        var directText = "";
        for (var k = 0; k < node.childNodes.length; k++) {
          if (node.childNodes[k].nodeType === 3) directText += node.childNodes[k].textContent || "";
        }
        var trimmedDirect = directText.trim().toLowerCase();
        var inputVal = (node.tagName === "INPUT" || node.tagName === "BUTTON") ? String(node.value || "").toLowerCase() : "";
        if ((trimmedDirect && trimmedDirect.includes(needle)) || (inputVal && inputVal.includes(needle))) {
          candidates.push(node);
        }
      }
    } else if (typeof sel === "object" && sel !== null && "point" in sel) {
      var atPt = document.elementFromPoint(sel.point.x, sel.point.y);
      if (atPt) candidates = [atPt];
    }
    return candidates.map(toMatch);
  })(${serialized})`;
}

/**
 * Self-contained DOM synthetic tap script for `tapMode: "dom"`.
 */
export function buildDomTapScript(selector: Selector): string {
  const serialized = JSON.stringify(selector);
  return `(function(sel) {
    var el = null;
    if (typeof sel === "object" && sel !== null && "testID" in sel) {
      var esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(sel.testID) : sel.testID.replace(/"/g, '\\\\"');
      el = document.querySelector('[data-testid="' + esc + '"], [testID="' + esc + '"]');
    } else if (typeof sel === "object" && sel !== null && "accessibilityLabel" in sel) {
      var escLabel = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(sel.accessibilityLabel) : sel.accessibilityLabel.replace(/"/g, '\\\\"');
      el = document.querySelector('[aria-label="' + escLabel + '"]');
    } else if (typeof sel === "string" || (typeof sel === "object" && sel !== null && "text" in sel)) {
      var needle = (typeof sel === "string" ? sel : sel.text).toLowerCase();
      var all = Array.from(document.querySelectorAll("button, a, input, [role=button], *"));
      for (var i = 0; i < all.length; i++) {
        var txt = (all[i].innerText || all[i].textContent || "").trim().toLowerCase();
        if (txt && txt.includes(needle)) { el = all[i]; break; }
      }
    } else if (typeof sel === "object" && sel !== null && "point" in sel) {
      el = document.elementFromPoint(sel.point.x, sel.point.y);
    }
    if (!el) return false;
    if (typeof el.scrollIntoView === "function") {
      try { el.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch {}
    }
    var rect = el.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var init = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy };
    try { el.dispatchEvent(new PointerEvent("pointerdown", init)); } catch {}
    try { el.dispatchEvent(new MouseEvent("mousedown", init)); } catch {}
    if (typeof el.focus === "function") { try { el.focus(); } catch {} }
    try { el.dispatchEvent(new PointerEvent("pointerup", init)); } catch {}
    try { el.dispatchEvent(new MouseEvent("mouseup", init)); } catch {}
    if (typeof el.click === "function") { el.click(); }
    else { el.dispatchEvent(new MouseEvent("click", init)); }
    return true;
  })(${serialized})`;
}
