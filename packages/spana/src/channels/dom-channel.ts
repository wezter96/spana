import type { Element, Bounds } from "../schemas/element.js";
import type { Selector } from "../schemas/selector.js";
import type {
  BrowserConsoleLog,
  BrowserJSError,
  BrowserMockResponse,
  BrowserRouteMatcher,
} from "../drivers/raw-driver.js";
import { SPANA_WASM_HOOK_SCRIPT } from "../drivers/wasm-utils.js";

export type DomChannelKind = "bridge" | "cdp" | "webkit-inspector" | "playwright" | "bidi";

export interface DomRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DomElementMatch {
  id?: string;
  tag?: string;
  role?: string;
  text?: string;
  /** Whitespace-normalized `el.textContent` (immune to CSS `text-transform`, Playwright parity). */
  textContent?: string;
  value?: string;
  accessibilityLabel?: string;
  accessibleName?: string;
  accessibleDescription?: string;
  rect: DomRect;
  /** Verified hit-tested click coordinates inside the visible clipped region of the element (when resolved for an action). */
  clickPoint?: { x: number; y: number };
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
  viewportWidth: number;
  viewportHeight: number;
  visible: boolean;
  enabled: boolean;
  clickable: boolean;
  focused?: boolean;
  checked?: boolean;
  editable?: boolean;
  empty?: boolean;
  className?: string;
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
  /** Require the matched element to be visible, enabled, unobstructed, and stable for pointer actions. */
  forAction?: boolean;
  /** Bypass enabled, hit-test, view-transition, and stability checks while still scrolling into view. */
  force?: boolean;
  /** Fail early once the DOM stays quiet and document.readyState === "complete". */
  failFastWhenIdle?: boolean;
  /** Quiet window in ms before failFastWhenIdle resolves empty. Default: 250. */
  idleQuietMs?: number;
  /** Consecutive requestAnimationFrame frames the bounding box must remain stable (≤ 1px) when `forAction: true`. Default: 2 (0 when instantAnimations active). */
  stableFrames?: number;
  /** Verify center point via deep `elementFromPoint` (piercing Shadow DOM & iframes) when `forAction: true`. Default: true. */
  checkHitTest?: boolean;
  /** Respect app-owned `window.__SPANA_APP_READY__` signal when defined. Default: true. */
  waitForAppReady?: boolean;
  /**
   * Arm the capture-phase moving-target tap guard directly on the resolved element
   * before resolving (0 extra round-trips on Direct CDP when paired with `Runtime.addBinding`).
   */
  armTapGuard?: boolean;
}

export interface DomWaitForHiddenOptions {
  /** Max time to wait in ms. Default: 5000. */
  timeoutMs?: number;
}

export interface DomWaitForMatchOptions {
  /** Max time to wait in ms. Default: 5000. */
  timeoutMs?: number;
  /** Assertion kind evaluated reactively inside the page via MutationObserver. */
  kind:
    | "text"
    | "containsText"
    | "matchesText"
    | "value"
    | "attribute"
    | "accessibilityLabel"
    | "accessibleName"
    | "accessibleDescription"
    | "focused"
    | "checked"
    | "enabled"
    | "role"
    | "class"
    | "css"
    | "editable"
    | "empty"
    | "count"
    | "attached"
    | "inViewport"
    | "jsProperty"
    | "url"
    | "title";
  /** Expected value/substring (optional when `kind === "attribute"` or `"accessibilityLabel"` checks presence). */
  expected?: string;
  /** Expected JS property value (JSON-comparable) when `kind === "jsProperty"`. */
  expectedValue?: unknown;
  /** JS property name when `kind === "jsProperty"`. */
  propertyName?: string;
  /** Expected element count when `kind === "count"`. */
  expectedCount?: number;
  /** When true on `kind === "count"`, count only visible matches (default: false — count all matches). */
  visibleOnly?: boolean;
  /** When true on `kind === "containsText"`, perform case-insensitive substring match (default: false — case-sensitive). */
  ignoreCase?: boolean;
  /** Attribute name when `kind === "attribute"`. */
  attributeName?: string;
  /** CSS property name when `kind === "css"`. */
  cssProperty?: string;
  /** RegExp source when matching by RegExp. */
  patternSource?: string;
  /** RegExp flags when matching by RegExp. */
  patternFlags?: string;
  /** Invert the match condition (`expect(...).not.*`). */
  negate?: boolean;
}

export interface DomFillOptions {
  /** Max time to wait for an editable actionable target in ms. Default: 5000. */
  timeoutMs?: number;
  /** Verify center point via deep `elementFromPoint` before filling. Default: true. */
  checkHitTest?: boolean;
  /** Delay in ms before checking that a controlled input didn't remount/reset after fill. Default: 12. Set 0 for synchronous verify. */
  verifyDelayMs?: number;
}

export interface DomWaitForMatchResult {
  matched: boolean;
  actual?: string;
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
  /**
   * Evaluate a function or expression inside an iframe matched by `frameSelector`.
   * For same-origin accessible iframes (including `<iframe sandbox="allow-same-origin">` without
   * `allow-scripts`), runs in the parent realm bound to `(iframe.contentDocument, iframe.contentWindow, ...args)`
   * so Chromium's sandbox never blocks execution.
   */
  evaluateInFrame?<T = unknown>(
    frameSelector: Selector,
    script: string | ((doc: any, win: any, ...args: any[]) => T),
    ...args: any[]
  ): Promise<T>;
  query(selector: Selector): Promise<DomElementMatch[]>;
  /** MutationObserver-reactive DOM wait: resolves immediately when a matching visible element mounts & is actionable. */
  waitForSelector?(
    selector: Selector,
    opts?: DomWaitForSelectorOptions,
  ): Promise<DomElementMatch[]>;
  /** MutationObserver-reactive wait until no matching visible element remains. */
  waitForHidden?(selector: Selector, opts?: DomWaitForHiddenOptions): Promise<boolean>;
  /** MutationObserver-reactive wait until text/value/attribute matches (zero runner-side polling). */
  waitForMatch?(selector: Selector, opts: DomWaitForMatchOptions): Promise<DomWaitForMatchResult>;
  /** Atomic 1-round-trip actionability wait + focus + React/Vue-safe value fill + input/change dispatch. */
  fillDom?(selector: Selector, value: string, opts?: DomFillOptions): Promise<boolean>;
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
  /** True when `waitForSelector({ armTapGuard: true })` arms the moving-target tap guard inline (eliminating the pre-tap evaluate RTT). */
  supportsInlineTapGuard?(): boolean;
  /** Fast single-attempt check & cleanup of the inline moving-target tap guard (fails open immediately on navigation). */
  checkTapGuard?(): Promise<boolean>;
}

/** Convert a DomElementMatch + resolved screen bounds into Spana's unified Element shape. */
export function domMatchToElement(match: DomElementMatch, screenBounds?: Bounds): Element {
  return {
    ...(match.id !== undefined ? { id: match.id } : {}),
    ...(match.text !== undefined ? { text: match.text } : {}),
    ...(match.textContent !== undefined ? { textContent: match.textContent } : {}),
    ...(match.value !== undefined ? { value: match.value } : {}),
    ...(match.accessibilityLabel !== undefined
      ? { accessibilityLabel: match.accessibilityLabel }
      : {}),
    ...(match.accessibleDescription !== undefined
      ? { accessibleDescription: match.accessibleDescription }
      : {}),
    ...(match.tag !== undefined ? { elementType: match.tag } : {}),
    ...(match.role !== undefined ? { role: match.role } : {}),
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
    ...(match.checked !== undefined ? { checked: match.checked } : {}),
    ...(match.editable !== undefined ? { editable: match.editable } : {}),
    ...(match.empty !== undefined ? { empty: match.empty } : {}),
    ...(match.className !== undefined ? { className: match.className } : {}),
    ...(match.attributes && Object.keys(match.attributes).length > 0
      ? { attributes: match.attributes }
      : {}),
  };
}

/**
 * Recursively serialize an argument into a JS literal expression that preserves
 * `undefined` at top-level AND inside nested arrays/objects (unlike `JSON.stringify`,
 * which turns `undefined` array items into `null` and omits `undefined` object keys),
 * as well as `NaN`, `Infinity`, `-0`, `bigint`, `Date`, and `RegExp`.
 */
export function serializeEvaluateArg(val: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (val === undefined) return "undefined";
  if (val === null) return "null";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") {
    if (Number.isNaN(val)) return "NaN";
    if (val === Infinity) return "Infinity";
    if (val === -Infinity) return "-Infinity";
    if (Object.is(val, -0)) return "-0";
    return String(val);
  }
  if (typeof val === "bigint") return `${val.toString()}n`;
  if (typeof val === "string") {
    return JSON.stringify(val).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  }
  if (val instanceof Date) {
    const t = val.getTime();
    return `new Date(${Number.isNaN(t) ? "NaN" : t})`;
  }
  if (val instanceof RegExp) {
    return `new RegExp(${JSON.stringify(val.source)}, ${JSON.stringify(val.flags)})`;
  }
  if (typeof val === "object") {
    if (seen.has(val)) return "null";
    seen.add(val);
    try {
      if (Array.isArray(val)) {
        const items: string[] = [];
        for (let i = 0; i < val.length; i++) {
          items.push(serializeEvaluateArg(val[i], seen));
        }
        return `[${items.join(",")}]`;
      }
      const entries = Object.entries(val as Record<string, unknown>).map(
        ([k, v]) => `${JSON.stringify(k)}:${serializeEvaluateArg(v, seen)}`,
      );
      return `{${entries.join(",")}}`;
    } finally {
      seen.delete(val);
    }
  }
  return "undefined";
}

/**
 * Detect whether a JS snippet contains a top-level `return` keyword outside string literals,
 * template literals, comments, and nested blocks/parentheses. Prevents string literals like
 * `"Download the VAT return (file)"` inside serialized selectors from being mistaken for a
 * bare function body needing `(function(){ ... })()` wrapping.
 */
function hasTopLevelReturn(code: string): boolean {
  let depth = 0;
  const len = code.length;
  for (let i = 0; i < len; i++) {
    const ch = code[i]!;
    const next = i + 1 < len ? code[i + 1] : "";
    // Line comment
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < len && code[i] !== "\n") i++;
      continue;
    }
    // Block comment
    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < len && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i++;
      continue;
    }
    // Single, double, or template string literal
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < len) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === quote) break;
        i++;
      }
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0 && ch === "r" && code.startsWith("return", i)) {
      const before = i > 0 ? code[i - 1]! : "";
      const after = i + 6 < len ? code[i + 6]! : "";
      const isIdent = (c: string) => c.length > 0 && /[A-Za-z0-9_$]/.test(c);
      if (!isIdent(before) && !isIdent(after)) {
        return true;
      }
    }
  }
  return false;
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
    const serializedArgs = args.map((a) => serializeEvaluateArg(a)).join(", ");
    return `(${script.toString()})(${serializedArgs})`;
  }
  const trimmed = script.trim();
  if (hasTopLevelReturn(trimmed) && !trimmed.startsWith("(") && !trimmed.startsWith("async")) {
    const serializedArgs = args.map((a) => serializeEvaluateArg(a)).join(", ");
    return `(function(){ ${trimmed} })(${serializedArgs})`;
  }
  return script;
}

/**
 * Build a parent-realm JS expression that locates a same-origin `<iframe>` matching
 * `frameSelector` and invokes `script(contentDocument, contentWindow, ...args)` in the
 * parent realm — bypassing Chromium's `allow-scripts` block on `<iframe sandbox="allow-same-origin">`.
 */
export function buildDomFrameEvaluateScript(
  frameSelector: Selector,
  script: string | ((doc: any, win: any, ...args: any[]) => unknown),
  args: unknown[] = [],
): string {
  const serializedFrame = JSON.stringify(serializeSelectorForDom(frameSelector));
  const serializedArgs = args.map((a) => serializeEvaluateArg(a)).join(", ");
  const invoke =
    typeof script === "function"
      ? `(${script.toString()})(fDoc, fWin${serializedArgs ? `, ${serializedArgs}` : ""})`
      : `(function(document, window){ ${hasTopLevelReturn(script.trim()) ? script : `return (${script});`} })(fDoc, fWin)`;
  return `(function(frameSel) {
    ${SHARED_DOM_TRAVERSAL_HELPERS}
    var hits = findAcrossRoots(frameSel, "prefer");
    for (var i = 0; i < hits.length; i++) {
      var el = hits[i].el;
      if (el && el.tagName === "IFRAME") {
        var fDoc = null;
        var fWin = null;
        try { fDoc = el.contentDocument; fWin = el.contentWindow; } catch (e) {}
        if (fDoc && fDoc.documentElement) {
          return { __spanaFrameEvalOk: true, value: (${invoke}) };
        }
      }
    }
    return { __spanaFrameEvalOk: false };
  })(${serializedFrame})`;
}

/**
 * Convert a `Selector` (which may contain RegExp values in `name`, `hasText`, `hasNotText`,
 * and nested `within` / `frame` selectors) into a JSON-safe payload for remote DOM evaluation.
 */
export function serializeSelectorForDom(sel: unknown): unknown {
  if (sel instanceof RegExp) {
    return { __spanaRegex: sel.source, flags: sel.flags };
  }
  if (Array.isArray(sel)) {
    return sel.map((item) => serializeSelectorForDom(item));
  }
  if (sel && typeof sel === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sel as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = serializeSelectorForDom(v);
      }
    }
    return out;
  }
  return sel;
}

/**
 * Shared in-page helper snippet that recursively pierces open Shadow DOM
 * (`el.shadowRoot`, essential for Ionic/Capacitor `ion-button`/`ion-input`)
 * and accessible same-origin `<iframe>`s (accumulating top-level viewport
 * offsets so native tap coordinates remain pixel-accurate), and supports
 * full composable selectors (`role`+`name`, `css`, `within`, `frame`, `hasText`, `hasNotText`, `nth`/`first`/`last`).
 */
const SHARED_DOM_TRAVERSAL_HELPERS = `
  function normWs(val) {
    return String(val == null ? "" : val).replace(/[\\s\\u00a0\\u202f]+/g, " ").trim();
  }
  function matchSpec(actual, spec, exact) {
    var raw = String(actual || "");
    var str = normWs(raw);
    if (spec && typeof spec === "object" && typeof spec.__spanaRegex === "string") {
      try {
        var re = new RegExp(spec.__spanaRegex, spec.flags || "");
        return re.test(raw) || re.test(str);
      } catch (e) { return false; }
    }
    var needle = normWs(spec);
    if (exact) return str === needle;
    return str.toLowerCase().indexOf(needle.toLowerCase()) !== -1;
  }
  function isInsideSectioningContent(el) {
    var cur = el && el.parentElement;
    var guard = 0;
    while (cur && guard++ < 32) {
      var ptag = cur.tagName ? cur.tagName.toUpperCase() : "";
      if (ptag === "ARTICLE" || ptag === "ASIDE" || ptag === "MAIN" || ptag === "NAV" || ptag === "SECTION") {
        return true;
      }
      var prole = (cur.getAttribute && cur.getAttribute("role") || "").trim().toLowerCase().split(/\\s+/)[0] || "";
      if (prole === "article" || prole === "complementary" || prole === "main" || prole === "navigation" || prole === "region") {
        return true;
      }
      var root = typeof cur.getRootNode === "function" ? cur.getRootNode() : null;
      cur = cur.parentElement || (root && root.host) || null;
    }
    return false;
  }
  function getImplicitRole(el) {
    if (!el || !el.getAttribute) return "generic";
    var explicit = (el.getAttribute("role") || "").trim().toLowerCase();
    if (explicit) return explicit.split(/\\s+/)[0] || "generic";
    var tag = el.tagName ? el.tagName.toUpperCase() : "";
    if (tag === "BUTTON") return "button";
    if (tag === "A") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SELECT") return (el.hasAttribute("multiple") || Number(el.getAttribute("size") || 0) > 1) ? "listbox" : "combobox";
    if (tag === "OPTION") return "option";
    if (tag === "IMG") return el.getAttribute("alt") === "" ? "presentation" : "img";
    if (tag === "DIALOG") return "dialog";
    if (tag === "NAV") return "navigation";
    if (tag === "MAIN") return "main";
    if (tag === "HEADER") return isInsideSectioningContent(el) ? "generic" : "banner";
    if (tag === "FOOTER") return isInsideSectioningContent(el) ? "generic" : "contentinfo";
    if (tag === "ASIDE") return "complementary";
    if (tag === "UL" || tag === "OL") return "list";
    if (tag === "LI") return "listitem";
    if (tag === "TABLE") return "table";
    if (tag === "TR") return "row";
    if (tag === "TD") return "cell";
    if (tag === "TH") {
      var scope = (el.getAttribute("scope") || "").trim().toLowerCase();
      if (scope === "row" || scope === "rowgroup") return "rowheader";
      if (scope === "col" || scope === "colgroup") return "columnheader";
      var tr = el.parentElement;
      if (tr && tr.tagName && tr.tagName.toUpperCase() === "TR" && !(el.closest && el.closest("thead"))) {
        if (tr.querySelector && tr.querySelector("td")) return "rowheader";
      }
      return "columnheader";
    }
    if (tag === "ARTICLE") return "article";
    if (tag === "FORM") return "form";
    if (tag === "FIELDSET") return "group";
    if (tag === "FIGURE") return "figure";
    if (tag === "METER") return "meter";
    if (tag === "OUTPUT") return "status";
    if (tag === "P") return "paragraph";
    if (tag === "STRONG") return "strong";
    if (tag === "PROGRESS") return "progressbar";
    if (tag === "HR") return "separator";
    if (tag === "SECTION") {
      return (el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") || Boolean((el.getAttribute("title") || "").trim())) ? "region" : "generic";
    }
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "INPUT") {
      var t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "search") return el.hasAttribute("list") ? "combobox" : "searchbox";
      if (t === "number") return "spinbutton";
      if (t === "range") return "slider";
      if (t === "hidden") return "generic";
      return el.hasAttribute("list") ? "combobox" : "textbox";
    }
    return "generic";
  }
  var BLOCK_TAGS = {
    ADDRESS: 1, ARTICLE: 1, ASIDE: 1, BLOCKQUOTE: 1, BR: 1, DD: 1, DETAILS: 1,
    DIALOG: 1, DIV: 1, DL: 1, DT: 1, FIELDSET: 1, FIGCAPTION: 1, FIGURE: 1,
    FOOTER: 1, FORM: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, HEADER: 1,
    HGROUP: 1, HR: 1, LI: 1, MAIN: 1, NAV: 1, OL: 1, P: 1, PRE: 1, SECTION: 1,
    SUMMARY: 1, TABLE: 1, TD: 1, TH: 1, TR: 1, UL: 1,
  };
  function visibleTextOf(node, allowHiddenRoot, skipControl) {
    if (!node) return "";
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1 && node.nodeType !== 11) return "";
    if (node.nodeType === 1) {
      if (skipControl && node === skipControl) return "";
      var t = node.tagName ? node.tagName.toUpperCase() : "";
      if (t === "BR") return " ";
      if (t === "SCRIPT" || t === "STYLE" || t === "NOSCRIPT" || t === "TEMPLATE") return "";
      if (skipControl && (t === "SELECT" || t === "TEXTAREA" || t === "INPUT")) return "";
      if (t === "IMG") {
        var imgAlt = node.getAttribute && node.getAttribute("alt");
        return imgAlt ? normWs(imgAlt) : "";
      }
      if (t === "SVG") {
        var svgRole = (node.getAttribute && node.getAttribute("role") || "").trim().toLowerCase();
        var svgLabel = node.getAttribute && node.getAttribute("aria-label");
        if (svgLabel && svgLabel.trim()) return normWs(svgLabel);
        if (svgRole === "img") {
          var svgTitle = node.querySelector && node.querySelector("title");
          if (svgTitle && svgTitle.textContent) return normWs(svgTitle.textContent);
        }
      }
      if (!allowHiddenRoot) {
        if (node.getAttribute && node.getAttribute("aria-hidden") === "true") return "";
        var win = (node.ownerDocument && node.ownerDocument.defaultView) || window;
        if (win && win.getComputedStyle) {
          var st = win.getComputedStyle(node);
          if (st && (st.display === "none" || st.visibility === "hidden" || st.visibility === "collapse")) {
            return "";
          }
        }
      }
    }
    var out = [];
    if (node.shadowRoot) {
      var stxt = visibleTextOf(node.shadowRoot, false, skipControl);
      if (stxt) out.push(stxt);
    }
    var kids = node.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      var child = kids[i];
      var k = visibleTextOf(child, false, skipControl);
      if (!k) continue;
      var cTag = child && child.nodeType === 1 && child.tagName ? child.tagName.toUpperCase() : "";
      if (cTag && BLOCK_TAGS[cTag]) {
        out.push(" ", k, " ");
      } else {
        out.push(k);
      }
    }
    return normWs(out.join(""));
  }
  function ensureNetworkTracker() {
    if (typeof window === "undefined" || window.__spanaNetHooked) return;
    try {
      window.__spanaNetHooked = true;
      window.__spanaInflightNet = window.__spanaInflightNet || 0;
      window.__spanaLastNetEnd = window.__spanaLastNetEnd || 0;
      if (typeof window.fetch === "function") {
        var origFetch = window.fetch;
        window.fetch = function() {
          window.__spanaInflightNet = (window.__spanaInflightNet || 0) + 1;
          var done = false;
          var finish = function() {
            if (done) return;
            done = true;
            window.__spanaInflightNet = Math.max(0, (window.__spanaInflightNet || 1) - 1);
            window.__spanaLastNetEnd = Date.now();
          };
          try {
            var p = origFetch.apply(this, arguments);
            if (p && typeof p.then === "function") {
              p.then(finish, finish);
            } else {
              finish();
            }
            return p;
          } catch (e) {
            finish();
            throw e;
          }
        };
      }
      if (typeof XMLHttpRequest !== "undefined" && XMLHttpRequest.prototype && typeof XMLHttpRequest.prototype.send === "function") {
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function() {
          window.__spanaInflightNet = (window.__spanaInflightNet || 0) + 1;
          var done = false;
          var finish = function() {
            if (done) return;
            done = true;
            window.__spanaInflightNet = Math.max(0, (window.__spanaInflightNet || 1) - 1);
            window.__spanaLastNetEnd = Date.now();
          };
          try {
            this.addEventListener("loadend", finish, { once: true });
            return origSend.apply(this, arguments);
          } catch (e) {
            finish();
            throw e;
          }
        };
      }
    } catch (e) {}
  }
  ensureNetworkTracker();
  function hasInflightNetwork(quietMs) {
    if (typeof window === "undefined") return false;
    if ((window.__spanaInflightNet || 0) > 0) return true;
    var lastEnd = window.__spanaLastNetEnd || 0;
    if (lastEnd > 0 && Date.now() - lastEnd < Math.min(quietMs || 150, 150)) return true;
    return false;
  }
  function isVisiblyHiddenInAncestorChain(el) {
    if (!el) return true;
    var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var cur = el;
    var guard = 0;
    while (cur && guard++ < 48) {
      if (cur.nodeType === 1 && win && win.getComputedStyle) {
        var cs = win.getComputedStyle(cur);
        if (cs) {
          if (cs.display === "none") return true;
          if (cs.contentVisibility === "hidden") return true;
        }
      }
      var root = typeof cur.getRootNode === "function" ? cur.getRootNode() : null;
      cur = cur.parentElement || (root && root.host) || null;
    }
    if (el.nodeType === 1 && win && win.getComputedStyle) {
      var selfCs = win.getComputedStyle(el);
      if (selfCs && (selfCs.visibility === "hidden" || selfCs.visibility === "collapse")) return true;
    }
    return false;
  }
  function isHiddenInAncestorChain(el) {
    if (!el) return true;
    var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var cur = el;
    var guard = 0;
    while (cur && guard++ < 48) {
      if (cur.getAttribute) {
        if (cur.getAttribute("aria-hidden") === "true") return true;
      }
      if (cur.hasAttribute && cur.hasAttribute("inert")) return true;
      if (cur.nodeType === 1 && win && win.getComputedStyle) {
        var cs = win.getComputedStyle(cur);
        if (cs) {
          if (cs.display === "none") return true;
          if (cs.contentVisibility === "hidden") return true;
        }
      }
      var root = typeof cur.getRootNode === "function" ? cur.getRootNode() : null;
      cur = cur.parentElement || (root && root.host) || null;
    }
    if (el.nodeType === 1 && win && win.getComputedStyle) {
      var selfCs = win.getComputedStyle(el);
      if (selfCs && (selfCs.visibility === "hidden" || selfCs.visibility === "collapse")) return true;
    }
    return false;
  }
  function isAriaHidden(el) {
    if (el && el.tagName && el.tagName.toUpperCase() === "OPTION") {
      var parentSel = el.closest ? el.closest("select") : el.parentElement;
      if (parentSel) {
        return isHiddenInAncestorChain(parentSel);
      }
    }
    if (isHiddenInAncestorChain(el)) return true;
    if (el && el.nodeType === 1) {
      var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      var st = win && win.getComputedStyle ? win.getComputedStyle(el) : null;
      if (st && st.display === "contents") {
        return !hasVisibleDescendant(el, 0);
      }
    }
    return false;
  }
  function hasVisibleDescendant(el, depth) {
    if (!el || depth > 8) return false;
    var kids = el.children || [];
    for (var i = 0; i < kids.length; i++) {
      var child = kids[i];
      if (!child || child.nodeType !== 1) continue;
      var cr = child.getBoundingClientRect ? child.getBoundingClientRect() : { width: 0, height: 0 };
      if (isVisible(child, cr, depth + 1)) return true;
    }
    if (el.shadowRoot && el.shadowRoot.children) {
      var skids = el.shadowRoot.children;
      for (var j = 0; j < skids.length; j++) {
        var sc = skids[j];
        if (!sc || sc.nodeType !== 1) continue;
        var sr = sc.getBoundingClientRect ? sc.getBoundingClientRect() : { width: 0, height: 0 };
        if (isVisible(sc, sr, depth + 1)) return true;
      }
    }
    return false;
  }
  function getContentsUnionRect(el, depth) {
    if (!el || depth > 8) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var found = false;
    var visit = function(list) {
      for (var i = 0; i < list.length; i++) {
        var child = list[i];
        if (!child || child.nodeType !== 1) continue;
        var win = (child.ownerDocument && child.ownerDocument.defaultView) || window;
        var cst = win && win.getComputedStyle ? win.getComputedStyle(child) : null;
        if (cst && (cst.display === "none" || cst.visibility === "hidden" || cst.visibility === "collapse")) continue;
        var r = cst && cst.display === "contents"
          ? getContentsUnionRect(child, depth + 1)
          : (child.getBoundingClientRect ? child.getBoundingClientRect() : null);
        if (r && r.width > 0 && r.height > 0) {
          found = true;
          if (r.x < minX) minX = r.x;
          if (r.y < minY) minY = r.y;
          if (r.x + r.width > maxX) maxX = r.x + r.width;
          if (r.y + r.height > maxY) maxY = r.y + r.height;
        }
      }
    };
    if (el.children) visit(el.children);
    if (el.shadowRoot && el.shadowRoot.children) visit(el.shadowRoot.children);
    if (!found) return null;
    return { x: minX, y: minY, left: minX, top: minY, width: maxX - minX, height: maxY - minY, right: maxX, bottom: maxY };
  }
  function headingLevelOf(el) {
    if (!el) return null;
    var explicit = el.getAttribute && el.getAttribute("aria-level");
    if (explicit) {
      var parsed = parseInt(explicit, 10);
      if (!isNaN(parsed)) return parsed;
    }
    var tag = el.tagName ? el.tagName.toUpperCase() : "";
    var m = /^H([1-6])$/.exec(tag);
    return m ? parseInt(m[1], 10) : null;
  }
  function getAccessibleName(el) {
    if (!el) return "";
    var doc = el.ownerDocument || document;
    var labelledBy = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelledBy) {
      var parts = [];
      var ids = labelledBy.trim().split(/\\s+/);
      for (var i = 0; i < ids.length; i++) {
        var ref = doc.getElementById ? doc.getElementById(ids[i]) : null;
        if (ref) {
          var rt = visibleTextOf(ref, true, null);
          if (rt) parts.push(rt);
        }
      }
      if (parts.length > 0) return parts.join(" ").replace(/\\s+/g, " ").trim();
    }
    var ariaLabel = el.getAttribute && el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
    var tag = el.tagName ? el.tagName.toUpperCase() : "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      if (el.id && doc.querySelector) {
        try {
          var escId = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(el.id) : el.id;
          var forLbl = doc.querySelector('label[for="' + escId + '"]');
          if (forLbl) {
            var ft = visibleTextOf(forLbl, false, el);
            if (ft) return ft;
          }
        } catch (e) {}
      }
      if (el.closest) {
        var wrapLbl = el.closest("label");
        if (wrapLbl) {
          var wt = visibleTextOf(wrapLbl, false, el);
          if (wt) return wt;
        }
      }
      var itype = tag === "INPUT" ? (el.getAttribute("type") || "text").toLowerCase() : "";
      if ((itype === "button" || itype === "submit" || itype === "reset") && el.value) {
        return String(el.value).trim();
      }
      var ph = el.getAttribute && el.getAttribute("placeholder");
      if (ph && ph.trim()) return ph.trim();
    }
    if (tag === "IMG") {
      var alt = el.getAttribute && el.getAttribute("alt");
      if (alt && alt.trim()) return alt.trim();
    }
    if (tag === "FIELDSET") {
      var fkids = el.children || [];
      for (var fi = 0; fi < fkids.length; fi++) {
        var fk = fkids[fi];
        if (fk && fk.tagName && fk.tagName.toUpperCase() === "LEGEND") {
          var ltxt = visibleTextOf(fk, false, null);
          if (ltxt) return ltxt;
          break;
        }
      }
    }
    if (tag === "TABLE") {
      var tkids = el.children || [];
      for (var ti = 0; ti < tkids.length; ti++) {
        var tk = tkids[ti];
        if (tk && tk.tagName && tk.tagName.toUpperCase() === "CAPTION") {
          var ctxt = visibleTextOf(tk, false, null);
          if (ctxt) return ctxt;
          break;
        }
      }
    }
    if (tag === "FIGURE") {
      var fgkids = el.children || [];
      for (var fgi = 0; fgi < fgkids.length; fgi++) {
        var fgk = fgkids[fgi];
        if (fgk && fgk.tagName && fgk.tagName.toUpperCase() === "FIGCAPTION") {
          var fgtxt = visibleTextOf(fgk, false, null);
          if (fgtxt) return fgtxt;
          break;
        }
      }
    }
    var role = getImplicitRole(el);
    var nameFromAuthorOnly = {
      list: 1, navigation: 1, main: 1, region: 1, form: 1, dialog: 1, alertdialog: 1,
      table: 1, grid: 1, tablist: 1, tabpanel: 1, menu: 1, menubar: 1, toolbar: 1,
      tree: 1, group: 1, radiogroup: 1, feed: 1, article: 1, banner: 1, complementary: 1,
      contentinfo: 1, search: 1, combobox: 1, listbox: 1, log: 1, marquee: 1, status: 1,
      timer: 1, alert: 1, application: 1, document: 1, directory: 1, figure: 1, img: 1,
      math: 1, meter: 1, progressbar: 1, scrollbar: 1, separator: 1, slider: 1,
      spinbutton: 1, textbox: 1, searchbox: 1,
    };
    if (role && nameFromAuthorOnly[role]) {
      var authorTitle = el.getAttribute && el.getAttribute("title");
      return authorTitle ? authorTitle.trim() : "";
    }
    var txt = visibleTextOf(el, false, null);
    if (txt) return txt;
    var title = el.getAttribute && el.getAttribute("title");
    return title ? title.trim() : "";
  }
  function getAccessibleDescription(el) {
    if (!el) return "";
    var doc = el.ownerDocument || document;
    var describedBy = el.getAttribute && el.getAttribute("aria-describedby");
    if (describedBy) {
      var parts = [];
      var ids = describedBy.trim().split(/\\s+/);
      for (var i = 0; i < ids.length; i++) {
        var ref = doc.getElementById ? doc.getElementById(ids[i]) : null;
        if (ref) {
          var rt = visibleTextOf(ref, true, null);
          if (rt) parts.push(rt);
        }
      }
      if (parts.length > 0) return parts.join(" ").replace(/\\s+/g, " ").trim();
    }
    var ariaDesc = el.getAttribute && el.getAttribute("aria-description");
    if (ariaDesc && ariaDesc.trim()) return ariaDesc.trim();
    var title = el.getAttribute && el.getAttribute("title");
    if (title && title.trim()) {
      var accName = getAccessibleName(el);
      if (accName && accName !== title.trim()) return title.trim();
    }
    return "";
  }
  function getIframeTransform(frameEl) {
    var fr = frameEl.getBoundingClientRect();
    var fwin = (frameEl.ownerDocument && frameEl.ownerDocument.defaultView) || window;
    var fcs = fwin && fwin.getComputedStyle ? fwin.getComputedStyle(frameEl) : null;
    var bLeft = fcs ? (parseFloat(fcs.borderLeftWidth) || 0) : 0;
    var bTop = fcs ? (parseFloat(fcs.borderTopWidth) || 0) : 0;
    var bRight = fcs ? (parseFloat(fcs.borderRightWidth) || 0) : 0;
    var bBottom = fcs ? (parseFloat(fcs.borderBottomWidth) || 0) : 0;
    var layoutW = frameEl.offsetWidth || (frameEl.clientWidth + bLeft + bRight);
    var layoutH = frameEl.offsetHeight || (frameEl.clientHeight + bTop + bBottom);
    var sx = layoutW > 0 ? (fr.width / layoutW) : 1;
    var sy = layoutH > 0 ? (fr.height / layoutH) : 1;
    if (!isFinite(sx) || sx <= 0) sx = 1;
    if (!isFinite(sy) || sy <= 0) sy = 1;
    return { left: fr.left + bLeft * sx, top: fr.top + bTop * sy, scaleX: sx, scaleY: sy };
  }
  function collectRoots(root, offsetX, offsetY, scaleX, scaleY, inShadow, inIframe, out) {
    if (!root) return;
    out.push({ root: root, offsetX: offsetX, offsetY: offsetY, scaleX: scaleX, scaleY: scaleY, inShadow: inShadow, inIframe: inIframe });
    if (root.shadowRoot) {
      collectRoots(root.shadowRoot, offsetX, offsetY, scaleX, scaleY, true, inIframe, out);
    }
    var nodes = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.shadowRoot) {
        collectRoots(el.shadowRoot, offsetX, offsetY, scaleX, scaleY, true, inIframe, out);
      }
      if (el.tagName === "IFRAME") {
        try {
          var frameDoc = el.contentDocument;
          if (frameDoc) {
            var ft = getIframeTransform(el);
            collectRoots(
              frameDoc,
              offsetX + ft.left * scaleX,
              offsetY + ft.top * scaleY,
              scaleX * ft.scaleX,
              scaleY * ft.scaleY,
              inShadow,
              true,
              out
            );
          }
        } catch (e) {}
      }
    }
  }
  function findTextInRoot(root, needle, exact, ctx, pushHit) {
    if (!root) return;
    var isRegex = Boolean(needle && typeof needle === "object" && typeof needle.__spanaRegex === "string");
    var rawNeedleStr = isRegex ? "" : String(needle == null ? "" : needle);
    var trimmedNeedle = normWs(rawNeedleStr);
    var lowerNeedle = trimmedNeedle.toLowerCase();
    if (!isRegex && !trimmedNeedle) return;

    var skipTags = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1, TITLE: 1 };

    // Button-like <input> elements store their label in .value (not ancestor .textContent),
    // so check them directly before textContent-based subtree pruning.
    if (root.querySelectorAll) {
      var btnInputs = root.querySelectorAll('input[type="button"], input[type="submit"], input[type="reset"]');
      for (var bi = 0; bi < btnInputs.length; bi++) {
        var bNode = btnInputs[bi];
        var bVal = normWs(bNode.value || "");
        if (bVal && matchSpec(bVal, needle, exact)) {
          pushHit(bNode, ctx);
        }
      }
    }

    function visitNode(node) {
      if (!node || node.nodeType !== 1) return false;
      var tag = node.tagName ? node.tagName.toUpperCase() : "";
      if (skipTags[tag] || tag === "INPUT") return false;

      var normText = normWs(node.textContent || "");
      if (!isRegex) {
        if (!normText) return false;
        if (exact) {
          if (normText.indexOf(trimmedNeedle) === -1) return false;
        } else {
          if (normText.toLowerCase().indexOf(lowerNeedle) === -1) return false;
        }
      }

      var childMatched = false;
      var kids = node.children || [];
      for (var i = 0; i < kids.length; i++) {
        if (visitNode(kids[i])) childMatched = true;
      }
      if (childMatched) return true;

      if (normText && matchSpec(normText, needle, exact)) {
        pushHit(node, ctx);
        return true;
      }
      return false;
    }

    if (root.nodeType === 9) {
      var startEl = root.body || root.documentElement;
      if (startEl) visitNode(startEl);
      return;
    }
    if (root.nodeType === 11) {
      var fragKids = root.children || [];
      for (var fi = 0; fi < fragKids.length; fi++) visitNode(fragKids[fi]);
      return;
    }
    visitNode(root);
  }
  function findRoleInRoot(root, roleLower, nameSpec, exact, ctx, pushHit, includeHidden, level, pressed) {
    if (!root || !root.querySelectorAll) return;
    var candidates = root.querySelectorAll("*");
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (getImplicitRole(el) !== roleLower) continue;
      if (!includeHidden && isAriaHidden(el)) continue;
      if (level !== undefined && level !== null && headingLevelOf(el) !== Number(level)) continue;
      if (pressed !== undefined && pressed !== null) {
        var ap = (el.getAttribute && el.getAttribute("aria-pressed") || "").trim().toLowerCase();
        if (pressed ? ap !== "true" : ap !== "false") continue;
      }
      if (nameSpec !== undefined && nameSpec !== null) {
        var accName = getAccessibleName(el);
        if (!matchSpec(accName, nameSpec, Boolean(exact))) continue;
      }
      pushHit(el, ctx);
    }
  }
  function isHitVisible(h) {
    if (!h) return false;
    if (h.wasmNode) {
      return h.wasmNode.visible !== false && h.wasmRect && h.wasmRect.width > 0 && h.wasmRect.height > 0;
    }
    if (!h.el || !h.el.getBoundingClientRect) return false;
    return isVisible(h.el, h.el.getBoundingClientRect());
  }
  function applyModifiersAndSlice(hits, sel, preferVisible) {
    if (!sel || typeof sel !== "object" || "point" in sel) return hits;
    var filtered = hits;
    if (sel.hasText !== undefined) {
      filtered = filtered.filter(function(h) {
        var normTc = normWs(h.el.textContent || "");
        var innerT = normWs(h.el.innerText || "");
        var fallbackTxt = normWs(h.el.value || getAccessibleName(h.el) || "");
        return matchSpec(normTc, sel.hasText, false) || matchSpec(innerT, sel.hasText, false) || matchSpec(fallbackTxt, sel.hasText, false);
      });
    }
    if (sel.hasNotText !== undefined) {
      filtered = filtered.filter(function(h) {
        var normTc = normWs(h.el.textContent || "");
        var innerT = normWs(h.el.innerText || "");
        var fallbackTxt = normWs(h.el.value || getAccessibleName(h.el) || "");
        return !matchSpec(normTc, sel.hasNotText, false) && !matchSpec(innerT, sel.hasNotText, false) && !matchSpec(fallbackTxt, sel.hasNotText, false);
      });
    }
    if (sel.has !== undefined) {
      filtered = filtered.filter(function(h) {
        return findInScope(sel.has, h.el, h.offsetX, h.offsetY, h.scaleX, h.scaleY, h.inShadow, h.inIframe, preferVisible).length > 0;
      });
    }
    if (sel.hasNot !== undefined) {
      filtered = filtered.filter(function(h) {
        return findInScope(sel.hasNot, h.el, h.offsetX, h.offsetY, h.scaleX, h.scaleY, h.inShadow, h.inIframe, preferVisible).length === 0;
      });
    }
    var wantsSlice = Boolean(sel.first || sel.last || typeof sel.nth === "number");
    if (wantsSlice && !sel.includeHidden && preferVisible) {
      var visibleFiltered = filtered.filter(isHitVisible);
      if (preferVisible === "strict" || visibleFiltered.length > 0) {
        filtered = visibleFiltered;
      }
    }
    if (sel.first) return filtered.length > 0 ? [filtered[0]] : [];
    if (sel.last) return filtered.length > 0 ? [filtered[filtered.length - 1]] : [];
    if (typeof sel.nth === "number") {
      var idx = sel.nth < 0 ? filtered.length + sel.nth : sel.nth;
      return idx >= 0 && idx < filtered.length ? [filtered[idx]] : [];
    }
    return filtered;
  }
  function findInScope(sel, scopeRoot, baseOffsetX, baseOffsetY, baseScaleX, baseScaleY, baseInShadow, baseInIframe, preferVisible) {
    var hits = [];
    var seen = typeof Set !== "undefined" ? new Set() : null;
    function pushHit(el, ctx) {
      if (seen) {
        if (seen.has(el)) return;
        seen.add(el);
      }
      hits.push({
        el: el,
        offsetX: ctx.offsetX,
        offsetY: ctx.offsetY,
        scaleX: ctx.scaleX != null ? ctx.scaleX : 1,
        scaleY: ctx.scaleY != null ? ctx.scaleY : 1,
        inShadow: ctx.inShadow,
        inIframe: ctx.inIframe
      });
    }
    if (typeof sel === "object" && sel !== null && "point" in sel) {
      var atPt = document.elementFromPoint(sel.point.x, sel.point.y);
      if (atPt) pushHit(atPt, { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, inShadow: false, inIframe: false });
      return hits;
    }
    // Frame scoping: find matching <iframe> first, then search inside its contentDocument
    if (typeof sel === "object" && sel !== null && sel.frame) {
      var frameHits = findInScope(sel.frame, scopeRoot, baseOffsetX, baseOffsetY, baseScaleX, baseScaleY, baseInShadow, baseInIframe, preferVisible);
      var innerSel = Object.assign({}, sel);
      delete innerSel.frame;
      for (var fi = 0; fi < frameHits.length; fi++) {
        var fEl = frameHits[fi].el;
        if (fEl && fEl.tagName === "IFRAME") {
          try {
            var fDoc = fEl.contentDocument;
            if (fDoc) {
              var fTr = getIframeTransform(fEl);
              var pSx = frameHits[fi].scaleX != null ? frameHits[fi].scaleX : 1;
              var pSy = frameHits[fi].scaleY != null ? frameHits[fi].scaleY : 1;
              var sub = findInScope(
                innerSel,
                fDoc,
                frameHits[fi].offsetX + fTr.left * pSx,
                frameHits[fi].offsetY + fTr.top * pSy,
                pSx * fTr.scaleX,
                pSy * fTr.scaleY,
                frameHits[fi].inShadow,
                true,
                preferVisible
              );
              for (var si = 0; si < sub.length; si++) pushHit(sub[si].el, sub[si]);
            }
          } catch (e) {}
        }
      }
      return hits;
    }
    // Parent scoping: resolve 'within' first, then search inside each matched container
    if (typeof sel === "object" && sel !== null && sel.within) {
      var parentHits = findInScope(sel.within, scopeRoot, baseOffsetX, baseOffsetY, baseScaleX, baseScaleY, baseInShadow, baseInIframe, preferVisible);
      var childSel = Object.assign({}, sel);
      delete childSel.within;
      delete childSel.hasText;
      delete childSel.hasNotText;
      delete childSel.has;
      delete childSel.hasNot;
      delete childSel.first;
      delete childSel.last;
      delete childSel.nth;
      var combined = [];
      var cSeen = typeof Set !== "undefined" ? new Set() : null;
      for (var pi = 0; pi < parentHits.length; pi++) {
        var ph = parentHits[pi];
        var subHits = findInScope(childSel, ph.el, ph.offsetX, ph.offsetY, ph.scaleX, ph.scaleY, ph.inShadow, ph.inIframe, preferVisible);
        for (var ci = 0; ci < subHits.length; ci++) {
          if (cSeen && cSeen.has(subHits[ci].el)) continue;
          if (cSeen) cSeen.add(subHits[ci].el);
          combined.push(subHits[ci]);
        }
      }
      return applyModifiersAndSlice(combined, sel, preferVisible);
    }
    // Logical OR composition (anyOf): union deduplicated hits across branches
    if (typeof sel === "object" && sel !== null && Array.isArray(sel.anyOf)) {
      for (var bi = 0; bi < sel.anyOf.length; bi++) {
        var branchHits = findInScope(sel.anyOf[bi], scopeRoot, baseOffsetX, baseOffsetY, baseScaleX, baseScaleY, baseInShadow, baseInIframe, preferVisible);
        for (var bh = 0; bh < branchHits.length; bh++) {
          pushHit(branchHits[bh].el, branchHits[bh]);
        }
      }
      return applyModifiersAndSlice(hits, sel, preferVisible);
    }
    // Logical AND composition (allOf): intersection of matched elements across branches
    if (typeof sel === "object" && sel !== null && Array.isArray(sel.allOf) && sel.allOf.length > 0) {
      var firstBranch = findInScope(sel.allOf[0], scopeRoot, baseOffsetX, baseOffsetY, baseScaleX, baseScaleY, baseInShadow, baseInIframe, preferVisible);
      var currentHits = firstBranch;
      for (var ai = 1; ai < sel.allOf.length && currentHits.length > 0; ai++) {
        var nextBranch = findInScope(sel.allOf[ai], scopeRoot, baseOffsetX, baseOffsetY, baseScaleX, baseScaleY, baseInShadow, baseInIframe, preferVisible);
        var nextEls = typeof Set !== "undefined" ? new Set(nextBranch.map(function(h) { return h.el; })) : null;
        currentHits = currentHits.filter(function(h) {
          if (nextEls) return nextEls.has(h.el);
          return nextBranch.some(function(nh) { return nh.el === h.el; });
        });
      }
      for (var ahi = 0; ahi < currentHits.length; ahi++) pushHit(currentHits[ahi].el, currentHits[ahi]);
      return applyModifiersAndSlice(hits, sel, preferVisible);
    }

    function queryCssSafe(root, cssStr) {
      try {
        return root.querySelectorAll(cssStr);
      } catch (e) {
        var hint = "";
        if (/:has-text\\(/.test(cssStr)) hint = " (Playwright :has-text() is not valid CSS; use { ..., hasText: ... } instead)";
        else if (cssStr.indexOf(">>") !== -1) hint = " (Playwright >> chaining is not valid CSS; use within(parent, child) instead)";
        else if (/\\bnth=/.test(cssStr)) hint = " (Playwright nth= is not valid CSS; use { ..., nth: index } instead)";
        throw new Error('Invalid CSS selector "' + cssStr + '": ' + (e && e.message ? e.message : String(e)) + hint);
      }
    }
    function findByLabelInRoot(root, spec, exact, ctx, push) {
      if (!root || !root.querySelectorAll) return;
      var seen = new Set();
      var addCtrl = function(c) {
        if (!c || seen.has(c)) return;
        if (c.tagName === "INPUT" && (c.getAttribute("type") || "").toLowerCase() === "hidden") return;
        seen.add(c);
        push(c, ctx);
      };
      // 1. Explicit <label> elements (associated via .control, [for], or nested labelable control)
      var labels = root.querySelectorAll("label");
      for (var lb = 0; lb < labels.length; lb++) {
        var lblEl = labels[lb];
        var ctrlFromLbl = lblEl.control || null;
        if (!ctrlFromLbl && lblEl.getAttribute) {
          var forAttr = lblEl.getAttribute("for");
          if (forAttr) {
            var lblRoot = typeof lblEl.getRootNode === "function" ? lblEl.getRootNode() : null;
            if (lblRoot && typeof lblRoot.getElementById === "function") {
              ctrlFromLbl = lblRoot.getElementById(forAttr);
            }
            if (!ctrlFromLbl) {
              var lblDoc = lblEl.ownerDocument || document;
              ctrlFromLbl = lblDoc.getElementById ? lblDoc.getElementById(forAttr) : null;
            }
            if (!ctrlFromLbl && root.querySelector) {
              try {
                var escFor = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(forAttr) : forAttr;
                ctrlFromLbl = root.querySelector('[id="' + escFor + '"]');
              } catch (e) {}
            }
          }
        }
        if (!ctrlFromLbl && lblEl.querySelector) {
          ctrlFromLbl = lblEl.querySelector("input:not([type=hidden]), textarea, select, meter, output, progress");
        }
        if (!ctrlFromLbl) continue;
        var rawLblText = visibleTextOf(lblEl, false, ctrlFromLbl) || normWs(lblEl.textContent || "");
        var fullLblText = !lblEl.contains(ctrlFromLbl) ? normWs(lblEl.textContent || "") : "";
        if (
          (rawLblText && matchSpec(rawLblText, spec, exact)) ||
          (fullLblText && matchSpec(fullLblText, spec, exact))
        ) {
          addCtrl(ctrlFromLbl);
        }
      }
      // 2. Labelable form controls & ARIA form widgets (never match <button> by its inner text)
      var labelableRoles = {
        textbox: 1, searchbox: 1, combobox: 1, listbox: 1, spinbutton: 1,
        slider: 1, checkbox: 1, radio: 1, switch: 1,
      };
      var controls = root.querySelectorAll("input, textarea, select, meter, output, progress, audio, video, [contenteditable], [aria-label], [aria-labelledby]");
      for (var li = 0; li < controls.length; li++) {
        var ctrl = controls[li];
        if (seen.has(ctrl)) continue;
        if (ctrl.tagName === "INPUT" && (ctrl.getAttribute("type") || "").toLowerCase() === "hidden") continue;
        var tag = ctrl.tagName ? ctrl.tagName.toUpperCase() : "";
        var isFormControl =
          tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
          tag === "METER" || tag === "OUTPUT" || tag === "PROGRESS" ||
          tag === "AUDIO" || tag === "VIDEO" ||
          (ctrl.hasAttribute && ctrl.hasAttribute("contenteditable"));
        var role = getImplicitRole(ctrl);
        if (!isFormControl && !labelableRoles[role]) continue;
        var labelText = getAccessibleName(ctrl);
        if (!labelText && ctrl.labels && ctrl.labels.length > 0) {
          var parts = [];
          for (var lj = 0; lj < ctrl.labels.length; lj++) {
            parts.push((ctrl.labels[lj].textContent || "").trim());
          }
          labelText = parts.join(" ").trim();
        }
        if (labelText && matchSpec(labelText, spec, exact)) {
          addCtrl(ctrl);
        }
      }
    }
    function findByAttrSpecInRoot(root, attrName, spec, exact, ctx, push) {
      if (!root || !root.querySelectorAll) return;
      var nodes = root.querySelectorAll("[" + attrName + "]");
      for (var ni = 0; ni < nodes.length; ni++) {
        var val = nodes[ni].getAttribute(attrName);
        if (val !== null && matchSpec(val, spec, exact)) {
          push(nodes[ni], ctx);
        }
      }
    }

    var esc = function(v) {
      return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : String(v).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"');
    };
    var mainCtx = { root: scopeRoot, offsetX: baseOffsetX, offsetY: baseOffsetY, scaleX: baseScaleX, scaleY: baseScaleY, inShadow: baseInShadow, inIframe: baseInIframe };
    var hasModifiers = typeof sel === "object" && sel !== null && (sel.hasText !== undefined || sel.hasNotText !== undefined || sel.has !== undefined || sel.hasNot !== undefined || sel.first || sel.last || typeof sel.nth === "number");

    // O(1)-ish Light-DOM fast path: avoids scanning thousands of nodes with querySelectorAll("*")
    // unless Shadow DOM / iframe piercing is needed or no Light-DOM match exists.
    if (scopeRoot && scopeRoot.querySelectorAll && !hasModifiers) {
      if (typeof sel === "object" && sel !== null && "testID" in sel) {
        var fastTid = esc(sel.testID);
        var fastFound = scopeRoot.querySelectorAll('[data-testid="' + fastTid + '"], [testID="' + fastTid + '"]');
        if (fastFound.length > 0) {
          for (var fi2 = 0; fi2 < fastFound.length; fi2++) pushHit(fastFound[fi2], mainCtx);
          return hits;
        }
      } else if (typeof sel === "object" && sel !== null && "css" in sel) {
        var fastCss = queryCssSafe(scopeRoot, sel.css);
        if (fastCss.length > 0) {
          for (var fc = 0; fc < fastCss.length; fc++) pushHit(fastCss[fc], mainCtx);
          return hits;
        }
      } else if (typeof sel === "object" && sel !== null && "accessibilityLabel" in sel) {
        var fastLbl = esc(sel.accessibilityLabel);
        var fastFoundLbl = scopeRoot.querySelectorAll('[aria-label="' + fastLbl + '"]');
        if (fastFoundLbl.length > 0) {
          for (var fj = 0; fj < fastFoundLbl.length; fj++) pushHit(fastFoundLbl[fj], mainCtx);
          return hits;
        }
      } else if (typeof sel === "object" && sel !== null && "label" in sel) {
        findByLabelInRoot(scopeRoot, sel.label, Boolean(sel.exact), mainCtx, pushHit);
        if (hits.length > 0) return hits;
      } else if (typeof sel === "object" && sel !== null && "placeholder" in sel) {
        findByAttrSpecInRoot(scopeRoot, "placeholder", sel.placeholder, Boolean(sel.exact), mainCtx, pushHit);
        if (hits.length > 0) return hits;
      } else if (typeof sel === "object" && sel !== null && "altText" in sel) {
        findByAttrSpecInRoot(scopeRoot, "alt", sel.altText, Boolean(sel.exact), mainCtx, pushHit);
        if (hits.length > 0) return hits;
      } else if (typeof sel === "object" && sel !== null && "title" in sel) {
        findByAttrSpecInRoot(scopeRoot, "title", sel.title, Boolean(sel.exact), mainCtx, pushHit);
        if (hits.length > 0) return hits;
      } else if (typeof sel === "object" && sel !== null && "role" in sel) {
        findRoleInRoot(scopeRoot, String(sel.role).toLowerCase(), sel.name, sel.exact, mainCtx, pushHit, sel.includeHidden, sel.level, sel.pressed);
        if (hits.length > 0) return hits;
      } else if (typeof sel === "string" || (typeof sel === "object" && sel !== null && "text" in sel)) {
        var fastNeedle = typeof sel === "string" ? sel : sel.text;
        var fastExact = typeof sel === "object" && sel !== null && Boolean(sel.exact);
        findTextInRoot(scopeRoot, fastNeedle, fastExact, mainCtx, pushHit);
        if (hits.length > 0) return hits;
      }
    }

    var roots = [];
    collectRoots(scopeRoot, baseOffsetX, baseOffsetY, baseScaleX, baseScaleY, baseInShadow, baseInIframe, roots);
    for (var r = 0; r < roots.length; r++) {
      var ctx = roots[r];
      var root = ctx.root;
      if (!root || !root.querySelectorAll) continue;
      if (typeof sel === "object" && sel !== null && "testID" in sel) {
        var tid = esc(sel.testID);
        var found = root.querySelectorAll('[data-testid="' + tid + '"], [testID="' + tid + '"]');
        for (var i = 0; i < found.length; i++) pushHit(found[i], ctx);
      } else if (typeof sel === "object" && sel !== null && "css" in sel) {
        var foundCss = queryCssSafe(root, sel.css);
        for (var ci2 = 0; ci2 < foundCss.length; ci2++) pushHit(foundCss[ci2], ctx);
      } else if (typeof sel === "object" && sel !== null && "accessibilityLabel" in sel) {
        var lbl = esc(sel.accessibilityLabel);
        var foundLbl = root.querySelectorAll('[aria-label="' + lbl + '"]');
        for (var j = 0; j < foundLbl.length; j++) pushHit(foundLbl[j], ctx);
      } else if (typeof sel === "object" && sel !== null && "label" in sel) {
        findByLabelInRoot(root, sel.label, Boolean(sel.exact), ctx, pushHit);
      } else if (typeof sel === "object" && sel !== null && "placeholder" in sel) {
        findByAttrSpecInRoot(root, "placeholder", sel.placeholder, Boolean(sel.exact), ctx, pushHit);
      } else if (typeof sel === "object" && sel !== null && "altText" in sel) {
        findByAttrSpecInRoot(root, "alt", sel.altText, Boolean(sel.exact), ctx, pushHit);
      } else if (typeof sel === "object" && sel !== null && "title" in sel) {
        findByAttrSpecInRoot(root, "title", sel.title, Boolean(sel.exact), ctx, pushHit);
      } else if (typeof sel === "object" && sel !== null && "role" in sel) {
        findRoleInRoot(root, String(sel.role).toLowerCase(), sel.name, sel.exact, ctx, pushHit, sel.includeHidden, sel.level, sel.pressed);
      } else if (typeof sel === "string" || (typeof sel === "object" && sel !== null && "text" in sel)) {
        var needle = typeof sel === "string" ? sel : sel.text;
        var isExact = typeof sel === "object" && sel !== null && Boolean(sel.exact);
        findTextInRoot(root, needle, isExact, ctx, pushHit);
      }
    }
    return applyModifiersAndSlice(hits, sel, preferVisible);
  }
  function findWasmSemanticHits(sel) {
    if (typeof window === "undefined" || !window.__SPANA_WASM_TREE__) return [];
    var provider = window.__SPANA_WASM_TREE__;
    var nodes;
    try { nodes = typeof provider === "function" ? provider() : provider; } catch (e) { return []; }
    if (!Array.isArray(nodes) || nodes.length === 0) return [];
    var matched = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n || typeof n !== "object" || !n.bounds) continue;
      var nid = n.testID || n.id || "";
      var ntext = String(n.text != null ? n.text : (n.label != null ? n.label : ""));
      var nlabel = String(n.label != null ? n.label : "");
      var nrole = String(n.role || "");
      var ok = false;
      if (typeof sel === "string") {
        ok = nid === sel || ntext === sel;
      } else if (sel && typeof sel === "object") {
        if (sel.testID !== undefined) {
          ok = nid === sel.testID;
        } else if (sel.text !== undefined) {
          ok = sel.exact ? ntext.trim() === String(sel.text).trim() : ntext.indexOf(String(sel.text)) !== -1;
        } else if (sel.accessibilityLabel !== undefined) {
          ok = nlabel === sel.accessibilityLabel || ntext === sel.accessibilityLabel;
        } else if (sel.role !== undefined) {
          var rOk = nrole.toLowerCase() === String(sel.role).toLowerCase();
          var nameOk = true;
          if (sel.name !== undefined) {
            if (typeof sel.name === "object" && sel.name && sel.name.__regex) {
              var re = new RegExp(sel.name.source, sel.name.flags || "");
              nameOk = re.test(ntext) || re.test(nlabel);
            } else {
              var exp = String(sel.name);
              nameOk = sel.exact
                ? (ntext.trim() === exp.trim() || nlabel.trim() === exp.trim())
                : (ntext.toLowerCase().indexOf(exp.toLowerCase()) !== -1 || nlabel.toLowerCase().indexOf(exp.toLowerCase()) !== -1);
            }
          }
          ok = rOk && nameOk;
        }
      }
      if (!ok) continue;
      var ox = 0;
      var oy = 0;
      var hostEl = null;
      if (n.canvasSelector && typeof document !== "undefined" && document.querySelector) {
        try {
          hostEl = document.querySelector(n.canvasSelector);
          if (hostEl && typeof hostEl.getBoundingClientRect === "function") {
            var cr = hostEl.getBoundingClientRect();
            ox = cr.left || 0;
            oy = cr.top || 0;
          }
        } catch (e) {}
      }
      var bx = (n.bounds.x || 0) + ox;
      var by = (n.bounds.y || 0) + oy;
      var bw = n.bounds.width || 0;
      var bh = n.bounds.height || 0;
      var vRect = { left: bx, top: by, x: bx, y: by, width: bw, height: bh, right: bx + bw, bottom: by + bh };
      var virtualEl = {
        isConnected: true,
        tagName: "WASM-NODE",
        innerText: ntext,
        textContent: ntext,
        value: n.value,
        __spanaHostCanvas: hostEl,
        getBoundingClientRect: function() { return vRect; },
        getAttribute: function(k) {
          if (k === "data-testid" || k === "testID") return nid || null;
          if (k === "role") return nrole || null;
          if (k === "aria-label") return nlabel || null;
          return (n.attributes && n.attributes[k]) || null;
        },
        hasAttribute: function(k) { return this.getAttribute(k) !== null; }
      };
      matched.push({ el: virtualEl, offsetX: 0, offsetY: 0, inShadow: false, inIframe: false, wasmNode: n, wasmRect: vRect });
    }
    return matched;
  }
  function findAcrossRoots(sel, preferVisible) {
    var pv = preferVisible === undefined ? "prefer" : preferVisible;
    var domHits = findInScope(sel, document, 0, 0, 1, 1, false, false, pv);
    var wasmHits = findWasmSemanticHits(sel);
    if (wasmHits.length === 0) return domHits;
    return domHits.length === 0 ? wasmHits : domHits.concat(wasmHits);
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
  function isAppReady() {
    var sig = typeof window !== "undefined" ? window.__SPANA_APP_READY__ : undefined;
    if (typeof sig === "function") {
      try { return Boolean(sig()); } catch (e) { return false; }
    }
    if (typeof sig === "boolean") return sig;
    return true;
  }
  function deepElementFromPoint(rootDoc, x, y) {
    if (!rootDoc || typeof rootDoc.elementFromPoint !== "function") return null;
    var el = rootDoc.elementFromPoint(x, y);
    var guard = 0;
    while (el && guard++ < 16) {
      if (el.shadowRoot && typeof el.shadowRoot.elementFromPoint === "function") {
        var inner = el.shadowRoot.elementFromPoint(x, y);
        if (inner && inner !== el) { el = inner; continue; }
      }
      if (el.tagName === "IFRAME") {
        try {
          var fdoc = el.contentDocument;
          if (fdoc && typeof fdoc.elementFromPoint === "function") {
            var ft = getIframeTransform(el);
            var fx = (x - ft.left) / ft.scaleX;
            var fy = (y - ft.top) / ft.scaleY;
            var fEl = fdoc.elementFromPoint(fx, fy);
            if (fEl && fEl !== el) { el = fEl; x = fx; y = fy; continue; }
          }
        } catch (e) {}
      }
      break;
    }
    return el;
  }
  function labelControlOf(node) {
    var cur = node;
    var guard = 0;
    while (cur && guard++ < 8) {
      if (cur.tagName === "LABEL") return cur.control || null;
      cur = cur.parentElement;
    }
    return null;
  }
  function isSameOrDescendant(target, candidate) {
    if (!target || !candidate) return false;
    if (target === candidate) return true;
    try {
      if (typeof target.contains === "function" && target.contains(candidate)) return true;
    } catch (e) {}
    if (labelControlOf(candidate) === target) return true;
    var cur = candidate;
    var guard = 0;
    while (cur && guard++ < 24) {
      if (cur === target) return true;
      var root = typeof cur.getRootNode === "function" ? cur.getRootNode() : null;
      if (root && root.host) {
        cur = root.host;
      } else {
        cur = cur.parentElement;
      }
    }
    return false;
  }
  function describeEl(el) {
    if (!el) return "(unknown)";
    var tag = el.tagName ? el.tagName.toLowerCase() : "element";
    var idPart = el.id ? "#" + el.id : "";
    var cls = typeof el.className === "string" ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3).join(".") : "";
    var clsPart = cls ? "." + cls : "";
    var txt = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    if (txt.length > 40) txt = txt.slice(0, 37) + "...";
    return "<" + tag + idPart + clsPart + (txt ? ">" + txt + "</" + tag + ">" : ">");
  }
  function getHitTestBlocker(hit) {
    if (hit.wasmNode) {
      var wr = hit.wasmRect;
      var wvw = (window.visualViewport && window.visualViewport.width) || window.innerWidth || 0;
      var wvh = (window.visualViewport && window.visualViewport.height) || window.innerHeight || 0;
      var wcx = wr.left + wr.width / 2;
      var wcy = wr.top + wr.height / 2;
      if (wvw > 0 && wvh > 0 && (wcx < 0 || wcy < 0 || wcx > wvw || wcy > wvh)) return "outside viewport";
      if (hit.el && hit.el.__spanaHostCanvas) {
        var topW = deepElementFromPoint(document, wcx, wcy);
        if (topW && !isSameOrDescendant(hit.el.__spanaHostCanvas, topW)) return describeEl(topW);
      }
      return null;
    }
    var el = hit.el;
    var rect = el.getBoundingClientRect();
    var winForRect = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var styleForRect = winForRect && winForRect.getComputedStyle ? winForRect.getComputedStyle(el) : null;
    if (styleForRect && styleForRect.display === "contents") {
      var contentsRect = getContentsUnionRect(el, 0);
      if (contentsRect) rect = contentsRect;
    }
    var sx = hit.scaleX != null ? hit.scaleX : 1;
    var sy = hit.scaleY != null ? hit.scaleY : 1;
    var vw = (window.visualViewport && window.visualViewport.width) || window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight || document.documentElement.clientHeight || 0;
    var cx = hit.offsetX + (rect.left + rect.width / 2) * sx;
    var cy = hit.offsetY + (rect.top + rect.height / 2) * sy;
    if (vw > 0 && vh > 0 && (cx < 0 || cy < 0 || cx > vw || cy > vh)) {
      return "outside viewport";
    }
    var topEl = deepElementFromPoint(document, cx, cy);
    if (!topEl) return null;
    if (isSameOrDescendant(el, topEl)) return null;
    return describeEl(topEl);
  }
  function getClippedViewportBox(hit) {
    var el = hit.el;
    var rect = el.getBoundingClientRect();
    var winForRect = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var styleForRect = winForRect && winForRect.getComputedStyle ? winForRect.getComputedStyle(el) : null;
    if (styleForRect && styleForRect.display === "contents") {
      var contentsRect = getContentsUnionRect(el, 0);
      if (contentsRect) rect = contentsRect;
    }
    var sx = hit.scaleX != null ? hit.scaleX : 1;
    var sy = hit.scaleY != null ? hit.scaleY : 1;
    var left = hit.offsetX + rect.left * sx;
    var top = hit.offsetY + rect.top * sy;
    var right = hit.offsetX + (rect.left + rect.width) * sx;
    var bottom = hit.offsetY + (rect.top + rect.height) * sy;
    // Intersect with clipping ancestors (overflow: hidden/clip/scroll/auto) so half-clipped buttons
    // target their visible region rather than clicking a clipped-out center onto the parent container.
    var cur = el.parentElement;
    var guard = 0;
    while (cur && guard++ < 32) {
      var cs = winForRect && winForRect.getComputedStyle ? winForRect.getComputedStyle(cur) : null;
      if (cs) {
        var ox = cs.overflowX || cs.overflow || "";
        var oy = cs.overflowY || cs.overflow || "";
        if (ox === "hidden" || ox === "clip" || ox === "scroll" || ox === "auto" ||
            oy === "hidden" || oy === "clip" || oy === "scroll" || oy === "auto") {
          var cr = cur.getBoundingClientRect();
          if (cr.width > 0 && cr.height > 0) {
            var cLeft = hit.offsetX + cr.left * sx;
            var cTop = hit.offsetY + cr.top * sy;
            var cRight = hit.offsetX + cr.right * sx;
            var cBottom = hit.offsetY + cr.bottom * sy;
            if (ox === "hidden" || ox === "clip" || ox === "scroll" || ox === "auto") {
              if (cLeft > left) left = cLeft;
              if (cRight < right) right = cRight;
            }
            if (oy === "hidden" || oy === "clip" || oy === "scroll" || oy === "auto") {
              if (cTop > top) top = cTop;
              if (cBottom < bottom) bottom = cBottom;
            }
          }
        }
      }
      cur = cur.parentElement;
    }
    var vw = (window.visualViewport && window.visualViewport.width) || window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight || document.documentElement.clientHeight || 0;
    if (vw > 0 && vh > 0) {
      if (left < 0) left = 0;
      if (top < 0) top = 0;
      if (right > vw) right = vw;
      if (bottom > vh) bottom = vh;
    }
    return { left: left, top: top, right: right, bottom: bottom, vw: vw, vh: vh, rawRect: rect, sx: sx, sy: sy };
  }
  function findClickablePoint(hit) {
    if (hit.wasmNode) {
      var wr = hit.wasmRect;
      return { x: wr.left + wr.width / 2, y: wr.top + wr.height / 2 };
    }
    var el = hit.el;
    var box = getClippedViewportBox(hit);
    var rawCx = hit.offsetX + (box.rawRect.left + box.rawRect.width / 2) * box.sx;
    var rawCy = hit.offsetY + (box.rawRect.top + box.rawRect.height / 2) * box.sy;
    var clipW = box.right - box.left;
    var clipH = box.bottom - box.top;
    if (box.vw > 0 && box.vh > 0 && (clipW <= 0 || clipH <= 0)) {
      return null;
    }
    var tryPt = function(px, py) {
      if (box.vw > 0 && box.vh > 0 && (px < 0 || py < 0 || px >= box.vw || py >= box.vh)) return null;
      var topEl = deepElementFromPoint(document, px, py);
      if (!topEl || isSameOrDescendant(el, topEl)) return { x: px, y: py };
      return null;
    };
    // 1. Fast path: unclipped rounded center (matches 99.9% of elements in 1 hit-test call)
    var rRaw = tryPt(Math.round(rawCx), Math.round(rawCy));
    if (rRaw) return rRaw;
    // 2. Clipped visible center (rounded, then fractional)
    var cx = box.left + clipW / 2;
    var cy = box.top + clipH / 2;
    var rClip = tryPt(Math.round(cx), Math.round(cy));
    if (rClip) return rClip;
    var fClip = tryPt(cx, cy);
    if (fClip) return fClip;
    // 3. Interior points inside the visible clipped rect (handles 0.5px edge rounding onto clipping parent)
    var padX = Math.min(2, clipW / 4);
    var padY = Math.min(2, clipH / 4);
    var candidates = [
      [Math.floor(cx), Math.floor(cy)],
      [Math.ceil(cx), Math.floor(cy)],
      [Math.floor(cx), Math.ceil(cy)],
      [Math.floor(box.left + padX), Math.floor(box.top + padY)],
      [Math.ceil(box.left + padX), Math.ceil(box.top + padY)],
      [Math.floor(box.right - padX), Math.floor(box.bottom - padY)],
      [box.left + padX, box.top + padY],
      [box.right - padX, box.bottom - padY],
    ];
    for (var i = 0; i < candidates.length; i++) {
      var hitPt = tryPt(candidates[i][0], candidates[i][1]);
      if (hitPt) return hitPt;
    }
    return null;
  }
  function isHitTestClear(hit) {
    if (hit.wasmNode) {
      return getHitTestBlocker(hit) === null;
    }
    var pt = findClickablePoint(hit);
    if (pt) {
      hit._clickPoint = pt;
      return true;
    }
    hit._clickPoint = null;
    return false;
  }
  function isScrollableOverflow(val) {
    return val === "auto" || val === "scroll" || val === "overlay";
  }
  function isClippedByScrollableAncestor(hit, rect) {
    var el = hit.el;
    var doc = el.ownerDocument || document;
    var win = doc.defaultView || window;
    var cur = el.parentElement;
    var guard = 0;
    while (cur && cur.nodeType === 1 && guard++ < 32) {
      if (cur === doc.documentElement || cur === doc.body) break;
      var cs = win && win.getComputedStyle ? win.getComputedStyle(cur) : null;
      if (cs) {
        var ox = cs.overflowX || cs.overflow || "";
        var oy = cs.overflowY || cs.overflow || "";
        var canScrollX = isScrollableOverflow(ox) && cur.scrollWidth > cur.clientWidth + 1;
        var canScrollY = isScrollableOverflow(oy) && cur.scrollHeight > cur.clientHeight + 1;
        if (canScrollX || canScrollY) {
          var cr = cur.getBoundingClientRect();
          if (cr.width > 0 && cr.height > 0) {
            if (canScrollX && (rect.left < cr.left - 0.5 || rect.right > cr.right + 0.5)) {
              return true;
            }
            if (canScrollY && (rect.top < cr.top - 0.5 || rect.bottom > cr.bottom + 0.5)) {
              return true;
            }
          }
        }
        // Inspect a position: fixed ancestor itself FIRST (it may be scrollable),
        // then stop walking above its fixed containing boundary.
        if (cs.position === "fixed") break;
      }
      cur = cur.parentElement;
    }
    return false;
  }
  function isFullyInViewport(hit) {
    if (hit.wasmNode) return true;
    var el = hit.el;
    var rect = el.getBoundingClientRect();
    var winForRect = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var styleForRect = winForRect && winForRect.getComputedStyle ? winForRect.getComputedStyle(el) : null;
    if (styleForRect && styleForRect.display === "contents") {
      var contentsRect = getContentsUnionRect(el, 0);
      if (contentsRect) rect = contentsRect;
    }
    var sx = hit.scaleX != null ? hit.scaleX : 1;
    var sy = hit.scaleY != null ? hit.scaleY : 1;
    var vw = (window.visualViewport && window.visualViewport.width) || window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight || document.documentElement.clientHeight || 0;
    if (vw <= 0 || vh <= 0 || rect.width <= 0 || rect.height <= 0) return false;
    var left = hit.offsetX + rect.left * sx;
    var top = hit.offsetY + rect.top * sy;
    if (!(left >= 0 && top >= 0 && (left + rect.width * sx) <= vw && (top + rect.height * sy) <= vh)) {
      return false;
    }
    if (isClippedByScrollableAncestor(hit, rect)) return false;
    return true;
  }
  function ensureInViewport(hit) {
    var el = hit.el;
    var rect = el.getBoundingClientRect();
    var winForRect = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var styleForRect = winForRect && winForRect.getComputedStyle ? winForRect.getComputedStyle(el) : null;
    if (styleForRect && styleForRect.display === "contents") {
      var contentsRect = getContentsUnionRect(el, 0);
      if (contentsRect) rect = contentsRect;
    }
    var sx = hit.scaleX != null ? hit.scaleX : 1;
    var sy = hit.scaleY != null ? hit.scaleY : 1;
    var vw = (window.visualViewport && window.visualViewport.width) || window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight || document.documentElement.clientHeight || 0;
    var cx = hit.offsetX + (rect.left + rect.width / 2) * sx;
    var cy = hit.offsetY + (rect.top + rect.height / 2) * sy;
    var outsideWindow = vw > 0 && vh > 0 && (cx < 1 || cy < 1 || cx > vw - 1 || cy > vh - 1);
    if (outsideWindow || isClippedByScrollableAncestor(hit, rect)) {
      if (typeof el.scrollIntoView === "function") {
        try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); }
        catch (e) { try { el.scrollIntoView(true); } catch (e2) {} }
      }
      return true;
    }
    return false;
  }
  function canScrollToUnobscure(hit) {
    if (!hit || !hit.el || hit.wasmNode) return false;
    var el = hit.el;
    var doc = el.ownerDocument || document;
    var win = doc.defaultView || window;
    var hasScrollableAncestor = false;
    var hitFixedBoundary = false;
    var cur = el;
    var guard = 0;
    while (cur && cur.nodeType === 1 && guard++ < 32) {
      var cs = win && win.getComputedStyle ? win.getComputedStyle(cur) : null;
      if (cs) {
        if (cur !== el && cur !== doc.documentElement && cur !== doc.body) {
          var ox = cs.overflowX || cs.overflow || "";
          var oy = cs.overflowY || cs.overflow || "";
          if ((isScrollableOverflow(ox) && cur.scrollWidth > cur.clientWidth + 1) ||
              (isScrollableOverflow(oy) && cur.scrollHeight > cur.clientHeight + 1)) {
            hasScrollableAncestor = true;
          }
        }
        if (cs.position === "fixed") {
          hitFixedBoundary = true;
          break;
        }
      }
      cur = cur.parentElement;
    }
    var rect = el.getBoundingClientRect();
    // If clipped outside a scrollable ancestor (including inside/on a position: fixed dialog),
    // scrolling that ancestor brings the target into view even if the clipped point hits a backdrop.
    if (hasScrollableAncestor && isClippedByScrollableAncestor(hit, rect)) {
      return true;
    }
    if (hitFixedBoundary && !hasScrollableAncestor) return false;
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var topEl = deepElementFromPoint(doc, cx, cy);
    if (!topEl) return false;
    var vpW = win.innerWidth || doc.documentElement.clientWidth || 1280;
    var vpH = win.innerHeight || doc.documentElement.clientHeight || 720;
    var b = topEl;
    while (b && b.nodeType === 1) {
      var bs = win && win.getComputedStyle ? win.getComputedStyle(b) : null;
      if (bs && (bs.position === "fixed" || bs.position === "sticky")) {
        var br = b.getBoundingClientRect();
        if (br.width >= vpW * 0.8 && br.height >= vpH * 0.8) return false;
        return true;
      }
      b = b.parentElement;
    }
    return false;
  }
  function scrollToUnobscure(hit) {
    var el = hit.el;
    if (typeof el.scrollIntoView !== "function") return false;
    var blocks = ["center", "end", "start", "nearest"];
    for (var i = 0; i < blocks.length; i++) {
      try {
        el.scrollIntoView({ block: blocks[i], inline: "center", behavior: "instant" });
      } catch (e) {
        try { el.scrollIntoView(true); } catch (e2) {}
      }
      if (!el.isConnected) {
        try { window.__spanaLastScrollDetached = true; } catch (e3) {}
        return false;
      }
      if (isHitTestClear(hit)) return true;
    }
    return false;
  }
  function hasActiveViewTransition() {
    if (typeof document === "undefined" || typeof document.getAnimations !== "function") return false;
    try {
      var allAnims = document.getAnimations();
      for (var i = 0; i < allAnims.length; i++) {
        var a = allAnims[i];
        var pseudo = a && a.effect && a.effect.pseudoElement;
        if (a && a.playState === "running" && typeof pseudo === "string" && pseudo.indexOf("::view-transition") === 0) {
          return true;
        }
      }
    } catch (e) {}
    return false;
  }
  function hasActiveAnimation(el) {
    if (hasActiveViewTransition()) return true;
    var cur = el;
    var depth = 0;
    while (cur && depth++ < 8) {
      if (typeof cur.getAnimations === "function") {
        try {
          var anims = cur.getAnimations();
          for (var i = 0; i < anims.length; i++) {
            if (anims[i] && anims[i].playState === "running") return true;
          }
        } catch (e) {}
      }
      cur = cur.parentElement;
    }
    return false;
  }
  function isElementEnabled(el) {
    if (!el) return true;
    if (el.hasAttribute && el.hasAttribute("disabled")) return false;
    if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return false;
    try {
      if (typeof el.matches === "function" && el.matches(":disabled")) return false;
    } catch (e) {}
    var cur = el.parentElement;
    var guard = 0;
    while (cur && guard++ < 16) {
      if (cur.getAttribute && cur.getAttribute("aria-disabled") === "true") return false;
      cur = cur.parentElement;
    }
    return true;
  }
  function isVisible(el, rect, depth) {
    if (!el) return false;
    if (isVisiblyHiddenInAncestorChain(el)) return false;
    var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var style = win && win.getComputedStyle ? win.getComputedStyle(el) : null;
    if (style && style.display === "contents") {
      return hasVisibleDescendant(el, depth || 0);
    }
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    return true;
  }
  function getVisibilityFailureReason(el, rect) {
    if (!el) return "element is null";
    var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var cur = el;
    var guard = 0;
    while (cur && guard++ < 48) {
      if (cur.nodeType === 1 && win && win.getComputedStyle) {
        var cs = win.getComputedStyle(cur);
        if (cs) {
          if (cs.display === "none") return cur === el ? "display: none" : "ancestor has display: none";
          if (cs.contentVisibility === "hidden") return cur === el ? "content-visibility: hidden" : "ancestor has content-visibility: hidden";
        }
      }
      var root = typeof cur.getRootNode === "function" ? cur.getRootNode() : null;
      cur = cur.parentElement || (root && root.host) || null;
    }
    if (el.nodeType === 1 && win && win.getComputedStyle) {
      var selfCs = win.getComputedStyle(el);
      if (selfCs && (selfCs.visibility === "hidden" || selfCs.visibility === "collapse")) return "visibility: " + selfCs.visibility;
      if (selfCs && selfCs.display === "contents" && !hasVisibleDescendant(el, 0)) return "display: contents with no visible children";
    }
    if (!rect || rect.width <= 0 || rect.height <= 0) return "bounding box has zero size (" + (rect ? Math.round(rect.width) + "x" + Math.round(rect.height) : "none") + ")";
    return null;
  }
  function toMatch(hit) {
    if (hit.wasmNode) {
      var wn = hit.wasmNode;
      var wr = hit.wasmRect;
      var wtext = (wn.text != null ? String(wn.text) : (wn.label != null ? String(wn.label) : "")).trim() || undefined;
      return {
        id: wn.testID || wn.id || undefined,
        tag: "wasm-node",
        role: wn.role || undefined,
        text: wtext,
        textContent: wtext,
        value: wn.value != null ? String(wn.value) : undefined,
        accessibilityLabel: wn.label || undefined,
        accessibleName: wn.label || wtext,
        rect: { x: wr.left, y: wr.top, width: wr.width, height: wr.height },
        scrollX: window.scrollX || 0,
        scrollY: window.scrollY || 0,
        devicePixelRatio: window.devicePixelRatio || 1,
        viewportWidth: window.innerWidth || 0,
        viewportHeight: window.innerHeight || 0,
        visible: wn.visible !== false && wr.width > 0 && wr.height > 0,
        enabled: wn.enabled !== false,
        clickable: wn.clickable !== undefined ? Boolean(wn.clickable) : (wn.role === "button" || wn.role === "link"),
        focused: wn.focused,
        checked: wn.checked,
        editable: wn.editable,
        empty: wn.value !== undefined ? String(wn.value).length === 0 : !wtext,
        attributes: wn.attributes || {},
        inShadowDom: false,
        inIframe: false
      };
    }
    var el = hit.el;
    var rect = el.getBoundingClientRect();
    var winForRect = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var styleForRect = winForRect && winForRect.getComputedStyle ? winForRect.getComputedStyle(el) : null;
    if (styleForRect && styleForRect.display === "contents") {
      var contentsRect = getContentsUnionRect(el, 0);
      if (contentsRect) rect = contentsRect;
    }
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
    var text = normWs(el.innerText || el.textContent || "") || undefined;
    var normTextContent = normWs(el.textContent || "") || undefined;
    var accName = getAccessibleName(el) || undefined;
    var accDesc = getAccessibleDescription(el) || undefined;
    var role = getImplicitRole(el) || undefined;
    var isEnabled = isElementEnabled(el);
    var isChecked =
      el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")
        ? Boolean(el.checked)
        : el.getAttribute("aria-checked") === "true"
          ? true
          : el.getAttribute("aria-checked") === "false"
            ? false
            : undefined;
    var isEditable = Boolean(
      isEnabled &&
      !el.hasAttribute("readonly") &&
      el.getAttribute("aria-readonly") !== "true" &&
      (el.isContentEditable ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        (el.tagName === "INPUT" &&
          ["button", "submit", "reset", "image", "hidden", "checkbox", "radio"].indexOf(
            String(el.type || "text").toLowerCase(),
          ) === -1)),
    );
    var isEmpty =
      el.tagName === "INPUT" || el.tagName === "TEXTAREA"
        ? String(el.value || "").length === 0
        : (el.textContent || "").trim().length === 0;
    var clsName = typeof el.className === "string" ? el.className : (el.getAttribute("class") || "");
    var sx = hit.scaleX != null ? hit.scaleX : 1;
    var sy = hit.scaleY != null ? hit.scaleY : 1;
    return {
      id: el.getAttribute("data-testid") || el.getAttribute("testID") || undefined,
      tag: tag,
      role: role,
      text: text,
      textContent: normTextContent,
      value: val,
      accessibilityLabel: el.getAttribute("aria-label") || undefined,
      accessibleName: accName,
      accessibleDescription: accDesc,
      rect: { x: hit.offsetX + rect.x * sx, y: hit.offsetY + rect.y * sy, width: rect.width * sx, height: rect.height * sy },
      clickPoint: hit._clickPoint || undefined,
      scrollX: window.scrollX || window.pageXOffset || 0,
      scrollY: window.scrollY || window.pageYOffset || 0,
      devicePixelRatio: window.devicePixelRatio || 1,
      viewportWidth: (window.visualViewport && window.visualViewport.width) || window.innerWidth || document.documentElement.clientWidth || 0,
      viewportHeight: (window.visualViewport && window.visualViewport.height) || window.innerHeight || document.documentElement.clientHeight || 0,
      visible: isVisible(el, rect),
      enabled: isEnabled,
      clickable: isClickable(el),
      focused: document.activeElement === el,
      checked: isChecked,
      editable: isEditable,
      empty: isEmpty,
      className: clsName || undefined,
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
  const serialized = JSON.stringify(serializeSelectorForDom(selector));
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
  const serialized = JSON.stringify(serializeSelectorForDom(selector));
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
  const serialized = JSON.stringify(serializeSelectorForDom(selector));
  return `(function(sel) {
    ${SHARED_DOM_TRAVERSAL_HELPERS}
    var hits = findAcrossRoots(sel, "strict");
    var hit = null;
    for (var i = hits.length - 1; i >= 0; i--) {
      var m = toMatch(hits[i]);
      if (m.visible && m.enabled) { hit = hits[i]; break; }
    }
    if (!hit) return false;
    var el = hit.el;
    if (typeof el.scrollIntoView === "function") {
      try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch (e) {}
    }
    if (!el.isConnected) return false;
    var postMatch = toMatch(hit);
    if (!postMatch.visible || !postMatch.enabled) return false;
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
 * Self-contained MutationObserver-reactive DOM wait script with full single-round-trip
 * Playwright-grade actionability checks when `forAction: true`:
 *   1. App-ready signal (`window.__SPANA_APP_READY__`) when defined.
 *   2. Visible + enabled match (piercing open Shadow DOM & same-origin iframes).
 *   3. Auto-scroll offscreen targets into viewport (`scrollIntoView({ behavior: "instant" })`).
 *   4. Deep `elementFromPoint` hit-test verifying no overlay/backdrop/modal obscures the target.
 *   5. 2-rAF bounding-box stability check (≤ 1px movement; bypassed when `stableFrames === 0` or
 *      `instantAnimations` style is active).
 * Retries seamlessly inside the page via `MutationObserver` + `rAF` in ONE single round trip!
 */
function defaultActionStableFrames(): number {
  const envVal = process.env["SPANA_ACTION_STABLE_FRAMES"];
  if (envVal !== undefined) {
    const parsed = Number.parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 2;
}

export function buildDomWaitForSelectorScript(
  selector: Selector,
  opts: DomWaitForSelectorOptions = {},
): string {
  const serialized = JSON.stringify(serializeSelectorForDom(selector));
  const timeoutMs = Math.max(10, Math.round(opts.timeoutMs ?? 5000));
  const forAction = Boolean(opts.forAction);
  const force = Boolean(opts.force);
  const failFastWhenIdle = Boolean(opts.failFastWhenIdle);
  const idleQuietMs = Math.max(50, Math.round(opts.idleQuietMs ?? 250));
  const stableFrames = force
    ? 0
    : opts.stableFrames !== undefined
      ? Math.max(0, Math.round(opts.stableFrames))
      : forAction
        ? defaultActionStableFrames()
        : 0;
  const checkHitTest = force
    ? false
    : opts.checkHitTest !== undefined
      ? Boolean(opts.checkHitTest)
      : forAction;
  const waitForAppReady = opts.waitForAppReady !== undefined ? Boolean(opts.waitForAppReady) : true;
  const armTapGuard = Boolean(opts.armTapGuard && forAction && !force);

  return `(function(sel, timeoutMs, forAction, force, failFastWhenIdle, idleQuietMs, reqStableFrames, checkHitTest, waitForAppReady, armTapGuard) {
    ${SHARED_DOM_TRAVERSAL_HELPERS}
    var instantAnim = Boolean(typeof document !== "undefined" && document.getElementById && document.getElementById("__spana_instant_anim"));
    var explicitStableFrames = (instantAnim || force) ? 0 : reqStableFrames;

    function armTapGuardOnEl(el) {
      if (!armTapGuard || !el || el.nodeType !== 1) return;
      try {
        var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
        var doc = el.ownerDocument || document;
        if (window.__spanaTapGuardCleanup) window.__spanaTapGuardCleanup();
        window.__spanaTapMissed = false;
        var matchTarget = function(t) {
          return isSameOrDescendant(el, t);
        };
        var cleanup = function() {
          win.removeEventListener("pointerdown", onEvt, true);
          win.removeEventListener("mousedown", onEvt, true);
          win.removeEventListener("mouseup", onMouseUp, true);
          win.removeEventListener("click", onEvt, true);
          if (window.__spanaTapGuardCleanup === cleanup) delete window.__spanaTapGuardCleanup;
        };
        var onMouseUp = function(e) {
          if (!e.isTrusted) return;
          Promise.resolve().then(cleanup);
        };
        var onEvt = function(e) {
          if (!e.isTrusted) return;
          var hit = deepElementFromPoint(doc, e.clientX, e.clientY) || e.target;
          if (!matchTarget(hit) && !matchTarget(e.target)) {
            e.stopImmediatePropagation();
            e.preventDefault();
            window.__spanaTapMissed = true;
            if (e.type === "click") cleanup();
          } else if (e.type === "click") {
            cleanup();
          }
        };
        win.addEventListener("pointerdown", onEvt, true);
        win.addEventListener("mousedown", onEvt, true);
        win.addEventListener("mouseup", onMouseUp, true);
        win.addEventListener("click", onEvt, true);
        window.__spanaTapGuardCleanup = cleanup;
      } catch (e) {}
    }

    function recordActionFailure(reason) {
      if (!forAction) return;
      try { window.__spanaLastActionDiag = reason; } catch (e) {}
    }

    function findCandidates() {
      if (waitForAppReady && !isAppReady()) { recordActionFailure("waiting for app ready (__SPANA_APP_READY__)"); return null; }
      if (forAction && !force && hasActiveViewTransition()) { recordActionFailure("active CSS view transition in progress"); return null; }
      var rawHits = findAcrossRoots(sel, "strict");
      if (rawHits.length === 0) { recordActionFailure(null); return null; }
      var ready = [];
      var lastFail = null;
      for (var i = 0; i < rawHits.length; i++) {
        var h = rawHits[i];
        var m = toMatch(h);
        if (!m.visible) { lastFail = getVisibilityFailureReason(h.el, h.el && h.el.getBoundingClientRect ? h.el.getBoundingClientRect() : null) || "not visible"; continue; }
        if (forAction && !force && !m.enabled) { lastFail = "element is disabled"; continue; }
        ready.push({ hit: h, match: m });
      }
      if (ready.length === 0) recordActionFailure(lastFail);
      return ready.length > 0 ? ready : null;
    }

    function checkActionableNow() {
      var ready = findCandidates();
      if (!ready) return null;
      if (!forAction) return ready.map(function(r) { return r.match; });
      var target = ready[ready.length - 1];
      var alreadyInViewport = isFullyInViewport(target.hit);
      var didScroll = alreadyInViewport ? false : ensureInViewport(target.hit);
      if (!force && checkHitTest && !isHitTestClear(target.hit)) {
        if (!alreadyInViewport || canScrollToUnobscure(target.hit)) {
          if (scrollToUnobscure(target.hit)) {
            didScroll = true;
          }
          if (!target.hit.el.isConnected) { recordActionFailure("element detached from DOM after scrolling"); return null; }
        }
        if (!isHitTestClear(target.hit)) {
          var blocker = getHitTestBlocker(target.hit);
          recordActionFailure(blocker ? ("hit-test blocked by " + blocker) : "hit-test failed (element not receiving pointer events at click point)");
          return null;
        }
      }
      var updated = toMatch(target.hit);
      if (!updated.visible) { recordActionFailure("element became hidden after scroll"); return null; }
      if (!force && !updated.enabled) { recordActionFailure("element became disabled"); return null; }
      recordActionFailure(null);
      return { hits: ready, target: target, match: updated, didScroll: didScroll };
    }

    function neededStableFrames(candidate) {
      if (force || !forAction || typeof requestAnimationFrame !== "function") return 0;
      if (explicitStableFrames >= 0) return explicitStableFrames;
      // Smart auto stability: 0 rAF wait on static, unobstructed elements;
      // wait 2 frames if CSS animations/transitions are running or 1 frame right after scroll.
      if (hasActiveAnimation(candidate.target.hit.el)) return 2;
      if (candidate.didScroll) return 1;
      return 0;
    }

    // Fast synchronous exit when target is already actionable and needs 0 stability frames
    var imm = checkActionableNow();
    if (imm) {
      if (!forAction) return imm;
      if (neededStableFrames(imm) <= 0) {
        armTapGuardOnEl(imm.target.hit.el);
        return [imm.match];
      }
    }

    return new Promise(function(resolve) {
      var done = false;
      var observer = null;
      var timeoutTimer = null;
      var fallbackInterval = null;
      var idleTimer = null;
      var rafId = null;
      var checkingStability = false;

      function finish(result) {
        if (done) return;
        done = true;
        if (observer) { try { observer.disconnect(); } catch (e) {} }
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (fallbackInterval) clearInterval(fallbackInterval);
        if (idleTimer) clearTimeout(idleTimer);
        if (rafId !== null && typeof cancelAnimationFrame === "function") {
          try { cancelAnimationFrame(rafId); } catch (e) {}
        }
        resolve(result);
      }

      function armIdleTimer() {
        if (!failFastWhenIdle) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(function() {
          var rootEl = document.body || document.documentElement;
          if (
            document.readyState === "complete" &&
            (!waitForAppReady || isAppReady()) &&
            !hasActiveAnimation(rootEl) &&
            !hasInflightNetwork(idleQuietMs)
          ) {
            var hit = checkActionableNow();
            if (hit) {
              if (forAction) armTapGuardOnEl(hit.target.hit.el);
              finish(forAction ? [hit.match] : hit);
            } else {
              finish([]);
            }
          } else {
            armIdleTimer();
          }
        }, idleQuietMs);
      }

      function verifyStability(candidate) {
        if (done || checkingStability) return;
        var framesToWait = neededStableFrames(candidate);
        if (!forAction || framesToWait <= 0 || typeof requestAnimationFrame !== "function") {
          if (forAction) armTapGuardOnEl(candidate.target.hit.el);
          finish(forAction ? [candidate.match] : candidate);
          return;
        }
        checkingStability = true;
        var el = candidate.target.hit.el;
        var lastRect = candidate.match.rect;
        var remainingFrames = framesToWait;

        function step() {
          if (done) return;
          if (!el.isConnected) {
            checkingStability = false;
            scheduleAttempt();
            return;
          }
          if (checkHitTest && !isHitTestClear(candidate.target.hit)) {
            checkingStability = false;
            scheduleAttempt();
            return;
          }
          var cur = toMatch(candidate.target.hit);
          if (!cur.visible || !cur.enabled) {
            checkingStability = false;
            scheduleAttempt();
            return;
          }
          var dx = Math.abs(cur.rect.x - lastRect.x);
          var dy = Math.abs(cur.rect.y - lastRect.y);
          var dw = Math.abs(cur.rect.width - lastRect.width);
          var dh = Math.abs(cur.rect.height - lastRect.height);
          if (dx <= 1 && dy <= 1 && dw <= 1 && dh <= 1) {
            remainingFrames -= 1;
            if (remainingFrames <= 0) {
              armTapGuardOnEl(el);
              finish([cur]);
              return;
            }
          } else {
            recordActionFailure("element bounding box unstable (still moving)");
            remainingFrames = framesToWait;
            lastRect = cur.rect;
          }
          rafId = requestAnimationFrame(step);
        }
        rafId = requestAnimationFrame(step);
      }

      function attempt() {
        if (done || checkingStability) return;
        var hit = checkActionableNow();
        if (hit) {
          if (forAction) {
            verifyStability(hit);
          } else {
            finish(hit);
          }
          return;
        }
      }

      var scheduled = false;
      function scheduleAttempt() {
        if (done || checkingStability) return;
        armIdleTimer();
        if (scheduled) return;
        scheduled = true;
        Promise.resolve().then(function() {
          scheduled = false;
          attempt();
        });
      }

      timeoutTimer = setTimeout(function() {
        var finalHit = checkActionableNow();
        if (finalHit && forAction) armTapGuardOnEl(finalHit.target.hit.el);
        finish(finalHit ? (forAction ? [finalHit.match] : finalHit) : []);
      }, timeoutMs);

      fallbackInterval = setInterval(attempt, forAction ? 40 : 120);

      if (typeof MutationObserver !== "undefined") {
        var root = document.documentElement || document.body || document;
        if (root) {
          observer = new MutationObserver(scheduleAttempt);
          observer.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true
          });
        }
      }

      armIdleTimer();
      attempt();
    });
  })(${serialized}, ${timeoutMs}, ${forAction}, ${force}, ${failFastWhenIdle}, ${idleQuietMs}, ${stableFrames}, ${checkHitTest}, ${waitForAppReady}, ${armTapGuard})`;
}

/**
 * Self-contained MutationObserver-reactive script that resolves `true` as soon as
 * no visible matching element exists in the DOM (zero runner-side polling).
 */
export function buildDomWaitForHiddenScript(
  selector: Selector,
  opts: DomWaitForHiddenOptions = {},
): string {
  const serialized = JSON.stringify(serializeSelectorForDom(selector));
  const timeoutMs = Math.max(10, Math.round(opts.timeoutMs ?? 5000));

  return `(function(sel, timeoutMs) {
    ${SHARED_DOM_TRAVERSAL_HELPERS}
    function isHiddenNow() {
      var hits = findAcrossRoots(sel, false);
      for (var i = 0; i < hits.length; i++) {
        if (toMatch(hits[i]).visible) return false;
      }
      return true;
    }
    if (isHiddenNow()) return true;

    return new Promise(function(resolve) {
      var done = false;
      var observer = null;
      var timeoutTimer = null;
      var fallbackInterval = null;

      function finish(val) {
        if (done) return;
        done = true;
        if (observer) { try { observer.disconnect(); } catch (e) {} }
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (fallbackInterval) clearInterval(fallbackInterval);
        resolve(val);
      }

      function onChange() {
        if (isHiddenNow()) finish(true);
      }

      timeoutTimer = setTimeout(function() {
        finish(isHiddenNow());
      }, timeoutMs);

      fallbackInterval = setInterval(onChange, 120);

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
    });
  })(${serialized}, ${timeoutMs})`;
}

/**
 * Self-contained MutationObserver-reactive assertion wait script for text,
 * substring text, input value, and DOM attribute assertions — runs completely
 * in-page with zero runner-side polling ticks.
 */
export function buildDomWaitForMatchScript(
  selector: Selector,
  opts: DomWaitForMatchOptions,
): string {
  const serialized = JSON.stringify(serializeSelectorForDom(selector));
  const timeoutMs = Math.max(10, Math.round(opts.timeoutMs ?? 5000));
  const kind = JSON.stringify(opts.kind);
  const expected = JSON.stringify(opts.expected ?? null);
  const expectedCount = JSON.stringify(opts.expectedCount ?? null);
  const attributeName = JSON.stringify(opts.attributeName ?? null);
  const cssProperty = JSON.stringify(opts.cssProperty ?? null);
  const patternSource = JSON.stringify(opts.patternSource ?? null);
  const patternFlags = JSON.stringify(opts.patternFlags ?? "");
  const negate = Boolean(opts.negate);
  const visibleOnly = Boolean(opts.visibleOnly);
  const ignoreCase = Boolean(opts.ignoreCase);
  const propertyName = JSON.stringify(opts.propertyName ?? null);
  const expectedValue = JSON.stringify(opts.expectedValue ?? null);

  return `(function(sel, timeoutMs, kind, expected, expectedCount, attributeName, cssProperty, patternSource, patternFlags, negate, visibleOnly, ignoreCase, propertyName, expectedValue) {
    ${SHARED_DOM_TRAVERSAL_HELPERS}
    var lastActual = undefined;
    var regex = patternSource !== null ? new RegExp(patternSource, patternFlags) : null;
    var allowHidden = kind === "text" || kind === "containsText" || kind === "matchesText" || kind === "value" || kind === "attribute" || kind === "attached" || kind === "jsProperty";

    function evaluateMatch() {
      if (kind === "url") {
        var href = String(window.location.href || "");
        lastActual = href;
        var urlOk = regex
          ? regex.test(href)
          : (expected !== null && (href === expected || href.indexOf(String(expected)) !== -1));
        if (negate ? !urlOk : urlOk) return { matched: true, actual: href };
        return null;
      }
      if (kind === "title") {
        var docTitle = String(typeof document !== "undefined" ? (document.title || "") : "");
        lastActual = docTitle;
        var titleOk = regex ? regex.test(docTitle) : (expected !== null && docTitle === String(expected));
        if (negate ? !titleOk : titleOk) return { matched: true, actual: docTitle };
        return null;
      }
      var pvMode = (kind === "attached" || (kind === "count" && !visibleOnly)) ? false : (visibleOnly ? "strict" : "prefer");
      var hits = findAcrossRoots(sel, pvMode);
      if (kind === "count") {
        var matchedCount = 0;
        if (visibleOnly) {
          for (var ci = 0; ci < hits.length; ci++) {
            if (toMatch(hits[ci]).visible) matchedCount += 1;
          }
        } else {
          matchedCount = hits.length;
        }
        lastActual = String(matchedCount);
        var countOk = matchedCount === expectedCount;
        if (negate ? !countOk : countOk) return { matched: true, actual: String(matchedCount) };
        return null;
      }
      if (kind === "attached") {
        var isAttached = hits.length > 0;
        lastActual = isAttached ? "attached" : "detached";
        if (negate ? !isAttached : isAttached) return { matched: true, actual: lastActual };
        return null;
      }
      var anyVisible = false;
      var hiddenFallbackMatches = [];
      var checkMatchItem = function(h, m) {
        var matched = false;
        var actualVal = undefined;
        if (kind === "focused") {
          var isFoc = Boolean(m.focused);
          actualVal = isFoc ? "focused" : "not focused";
          matched = isFoc;
        } else if (kind === "checked") {
          var isChk = Boolean(m.checked);
          actualVal = isChk ? "checked" : "unchecked";
          matched = isChk;
        } else if (kind === "enabled") {
          var isEn = m.enabled !== false;
          actualVal = isEn ? "enabled" : "disabled";
          matched = isEn;
        } else if (kind === "role") {
          var elRole = m.role || getImplicitRole(h.el) || "generic";
          actualVal = elRole;
          matched = expected !== null && elRole.toLowerCase() === String(expected).toLowerCase();
        } else if (kind === "editable") {
          var isEd = Boolean(m.editable);
          actualVal = isEd ? "editable" : "not editable";
          matched = isEd;
        } else if (kind === "empty") {
          var isEmp = Boolean(m.empty);
          actualVal = isEmp ? "empty" : (m.value || m.textContent || "non-empty");
          matched = isEmp;
        } else if (kind === "inViewport") {
          var vpW = window.innerWidth || document.documentElement.clientWidth || 0;
          var vpH = window.innerHeight || document.documentElement.clientHeight || 0;
          var r = m.rect;
          var inVp = r.width > 0 && r.height > 0 && r.x + r.width > 0 && r.y + r.height > 0 && r.x < vpW && r.y < vpH;
          actualVal = inVp ? "in viewport" : "outside viewport";
          matched = inVp;
        } else if (kind === "jsProperty" && propertyName !== null) {
          var propNode = h.el;
          var rawProp = propNode ? propNode[propertyName] : undefined;
          actualVal = typeof rawProp === "string" ? rawProp : JSON.stringify(rawProp);
          matched = JSON.stringify(rawProp) === JSON.stringify(expectedValue);
        } else if (kind === "class") {
          var cls = m.className || "";
          actualVal = cls;
          if (regex) {
            matched = regex.test(cls);
          } else if (expected !== null) {
            var tokens = cls.trim().split(/\\s+/).filter(Boolean);
            var expectedTokens = String(expected).trim().split(/\\s+/).filter(Boolean);
            matched = expectedTokens.length > 0 && expectedTokens.every(function(tok) { return tokens.indexOf(tok) !== -1; });
          }
        } else if (kind === "css" && cssProperty !== null) {
          var elNode = h.el;
          var winObj = (elNode.ownerDocument && elNode.ownerDocument.defaultView) || window;
          var cssVal = winObj && winObj.getComputedStyle ? winObj.getComputedStyle(elNode).getPropertyValue(cssProperty).trim() : "";
          actualVal = cssVal;
          matched = regex ? regex.test(cssVal) : (expected !== null && cssVal === String(expected).trim());
        } else if (kind === "accessibleName") {
          var acc = normWs(m.accessibleName || "");
          actualVal = acc;
          matched = regex ? (regex.test(m.accessibleName || "") || regex.test(acc)) : (expected === null ? acc.length > 0 : acc === normWs(expected));
        } else if (kind === "accessibleDescription") {
          var accD = normWs(m.accessibleDescription || "");
          actualVal = accD;
          matched = regex ? (regex.test(m.accessibleDescription || "") || regex.test(accD)) : (expected === null ? accD.length > 0 : accD === normWs(expected));
        } else if (kind === "text") {
          var normTxt = normWs(m.textContent !== undefined ? m.textContent : (m.text || ""));
          actualVal = normTxt;
          matched = normTxt === (expected !== null ? normWs(expected) : expected);
        } else if (kind === "containsText") {
          var actual = normWs(m.textContent !== undefined ? m.textContent : (m.text || ""));
          actualVal = actual;
          var needle = expected !== null ? normWs(expected) : "";
          matched = expected !== null && (ignoreCase
            ? actual.toLowerCase().indexOf(needle.toLowerCase()) !== -1
            : actual.indexOf(needle) !== -1);
        } else if (kind === "matchesText") {
          var rawRe = m.textContent !== undefined ? m.textContent : (m.text || "");
          var actualRe = normWs(rawRe);
          actualVal = actualRe;
          matched = Boolean(regex && (regex.test(rawRe) || regex.test(actualRe)));
        } else if (kind === "value") {
          var val = m.value !== undefined ? m.value : "";
          actualVal = val;
          matched = regex ? regex.test(val) : (val === expected);
        } else if (kind === "attribute" && attributeName !== null) {
          var attrVal = m.attributes ? m.attributes[attributeName] : undefined;
          actualVal = attrVal;
          matched = regex
            ? (attrVal !== undefined && regex.test(attrVal))
            : (expected === null ? attrVal !== undefined : attrVal === expected);
        } else if (kind === "accessibilityLabel") {
          var lbl = m.accessibilityLabel;
          actualVal = lbl;
          matched = expected === null ? (lbl !== undefined && lbl.length > 0) : lbl === expected;
        }
        lastActual = actualVal;
        if (negate ? !matched : matched) return { matched: true, actual: actualVal };
        return null;
      };
      for (var i = hits.length - 1; i >= 0; i--) {
        var m = toMatch(hits[i]);
        if (!allowHidden && !m.visible) {
          if (kind === "enabled" || kind === "checked") hiddenFallbackMatches.push({ h: hits[i], m: m });
          continue;
        }
        if (m.visible) anyVisible = true;
        var resHit = checkMatchItem(hits[i], m);
        if (resHit) return resHit;
      }
      if (!anyVisible && hiddenFallbackMatches.length > 0) {
        for (var hi = 0; hi < hiddenFallbackMatches.length; hi++) {
          var hRes = checkMatchItem(hiddenFallbackMatches[hi].h, hiddenFallbackMatches[hi].m);
          if (hRes) return hRes;
        }
      }
      return null;
    }

    var immediate = evaluateMatch();
    if (immediate) return immediate;

    return new Promise(function(resolve) {
      var done = false;
      var observer = null;
      var timeoutTimer = null;
      var fallbackInterval = null;
      var scheduled = false;

      function finish(res) {
        if (done) return;
        done = true;
        if (observer) { try { observer.disconnect(); } catch (e) {} }
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (fallbackInterval) clearInterval(fallbackInterval);
        if (typeof document !== "undefined") {
          document.removeEventListener("input", onChange, true);
          document.removeEventListener("change", onChange, true);
          document.removeEventListener("focusin", onChange, true);
        }
        if (typeof window !== "undefined") {
          window.removeEventListener("popstate", onChange);
          window.removeEventListener("hashchange", onChange);
        }
        resolve(res);
      }

      function onChange() {
        if (done || scheduled) return;
        scheduled = true;
        Promise.resolve().then(function() {
          scheduled = false;
          if (done) return;
          var res = evaluateMatch();
          if (res) finish(res);
        });
      }

      timeoutTimer = setTimeout(function() {
        var finalRes = evaluateMatch();
        finish(finalRes || { matched: false, actual: lastActual });
      }, timeoutMs);

      fallbackInterval = setInterval(onChange, kind === "url" ? 50 : 100);

      if (typeof document !== "undefined") {
        document.addEventListener("input", onChange, true);
        document.addEventListener("change", onChange, true);
        document.addEventListener("focusin", onChange, true);
      }
      if (typeof window !== "undefined") {
        window.addEventListener("popstate", onChange);
        window.addEventListener("hashchange", onChange);
      }

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
    });
  })(${serialized}, ${timeoutMs}, ${kind}, ${expected}, ${expectedCount}, ${attributeName}, ${cssProperty}, ${patternSource}, ${patternFlags}, ${negate}, ${visibleOnly}, ${ignoreCase}, ${propertyName}, ${expectedValue})`;
}

/**
 * Atomic 1-round-trip in-page fill script: waits for an editable target to be visible,
 * enabled, in-viewport, and unobstructed, then focuses it, sets the value via the native
 * HTMLInputElement/HTMLTextAreaElement prototype setter (React/Vue/Svelte compatible),
 * and dispatches `input` + `change` events.
 */
export function buildDomFillScript(
  selector: Selector,
  value: string,
  opts: DomFillOptions = {},
): string {
  const serializedSel = JSON.stringify(serializeSelectorForDom(selector));
  const serializedVal = JSON.stringify(value);
  const timeoutMs = Math.max(10, Math.round(opts.timeoutMs ?? 5000));
  const checkHitTest = opts.checkHitTest !== undefined ? Boolean(opts.checkHitTest) : true;
  const verifyDelayMs =
    opts.verifyDelayMs !== undefined ? Math.max(0, Math.round(opts.verifyDelayMs)) : 12;

  return `(function(sel, val, timeoutMs, checkHitTest, verifyDelayMs) {
    ${SHARED_DOM_TRAVERSAL_HELPERS}
    function writeValue(el) {
      if (typeof el.focus === "function") { try { el.focus(); } catch (e) {} }
      var tag = el.tagName;
      // Rich-text contenteditable editors (TipTap/ProseMirror/Lexical/Slate) require native keyboard input;
      // return false so coordinator falls back cleanly to real tap + SelectAll + Input.insertText.
      if (el.isContentEditable) return false;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
        var proto = tag === "TEXTAREA"
          ? (win.HTMLTextAreaElement && win.HTMLTextAreaElement.prototype)
          : (win.HTMLInputElement && win.HTMLInputElement.prototype);
        var desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
        if (desc && typeof desc.set === "function") {
          try { desc.set.call(el, val); } catch (e) { el.value = val; }
        } else {
          el.value = val;
        }
        // Reset React's internal _valueTracker so synthetic controlled onChange always fires
        if (el._valueTracker && typeof el._valueTracker.setValue === "function") {
          try { el._valueTracker.setValue(val === "" ? " " : ""); } catch (e) {}
        }
      } else if (tag === "SELECT") {
        el.value = val;
      } else {
        el.value = val;
      }
      try { el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: val, inputType: "insertText" })); }
      catch (e) { el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true })); }
      el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
      return true;
    }

    function findEditableNow() {
      if (!isAppReady()) return null;
      var hits = findAcrossRoots(sel, "strict");
      for (var i = hits.length - 1; i >= 0; i--) {
        var h = hits[i];
        var m = toMatch(h);
        if (!m.visible || !m.enabled) continue;
        var alreadyInVp = isFullyInViewport(h);
        if (!alreadyInVp) ensureInViewport(h);
        if (checkHitTest && !isHitTestClear(h)) {
          if (!alreadyInVp || canScrollToUnobscure(h)) scrollToUnobscure(h);
          if (!h.el.isConnected || !isHitTestClear(h)) continue;
        }
        return h.el;
      }
      return null;
    }

    function verifyAndRetryFill(attemptsLeft) {
      var el = findEditableNow();
      if (!el) return Promise.resolve(false);
      if (el.isContentEditable) return Promise.resolve(false);
      if (!writeValue(el)) return Promise.resolve(false);
      if (verifyDelayMs <= 0) {
        var syncLatest = findEditableNow() || el;
        if (syncLatest && syncLatest.isConnected && String(syncLatest.value == null ? "" : syncLatest.value) === val) {
          return Promise.resolve(true);
        }
        return attemptsLeft > 1 ? verifyAndRetryFill(attemptsLeft - 1) : Promise.resolve(false);
      }
      return new Promise(function(resolve) {
        // Let React/Vue microtask + single paint flush settle, then verify value survived remount/re-render
        setTimeout(function() {
          var latest = findEditableNow() || el;
          if (latest && latest.isConnected && String(latest.value == null ? "" : latest.value) === val) {
            resolve(true);
            return;
          }
          if (attemptsLeft > 1) {
            verifyAndRetryFill(attemptsLeft - 1).then(resolve);
          } else {
            resolve(false);
          }
        }, verifyDelayMs);
      });
    }

    var immEl = findEditableNow();
    if (immEl) {
      if (immEl.isContentEditable) return false;
      return verifyAndRetryFill(3);
    }

    return new Promise(function(resolve) {
      var done = false;
      var observer = null;
      var timeoutTimer = null;
      var fallbackInterval = null;
      var scheduled = false;
      var filling = false;

      function finish(ok) {
        if (done) return;
        done = true;
        if (observer) { try { observer.disconnect(); } catch (e) {} }
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (fallbackInterval) clearInterval(fallbackInterval);
        resolve(ok);
      }

      function onChange() {
        if (done || scheduled || filling) return;
        scheduled = true;
        Promise.resolve().then(function() {
          scheduled = false;
          if (done || filling) return;
          var target = findEditableNow();
          if (!target) return;
          if (target.isContentEditable) { finish(false); return; }
          filling = true;
          verifyAndRetryFill(3).then(function(ok) { finish(ok); });
        });
      }

      timeoutTimer = setTimeout(function() {
        if (filling) return;
        var target = findEditableNow();
        if (!target || target.isContentEditable) { finish(false); return; }
        filling = true;
        verifyAndRetryFill(2).then(function(ok) { finish(ok); });
      }, timeoutMs);

      fallbackInterval = setInterval(onChange, 40);

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
    });
  })(${serializedSel}, ${serializedVal}, ${timeoutMs}, ${checkHitTest}, ${verifyDelayMs})`;
}

/**
 * Sentinel returned by compact `buildInjectedCallScript()` expressions when
 * `window.__spanaRt` has not yet been installed in the current JS execution context.
 */
export const SPANA_RUNTIME_MISSING_SENTINEL = "__SPANA_RT_MISSING__";

/**
 * Persistent in-page Spana DOM runtime installed ONCE per document via
 * `Page.addScriptToEvaluateOnNewDocument` (or lazily on first call).
 * Cuts per-action CDP `Runtime.evaluate` payload by ~100× (~8 KB → ~70 bytes)
 * and lets V8 TurboFan JIT-compile the selector & actionability helpers once.
 */
export const SPANA_INJECTED_RUNTIME_SCRIPT = `(function() {
  if (typeof window === "undefined") return true;
  ${SPANA_WASM_HOOK_SCRIPT}
  if (window.__spanaRt) return true;
  ${SHARED_DOM_TRAVERSAL_HELPERS}

  function query(sel) {
    return findAcrossRoots(sel).map(toMatch);
  }

  function scrollIntoView(sel) {
    var hits = findAcrossRoots(sel);
    if (hits.length === 0) return null;
    var hit = hits[hits.length - 1];
    if (typeof hit.el.scrollIntoView === "function") {
      try { hit.el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); }
      catch (e) { try { hit.el.scrollIntoView(true); } catch (e2) {} }
    }
    return toMatch(hit);
  }

  function tap(sel) {
    var hits = findAcrossRoots(sel, "strict");
    var hit = null;
    for (var i = hits.length - 1; i >= 0; i--) {
      var m = toMatch(hits[i]);
      if (m.visible && m.enabled) { hit = hits[i]; break; }
    }
    if (!hit) return false;
    var el = hit.el;
    if (typeof el.scrollIntoView === "function") {
      try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch (e) {}
    }
    if (!el.isConnected) return false;
    var postMatch = toMatch(hit);
    if (!postMatch.visible || !postMatch.enabled) return false;
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
  }

  function waitForSelector(sel, opts) {
    opts = opts || {};
    var timeoutMs = Math.max(10, Math.round(opts.timeoutMs != null ? opts.timeoutMs : 5000));
    var forAction = Boolean(opts.forAction);
    var force = Boolean(opts.force);
    var failFastWhenIdle = Boolean(opts.failFastWhenIdle);
    var idleQuietMs = Math.max(50, Math.round(opts.idleQuietMs != null ? opts.idleQuietMs : 250));
    var reqStableFrames = force ? 0 : (opts.stableFrames !== undefined ? Math.max(0, Math.round(opts.stableFrames)) : (forAction ? 2 : 0));
    var checkHitTest = force ? false : (opts.checkHitTest !== undefined ? Boolean(opts.checkHitTest) : forAction);
    var waitForAppReady = opts.waitForAppReady !== undefined ? Boolean(opts.waitForAppReady) : true;
    var armTapGuard = Boolean(opts.armTapGuard && forAction && !force);
    var instantAnim = Boolean(typeof document !== "undefined" && document.getElementById && document.getElementById("__spana_instant_anim"));
    var explicitStableFrames = (instantAnim || force) ? 0 : reqStableFrames;

    function armTapGuardOnEl(el) {
      if (!armTapGuard || !el || el.nodeType !== 1) return;
      try {
        var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
        var doc = el.ownerDocument || document;
        if (window.__spanaTapGuardCleanup) window.__spanaTapGuardCleanup();
        window.__spanaTapMissed = false;
        var matchTarget = function(t) {
          return isSameOrDescendant(el, t);
        };
        var cleanup = function() {
          win.removeEventListener("pointerdown", onEvt, true);
          win.removeEventListener("mousedown", onEvt, true);
          win.removeEventListener("mouseup", onMouseUp, true);
          win.removeEventListener("click", onEvt, true);
          if (window.__spanaTapGuardCleanup === cleanup) delete window.__spanaTapGuardCleanup;
        };
        var onMouseUp = function(e) {
          if (!e.isTrusted) return;
          Promise.resolve().then(cleanup);
        };
        var onEvt = function(e) {
          if (!e.isTrusted) return;
          var hit = deepElementFromPoint(doc, e.clientX, e.clientY) || e.target;
          if (!matchTarget(hit) && !matchTarget(e.target)) {
            e.stopImmediatePropagation();
            e.preventDefault();
            window.__spanaTapMissed = true;
            if (e.type === "click") cleanup();
          } else if (e.type === "click") {
            cleanup();
          }
        };
        win.addEventListener("pointerdown", onEvt, true);
        win.addEventListener("mousedown", onEvt, true);
        win.addEventListener("mouseup", onMouseUp, true);
        win.addEventListener("click", onEvt, true);
        window.__spanaTapGuardCleanup = cleanup;
      } catch (e) {}
    }

    function recordActionFailure(reason) {
      if (!forAction) return;
      try { window.__spanaLastActionDiag = reason; } catch (e) {}
    }

    function findCandidates() {
      if (waitForAppReady && !isAppReady()) { recordActionFailure("waiting for app ready (__SPANA_APP_READY__)"); return null; }
      if (forAction && !force && hasActiveViewTransition()) { recordActionFailure("active CSS view transition in progress"); return null; }
      var rawHits = findAcrossRoots(sel, "strict");
      if (rawHits.length === 0) { recordActionFailure(null); return null; }
      var ready = [];
      var lastFail = null;
      for (var i = 0; i < rawHits.length; i++) {
        var h = rawHits[i];
        var m = toMatch(h);
        if (!m.visible) { lastFail = getVisibilityFailureReason(h.el, h.el && h.el.getBoundingClientRect ? h.el.getBoundingClientRect() : null) || "not visible"; continue; }
        if (forAction && !force && !m.enabled) { lastFail = "element is disabled"; continue; }
        ready.push({ hit: h, match: m });
      }
      if (ready.length === 0) recordActionFailure(lastFail);
      return ready.length > 0 ? ready : null;
    }

    function checkActionableNow() {
      var ready = findCandidates();
      if (!ready) return null;
      if (!forAction) return ready.map(function(r) { return r.match; });
      var target = ready[ready.length - 1];
      var alreadyInViewport = isFullyInViewport(target.hit);
      var didScroll = alreadyInViewport ? false : ensureInViewport(target.hit);
      if (!force && checkHitTest && !isHitTestClear(target.hit)) {
        if (!alreadyInViewport || canScrollToUnobscure(target.hit)) {
          if (scrollToUnobscure(target.hit)) {
            didScroll = true;
          }
          if (!target.hit.el.isConnected) { recordActionFailure("element detached from DOM after scrolling"); return null; }
        }
        if (!isHitTestClear(target.hit)) {
          var blocker = getHitTestBlocker(target.hit);
          recordActionFailure(blocker ? ("hit-test blocked by " + blocker) : "hit-test failed (element not receiving pointer events at click point)");
          return null;
        }
      }
      var updated = toMatch(target.hit);
      if (!updated.visible) { recordActionFailure("element became hidden after scroll"); return null; }
      if (!force && !updated.enabled) { recordActionFailure("element became disabled"); return null; }
      recordActionFailure(null);
      return { hits: ready, target: target, match: updated, didScroll: didScroll };
    }

    function neededStableFrames(candidate) {
      if (force || !forAction || typeof requestAnimationFrame !== "function") return 0;
      if (explicitStableFrames >= 0) return explicitStableFrames;
      if (hasActiveAnimation(candidate.target.hit.el)) return 2;
      if (candidate.didScroll) return 1;
      return 0;
    }

    var imm = checkActionableNow();
    if (imm) {
      if (!forAction) return imm;
      if (neededStableFrames(imm) <= 0) {
        armTapGuardOnEl(imm.target.hit.el);
        return [imm.match];
      }
    }

    return new Promise(function(resolve) {
      var done = false;
      var observer = null;
      var timeoutTimer = null;
      var fallbackInterval = null;
      var idleTimer = null;
      var rafId = null;
      var checkingStability = false;

      function finish(result) {
        if (done) return;
        done = true;
        if (observer) { try { observer.disconnect(); } catch (e) {} }
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (fallbackInterval) clearInterval(fallbackInterval);
        if (idleTimer) clearTimeout(idleTimer);
        if (rafId !== null && typeof cancelAnimationFrame === "function") {
          try { cancelAnimationFrame(rafId); } catch (e) {}
        }
        resolve(result);
      }

      function armIdleTimer() {
        if (!failFastWhenIdle) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(function() {
          var rootEl = document.body || document.documentElement;
          if (
            document.readyState === "complete" &&
            (!waitForAppReady || isAppReady()) &&
            !hasActiveAnimation(rootEl) &&
            !hasInflightNetwork(idleQuietMs)
          ) {
            var hit = checkActionableNow();
            if (hit && forAction) armTapGuardOnEl(hit.target.hit.el);
            finish(hit ? (forAction ? [hit.match] : hit) : []);
          } else {
            armIdleTimer();
          }
        }, idleQuietMs);
      }

      function verifyStability(candidate) {
        if (done || checkingStability) return;
        var framesToWait = neededStableFrames(candidate);
        if (!forAction || framesToWait <= 0 || typeof requestAnimationFrame !== "function") {
          if (forAction) armTapGuardOnEl(candidate.target.hit.el);
          finish(forAction ? [candidate.match] : candidate);
          return;
        }
        checkingStability = true;
        var el = candidate.target.hit.el;
        var lastRect = candidate.match.rect;
        var remainingFrames = framesToWait;

        function step() {
          if (done) return;
          if (!el.isConnected) { checkingStability = false; scheduleAttempt(); return; }
          if (checkHitTest && !isHitTestClear(candidate.target.hit)) { checkingStability = false; scheduleAttempt(); return; }
          var cur = toMatch(candidate.target.hit);
          if (!cur.visible || !cur.enabled) { checkingStability = false; scheduleAttempt(); return; }
          var dx = Math.abs(cur.rect.x - lastRect.x);
          var dy = Math.abs(cur.rect.y - lastRect.y);
          var dw = Math.abs(cur.rect.width - lastRect.width);
          var dh = Math.abs(cur.rect.height - lastRect.height);
          if (dx <= 1 && dy <= 1 && dw <= 1 && dh <= 1) {
            remainingFrames -= 1;
            if (remainingFrames <= 0) { armTapGuardOnEl(el); finish([cur]); return; }
          } else {
            recordActionFailure("element bounding box unstable (still moving)");
            remainingFrames = framesToWait;
            lastRect = cur.rect;
          }
          rafId = requestAnimationFrame(step);
        }
        rafId = requestAnimationFrame(step);
      }

      function attempt() {
        if (done || checkingStability) return;
        var hit = checkActionableNow();
        if (hit) {
          if (forAction) verifyStability(hit);
          else finish(hit);
          return;
        }
      }

      var scheduled = false;
      function scheduleAttempt() {
        if (done || checkingStability) return;
        armIdleTimer();
        if (scheduled) return;
        scheduled = true;
        Promise.resolve().then(function() { scheduled = false; attempt(); });
      }

      timeoutTimer = setTimeout(function() {
        var finalHit = checkActionableNow();
        if (finalHit && forAction) armTapGuardOnEl(finalHit.target.hit.el);
        finish(finalHit ? (forAction ? [finalHit.match] : finalHit) : []);
      }, timeoutMs);
      fallbackInterval = setInterval(attempt, forAction ? 40 : 120);
      if (typeof MutationObserver !== "undefined") {
        var root = document.documentElement || document.body || document;
        if (root) {
          observer = new MutationObserver(scheduleAttempt);
          observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
        }
      }
      armIdleTimer();
      attempt();
    });
  }

  function waitForHidden(sel, opts) {
    opts = opts || {};
    var timeoutMs = Math.max(10, Math.round(opts.timeoutMs != null ? opts.timeoutMs : 5000));
    function isHiddenNow() {
      var hits = findAcrossRoots(sel, false);
      for (var i = 0; i < hits.length; i++) {
        if (toMatch(hits[i]).visible) return false;
      }
      return true;
    }
    if (isHiddenNow()) return true;
    return new Promise(function(resolve) {
      var done = false;
      var observer = null;
      var timeoutTimer = null;
      var fallbackInterval = null;
      function finish(val) {
        if (done) return;
        done = true;
        if (observer) { try { observer.disconnect(); } catch (e) {} }
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (fallbackInterval) clearInterval(fallbackInterval);
        resolve(val);
      }
      function onChange() { if (isHiddenNow()) finish(true); }
      timeoutTimer = setTimeout(function() { finish(isHiddenNow()); }, timeoutMs);
      fallbackInterval = setInterval(onChange, 120);
      if (typeof MutationObserver !== "undefined") {
        var root = document.documentElement || document.body || document;
        if (root) {
          observer = new MutationObserver(onChange);
          observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
        }
      }
    });
  }

  function waitForMatch(sel, opts) {
    opts = opts || {};
    var timeoutMs = Math.max(10, Math.round(opts.timeoutMs != null ? opts.timeoutMs : 5000));
    var kind = opts.kind;
    var expected = opts.expected !== undefined ? opts.expected : null;
    var expectedCount = opts.expectedCount !== undefined ? opts.expectedCount : null;
    var attributeName = opts.attributeName !== undefined ? opts.attributeName : null;
    var cssProperty = opts.cssProperty !== undefined ? opts.cssProperty : null;
    var patternSource = opts.patternSource !== undefined ? opts.patternSource : null;
    var patternFlags = opts.patternFlags || "";
    var negate = Boolean(opts.negate);
    var visibleOnly = Boolean(opts.visibleOnly);
    var ignoreCase = Boolean(opts.ignoreCase);
    var propertyName = opts.propertyName !== undefined ? opts.propertyName : null;
    var expectedValue = opts.expectedValue !== undefined ? opts.expectedValue : null;
    var lastActual = undefined;
    var regex = patternSource !== null ? new RegExp(patternSource, patternFlags) : null;
    var allowHidden = kind === "text" || kind === "containsText" || kind === "matchesText" || kind === "value" || kind === "attribute" || kind === "attached" || kind === "jsProperty";

    function evaluateMatch() {
      if (kind === "url") {
        var href = typeof window !== "undefined" && window.location ? String(window.location.href || "") : "";
        lastActual = href;
        var urlOk = regex
          ? regex.test(href)
          : (expected !== null && (href === expected || href.indexOf(String(expected)) !== -1));
        if (negate ? !urlOk : urlOk) return { matched: true, actual: href };
        return null;
      }
      if (kind === "title") {
        var docTitle = String(typeof document !== "undefined" ? (document.title || "") : "");
        lastActual = docTitle;
        var titleOk = regex ? regex.test(docTitle) : (expected !== null && docTitle === String(expected));
        if (negate ? !titleOk : titleOk) return { matched: true, actual: docTitle };
        return null;
      }

      var pvMode = (kind === "attached" || (kind === "count" && !visibleOnly)) ? false : (visibleOnly ? "strict" : "prefer");
      var hits = findAcrossRoots(sel, pvMode);

      if (kind === "count") {
        var matchedCount = 0;
        if (visibleOnly) {
          for (var ci = 0; ci < hits.length; ci++) {
            if (toMatch(hits[ci]).visible) matchedCount++;
          }
        } else {
          matchedCount = hits.length;
        }
        lastActual = String(matchedCount);
        var countOk = expectedCount !== null && matchedCount === expectedCount;
        if (negate ? !countOk : countOk) {
          return { matched: true, actual: String(matchedCount) };
        }
        return null;
      }
      if (kind === "attached") {
        var isAttached = hits.length > 0;
        lastActual = isAttached ? "attached" : "detached";
        if (negate ? !isAttached : isAttached) return { matched: true, actual: lastActual };
        return null;
      }

      var anyVisible2 = false;
      var hiddenFallback2 = [];
      var checkMatch2 = function(h, m) {
        var matched = false;
        var actualVal = undefined;
        if (kind === "text") {
          var normTxt = normWs(m.textContent !== undefined ? m.textContent : (m.text || ""));
          actualVal = normTxt;
          matched = normTxt === (expected !== null ? normWs(expected) : expected);
        } else if (kind === "containsText") {
          var actual = normWs(m.textContent !== undefined ? m.textContent : (m.text || ""));
          actualVal = actual;
          var needle = expected !== null ? normWs(expected) : "";
          matched = expected !== null && (ignoreCase
            ? actual.toLowerCase().indexOf(needle.toLowerCase()) !== -1
            : actual.indexOf(needle) !== -1);
        } else if (kind === "matchesText") {
          var rawRe2 = m.textContent !== undefined ? m.textContent : (m.text || "");
          var actualRe = normWs(rawRe2);
          actualVal = actualRe;
          matched = Boolean(regex && (regex.test(rawRe2) || regex.test(actualRe)));
        } else if (kind === "value") {
          var val = m.value !== undefined ? m.value : "";
          actualVal = val;
          matched = regex ? regex.test(val) : (val === expected);
        } else if (kind === "attribute" && attributeName !== null) {
          var attrVal = m.attributes ? m.attributes[attributeName] : undefined;
          actualVal = attrVal;
          matched = regex
            ? (attrVal !== undefined && regex.test(attrVal))
            : (expected === null ? attrVal !== undefined : attrVal === expected);
        } else if (kind === "accessibilityLabel") {
          var lbl = m.accessibilityLabel;
          actualVal = lbl;
          matched = expected === null ? (lbl !== undefined && lbl.length > 0) : lbl === expected;
        } else if (kind === "accessibleName") {
          var accName = normWs(m.accessibleName || m.accessibilityLabel || m.text || "");
          actualVal = accName;
          matched = regex ? (regex.test(m.accessibleName || m.accessibilityLabel || m.text || "") || regex.test(accName)) : (expected === null ? accName.length > 0 : accName === normWs(expected));
        } else if (kind === "accessibleDescription") {
          var accDesc = normWs(m.accessibleDescription || "");
          actualVal = accDesc;
          matched = regex ? (regex.test(m.accessibleDescription || "") || regex.test(accDesc)) : (expected === null ? accDesc.length > 0 : accDesc === normWs(expected));
        } else if (kind === "focused") {
          actualVal = m.focused ? "focused" : "not focused";
          matched = Boolean(m.focused);
        } else if (kind === "checked") {
          actualVal = m.checked ? "checked" : "unchecked";
          matched = Boolean(m.checked);
        } else if (kind === "enabled") {
          var isEn2 = m.enabled !== false;
          actualVal = isEn2 ? "enabled" : "disabled";
          matched = isEn2;
        } else if (kind === "role") {
          var elRole2 = m.role || getImplicitRole(h.el) || "generic";
          actualVal = elRole2;
          matched = expected !== null && elRole2.toLowerCase() === String(expected).toLowerCase();
        } else if (kind === "editable") {
          actualVal = m.editable ? "editable" : "not editable";
          matched = Boolean(m.editable);
        } else if (kind === "empty") {
          actualVal = m.empty ? "empty" : (m.value || m.textContent || "non-empty");
          matched = Boolean(m.empty);
        } else if (kind === "inViewport") {
          var vpW = window.innerWidth || document.documentElement.clientWidth || 0;
          var vpH = window.innerHeight || document.documentElement.clientHeight || 0;
          var r = m.rect;
          var inVp = r.width > 0 && r.height > 0 && r.x + r.width > 0 && r.y + r.height > 0 && r.x < vpW && r.y < vpH;
          actualVal = inVp ? "in viewport" : "outside viewport";
          matched = inVp;
        } else if (kind === "jsProperty" && propertyName !== null) {
          var propNode = h.el;
          var rawProp = propNode ? propNode[propertyName] : undefined;
          actualVal = typeof rawProp === "string" ? rawProp : JSON.stringify(rawProp);
          matched = JSON.stringify(rawProp) === JSON.stringify(expectedValue);
        } else if (kind === "class") {
          var cls = m.className || "";
          actualVal = cls;
          if (regex) {
            matched = regex.test(cls);
          } else if (expected !== null) {
            var tokens = cls.trim().split(/\\s+/).filter(Boolean);
            var expectedTokens = String(expected).trim().split(/\\s+/).filter(Boolean);
            matched = expectedTokens.length > 0 && expectedTokens.every(function(tok) { return tokens.indexOf(tok) !== -1; });
          }
        } else if (kind === "css" && cssProperty !== null) {
          var elNode = h.el;
          var winObj = (elNode.ownerDocument && elNode.ownerDocument.defaultView) || window;
          var cssVal = winObj && winObj.getComputedStyle ? winObj.getComputedStyle(elNode).getPropertyValue(cssProperty).trim() : "";
          actualVal = cssVal;
          matched = regex ? regex.test(cssVal) : (expected !== null && cssVal === String(expected).trim());
        }
        lastActual = actualVal;
        if (negate ? !matched : matched) return { matched: true, actual: actualVal };
        return null;
      };
      for (var i = hits.length - 1; i >= 0; i--) {
        var m = toMatch(hits[i]);
        if (!allowHidden && !m.visible) {
          if (kind === "enabled" || kind === "checked") hiddenFallback2.push({ h: hits[i], m: m });
          continue;
        }
        if (m.visible) anyVisible2 = true;
        var resHit2 = checkMatch2(hits[i], m);
        if (resHit2) return resHit2;
      }
      if (!anyVisible2 && hiddenFallback2.length > 0) {
        for (var hi2 = 0; hi2 < hiddenFallback2.length; hi2++) {
          var hRes2 = checkMatch2(hiddenFallback2[hi2].h, hiddenFallback2[hi2].m);
          if (hRes2) return hRes2;
        }
      }
      return null;
    }

    var immediate = evaluateMatch();
    if (immediate) return immediate;

    return new Promise(function(resolve) {
      var done = false;
      var observer = null;
      var timeoutTimer = null;
      var fallbackInterval = null;
      var scheduled = false;
      function finish(res) {
        if (done) return;
        done = true;
        if (observer) { try { observer.disconnect(); } catch (e) {} }
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (fallbackInterval) clearInterval(fallbackInterval);
        if (typeof document !== "undefined") {
          document.removeEventListener("input", onChange, true);
          document.removeEventListener("change", onChange, true);
          document.removeEventListener("focusin", onChange, true);
          document.removeEventListener("focusout", onChange, true);
        }
        if (typeof window !== "undefined") {
          window.removeEventListener("popstate", onChange);
          window.removeEventListener("hashchange", onChange);
        }
        resolve(res);
      }
      function onChange() {
        if (done || scheduled) return;
        scheduled = true;
        Promise.resolve().then(function() {
          scheduled = false;
          if (done) return;
          var res = evaluateMatch();
          if (res) finish(res);
        });
      }
      timeoutTimer = setTimeout(function() {
        var finalRes = evaluateMatch();
        finish(finalRes || { matched: false, actual: lastActual });
      }, timeoutMs);
      fallbackInterval = setInterval(onChange, kind === "url" ? 50 : 120);
      if (typeof document !== "undefined") {
        document.addEventListener("input", onChange, true);
        document.addEventListener("change", onChange, true);
        document.addEventListener("focusin", onChange, true);
        document.addEventListener("focusout", onChange, true);
      }
      if (typeof window !== "undefined") {
        window.addEventListener("popstate", onChange);
        window.addEventListener("hashchange", onChange);
      }
      if (typeof MutationObserver !== "undefined") {
        var root = document.documentElement || document.body || document;
        if (root) {
          observer = new MutationObserver(onChange);
          observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
        }
      }
    });
  }

  function fill(sel, val, opts) {
    opts = opts || {};
    var timeoutMs = Math.max(10, Math.round(opts.timeoutMs != null ? opts.timeoutMs : 5000));
    var checkHitTest = opts.checkHitTest !== undefined ? Boolean(opts.checkHitTest) : true;
    var verifyDelayMs = opts.verifyDelayMs !== undefined ? Math.max(0, Math.round(opts.verifyDelayMs)) : 12;
    function writeValue(el) {
      if (el.isContentEditable) return false;
      if (typeof el.focus === "function") { try { el.focus(); } catch (e) {} }
      var tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
        var proto = tag === "TEXTAREA"
          ? (win.HTMLTextAreaElement && win.HTMLTextAreaElement.prototype)
          : (win.HTMLInputElement && win.HTMLInputElement.prototype);
        var desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
        if (desc && typeof desc.set === "function") {
          try { desc.set.call(el, val); } catch (e) { el.value = val; }
        }
        else el.value = val;
        if (el._valueTracker && typeof el._valueTracker.setValue === "function") {
          try { el._valueTracker.setValue(val === "" ? " " : ""); } catch (e) {}
        }
      } else if (tag === "SELECT") {
        el.value = val;
      } else {
        el.value = val;
      }
      try { el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: val, inputType: "insertText" })); }
      catch (e) { el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true })); }
      el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
      return true;
    }
    function findEditableNow() {
      if (!isAppReady()) return null;
      var hits = findAcrossRoots(sel, "strict");
      for (var i = hits.length - 1; i >= 0; i--) {
        var h = hits[i];
        var m = toMatch(h);
        if (!m.visible || !m.enabled) continue;
        var alreadyInVp = isFullyInViewport(h);
        if (!alreadyInVp) ensureInViewport(h);
        if (checkHitTest && !isHitTestClear(h)) {
          if (!alreadyInVp || canScrollToUnobscure(h)) scrollToUnobscure(h);
          if (!h.el.isConnected || !isHitTestClear(h)) continue;
        }
        return h.el;
      }
      return null;
    }
    function verifyAndRetryFill(attemptsLeft) {
      var el = findEditableNow();
      if (!el || el.isContentEditable) return Promise.resolve(false);
      if (!writeValue(el)) return Promise.resolve(false);
      if (verifyDelayMs <= 0) {
        var syncLatest = findEditableNow() || el;
        if (syncLatest && syncLatest.isConnected && String(syncLatest.value == null ? "" : syncLatest.value) === val) {
          return Promise.resolve(true);
        }
        return attemptsLeft > 1 ? verifyAndRetryFill(attemptsLeft - 1) : Promise.resolve(false);
      }
      return new Promise(function(resolve) {
        setTimeout(function() {
          var latest = findEditableNow() || el;
          if (latest && latest.isConnected && String(latest.value == null ? "" : latest.value) === val) {
            resolve(true);
            return;
          }
          if (attemptsLeft > 1) {
            verifyAndRetryFill(attemptsLeft - 1).then(resolve);
          } else {
            resolve(false);
          }
        }, verifyDelayMs);
      });
    }
    var immEl = findEditableNow();
    if (immEl) {
      if (immEl.isContentEditable) return false;
      return verifyAndRetryFill(3);
    }
    return new Promise(function(resolve) {
      var done = false;
      var observer = null;
      var timeoutTimer = null;
      var fallbackInterval = null;
      var scheduled = false;
      var filling = false;
      function finish(ok) {
        if (done) return;
        done = true;
        if (observer) { try { observer.disconnect(); } catch (e) {} }
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (fallbackInterval) clearInterval(fallbackInterval);
        resolve(ok);
      }
      function onChange() {
        if (done || scheduled || filling) return;
        scheduled = true;
        Promise.resolve().then(function() {
          scheduled = false;
          if (done || filling) return;
          var target = findEditableNow();
          if (!target) return;
          if (target.isContentEditable) { finish(false); return; }
          filling = true;
          verifyAndRetryFill(3).then(function(ok) { finish(ok); });
        });
      }
      timeoutTimer = setTimeout(function() {
        if (filling) return;
        var target = findEditableNow();
        if (!target || target.isContentEditable) { finish(false); return; }
        filling = true;
        verifyAndRetryFill(2).then(function(ok) { finish(ok); });
      }, timeoutMs);
      fallbackInterval = setInterval(onChange, 40);
      if (typeof MutationObserver !== "undefined") {
        var root = document.documentElement || document.body || document;
        if (root) {
          observer = new MutationObserver(onChange);
          observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
        }
      }
    });
  }

  function checkTapGuard() {
    var m = Boolean(window.__spanaTapMissed);
    if (window.__spanaTapGuardCleanup) window.__spanaTapGuardCleanup();
    delete window.__spanaTapMissed;
    return m;
  }

  window.__spanaRt = {
    query: query,
    scrollIntoView: scrollIntoView,
    tap: tap,
    waitForSelector: waitForSelector,
    waitForHidden: waitForHidden,
    waitForMatch: waitForMatch,
    fill: fill,
    checkTapGuard: checkTapGuard
  };
  return true;
})();`;

export type InjectedRuntimeMethod =
  | "query"
  | "scrollIntoView"
  | "tap"
  | "waitForSelector"
  | "waitForHidden"
  | "waitForMatch"
  | "fill";

export type SelectOptionInput =
  | string
  | string[]
  | { value?: string; label?: string; index?: number }
  | Array<{ value?: string; label?: string; index?: number }>;

/** Build an in-page script selecting `<option>`(s) on a `<select>` element by value, label, or index. */
export function buildDomSelectOptionScript(selector: Selector, option: SelectOptionInput): string {
  const serializedSel = JSON.stringify(serializeSelectorForDom(selector));
  const specs = (Array.isArray(option) ? option : [option]).map((item) =>
    typeof item === "string" ? { valueOrLabel: item } : item,
  );
  const serializedSpecs = JSON.stringify(specs);
  return `(function(sel, specs) {
    ${SHARED_DOM_TRAVERSAL_HELPERS}
    var hits = findAcrossRoots(sel);
    if (hits.length === 0) return { ok: false, error: "Select element not found" };
    var el = null;
    for (var hi = 0; hi < hits.length; hi++) {
      if (hits[hi] && hits[hi].el && hits[hi].el.tagName === "SELECT") { el = hits[hi].el; break; }
    }
    if (!el) el = hits[0].el;
    if (!el || el.tagName !== "SELECT") return { ok: false, error: "Matched element is not a <select>" };
    var opts = Array.prototype.slice.call(el.options || []);
    var matchedIndices = [];
    for (var s = 0; s < specs.length; s++) {
      var sp = specs[s];
      var foundIdx = -1;
      if (typeof sp.index === "number") {
        if (sp.index >= 0 && sp.index < opts.length) foundIdx = sp.index;
      } else if (typeof sp.value === "string") {
        for (var i = 0; i < opts.length; i++) { if (opts[i].value === sp.value) { foundIdx = i; break; } }
      } else if (typeof sp.label === "string") {
        for (var j = 0; j < opts.length; j++) { if ((opts[j].label || opts[j].text || "").trim() === sp.label.trim()) { foundIdx = j; break; } }
      } else if (typeof sp.valueOrLabel === "string") {
        for (var k = 0; k < opts.length; k++) { if (opts[k].value === sp.valueOrLabel) { foundIdx = k; break; } }
        if (foundIdx === -1) {
          for (var m = 0; m < opts.length; m++) { if ((opts[m].label || opts[m].text || "").trim() === sp.valueOrLabel.trim()) { foundIdx = m; break; } }
        }
      }
      if (foundIdx === -1) return { ok: false, error: "Option not found: " + JSON.stringify(sp) };
      matchedIndices.push(foundIdx);
    }
    if (el.multiple) {
      for (var n = 0; n < opts.length; n++) opts[n].selected = matchedIndices.indexOf(n) !== -1;
    } else if (matchedIndices.length > 0) {
      el.selectedIndex = matchedIndices[0];
    }
    el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    var selected = [];
    for (var p = 0; p < opts.length; p++) { if (opts[p].selected) selected.push(opts[p].value); }
    return { ok: true, selected: selected };
  })(${serializedSel}, ${serializedSpecs})`;
}

/** Build an in-page script that focuses the matched element cleanly. */
export function buildDomFocusScript(selector: Selector): string {
  const serializedSel = JSON.stringify(serializeSelectorForDom(selector));
  return `(function(sel) {
    ${SHARED_DOM_TRAVERSAL_HELPERS}
    var hits = findAcrossRoots(sel);
    if (hits.length === 0) return false;
    var el = hits[hits.length - 1].el;
    if (typeof el.focus === "function") { el.focus(); return true; }
    return false;
  })(${serializedSel})`;
}

/** Build an in-page script that arms the moving-target tap guard directly on the matched selector element. */
export function buildDomArmTapGuardBySelectorScript(selector: Selector): string {
  const serialized = JSON.stringify(serializeSelectorForDom(selector));
  return `(function(sel) {
    ${SHARED_DOM_TRAVERSAL_HELPERS}
    try {
      var hits = findAcrossRoots(sel, "strict");
      var visible = [];
      for (var i = 0; i < hits.length; i++) {
        if (toMatch(hits[i]).visible) visible.push(hits[i]);
      }
      var target = visible.length > 0 ? visible[visible.length - 1] : hits[hits.length - 1];
      if (!target || !target.el || target.el.nodeType !== 1) return false;
      var el = target.el;
      var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      var doc = el.ownerDocument || document;
      if (window.__spanaTapGuardCleanup) window.__spanaTapGuardCleanup();
      window.__spanaTapMissed = false;
      var matchTarget = function(t) { return isSameOrDescendant(el, t); };
      var cleanup = function() {
        win.removeEventListener("pointerdown", onEvt, true);
        win.removeEventListener("mousedown", onEvt, true);
        win.removeEventListener("mouseup", onMouseUp, true);
        win.removeEventListener("click", onEvt, true);
        if (window.__spanaTapGuardCleanup === cleanup) delete window.__spanaTapGuardCleanup;
      };
      var onMouseUp = function(e) {
        if (!e.isTrusted) return;
        Promise.resolve().then(cleanup);
      };
      var onEvt = function(e) {
        if (!e.isTrusted) return;
        var hit = deepElementFromPoint(doc, e.clientX, e.clientY) || e.target;
        if (!matchTarget(hit) && !matchTarget(e.target)) {
          e.stopImmediatePropagation();
          e.preventDefault();
          window.__spanaTapMissed = true;
          if (e.type === "click") cleanup();
        } else if (e.type === "click") {
          cleanup();
        }
      };
      win.addEventListener("pointerdown", onEvt, true);
      win.addEventListener("mousedown", onEvt, true);
      win.addEventListener("mouseup", onMouseUp, true);
      win.addEventListener("click", onEvt, true);
      window.__spanaTapGuardCleanup = cleanup;
      return true;
    } catch (e) { return false; }
  })(${serialized})`;
}

/** Build an in-page diagnostic script reporting why an existing element failed actionability (covered/disabled/hidden/pointer-events/unstable). */
export function buildDomActionabilityDiagScript(selector: Selector): string {
  const serialized = JSON.stringify(serializeSelectorForDom(selector));
  return `(function(sel) {
    ${SHARED_DOM_TRAVERSAL_HELPERS}
    var detachedAfterScroll = Boolean(typeof window !== "undefined" && window.__spanaLastScrollDetached);
    var lastActionFailure = typeof window !== "undefined" && typeof window.__spanaLastActionDiag === "string" ? window.__spanaLastActionDiag : undefined;
    if (typeof window !== "undefined") {
      try { delete window.__spanaLastScrollDetached; } catch (e) {}
      try { delete window.__spanaLastActionDiag; } catch (e) {}
    }
    var hits = findAcrossRoots(sel);
    if (hits.length === 0) return { found: false, matchCount: 0, visibleCount: 0, detachedAfterScroll: detachedAfterScroll || undefined, lastActionFailure: lastActionFailure };
    var visibleCount = 0;
    for (var i = 0; i < hits.length; i++) {
      if (toMatch(hits[i]).visible) visibleCount += 1;
    }
    var target = hits[hits.length - 1];
    var m = toMatch(target);
    var rawRect = target.el && target.el.getBoundingClientRect ? target.el.getBoundingClientRect() : null;
    var win = (target.el && target.el.ownerDocument && target.el.ownerDocument.defaultView) || window;
    var cs = target.el && target.el.nodeType === 1 && win && win.getComputedStyle ? win.getComputedStyle(target.el) : null;
    var pointerEventsNone = Boolean(cs && cs.pointerEvents === "none");
    if (!m.visible) {
      var hiddenReason = getVisibilityFailureReason(target.el, rawRect) || undefined;
      return { found: true, visible: false, enabled: m.enabled, hiddenReason: hiddenReason, pointerEventsNone: pointerEventsNone || undefined, matchCount: hits.length, visibleCount: visibleCount, detachedAfterScroll: detachedAfterScroll || undefined, lastActionFailure: lastActionFailure };
    }
    if (!m.enabled) return { found: true, visible: true, enabled: false, pointerEventsNone: pointerEventsNone || undefined, matchCount: hits.length, visibleCount: visibleCount, detachedAfterScroll: detachedAfterScroll || undefined, lastActionFailure: lastActionFailure };
    var blocker = getHitTestBlocker(target);
    return { found: true, visible: true, enabled: true, obstructedBy: blocker || undefined, pointerEventsNone: pointerEventsNone || undefined, matchCount: hits.length, visibleCount: visibleCount, detachedAfterScroll: detachedAfterScroll || undefined, lastActionFailure: lastActionFailure };
  })(${serialized})`;
}

/** Build an in-page script returning the matching DOM Element (used for CDP `DOM.setFileInputFiles`). */
export function buildDomFindElementScript(selector: Selector): string {
  const serialized = JSON.stringify(serializeSelectorForDom(selector));
  return `(function(sel) {
    ${SHARED_DOM_TRAVERSAL_HELPERS}
    var hits = findAcrossRoots(sel);
    if (hits.length === 0) return null;
    return hits[hits.length - 1].el;
  })(${serialized})`;
}

/** Build a ~70-byte call to the pre-injected `window.__spanaRt` runtime. */
export function buildInjectedCallScript(method: InjectedRuntimeMethod, ...args: unknown[]): string {
  const serializedArgs = args.map((arg) => JSON.stringify(serializeSelectorForDom(arg))).join(",");
  return `window.__spanaRt?window.__spanaRt.${method}(${serializedArgs}):${JSON.stringify(SPANA_RUNTIME_MISSING_SENTINEL)}`;
}
