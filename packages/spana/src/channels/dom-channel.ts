import type { Element, Bounds } from "../schemas/element.js";
import type { Selector } from "../schemas/selector.js";
import type {
  BrowserConsoleLog,
  BrowserJSError,
  BrowserMockResponse,
  BrowserRouteMatcher,
} from "../drivers/raw-driver.js";

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
    | "class"
    | "css"
    | "editable"
    | "empty"
    | "count"
    | "url"
    | "title";
  /** Expected value/substring (optional when `kind === "attribute"` or `"accessibilityLabel"` checks presence). */
  expected?: string;
  /** Expected element count when `kind === "count"`. */
  expectedCount?: number;
  /** Attribute name when `kind === "attribute"`. */
  attributeName?: string;
  /** CSS property name when `kind === "css"`. */
  cssProperty?: string;
  /** RegExp source when `kind === "matchesText" | "accessibleName" | "accessibleDescription" | "class" | "css" | "url" | "title"`. */
  patternSource?: string;
  /** RegExp flags when `kind === "matchesText" | "accessibleName" | "accessibleDescription" | "class" | "css" | "url" | "title"`. */
  patternFlags?: string;
  /** Invert the match condition (`expect(...).not.*`). */
  negate?: boolean;
}

export interface DomFillOptions {
  /** Max time to wait for an editable actionable target in ms. Default: 5000. */
  timeoutMs?: number;
  /** Verify center point via deep `elementFromPoint` before filling. Default: true. */
  checkHitTest?: boolean;
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
  function matchSpec(actual, spec, exact) {
    var str = String(actual || "");
    if (spec && typeof spec === "object" && typeof spec.__spanaRegex === "string") {
      try { return new RegExp(spec.__spanaRegex, spec.flags || "").test(str); } catch (e) { return false; }
    }
    var needle = String(spec == null ? "" : spec);
    if (exact) return str.trim() === needle.trim();
    return str.toLowerCase().indexOf(needle.toLowerCase()) !== -1;
  }
  function getImplicitRole(el) {
    if (!el || !el.getAttribute) return "";
    var explicit = (el.getAttribute("role") || "").trim().toLowerCase();
    if (explicit) return explicit.split(/\\s+/)[0] || "";
    var tag = el.tagName ? el.tagName.toUpperCase() : "";
    if (tag === "BUTTON") return "button";
    if (tag === "A") return el.hasAttribute("href") ? "link" : "";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SELECT") return (el.hasAttribute("multiple") || Number(el.getAttribute("size") || 0) > 1) ? "listbox" : "combobox";
    if (tag === "OPTION") return "option";
    if (tag === "IMG") return el.getAttribute("alt") === "" ? "presentation" : "img";
    if (tag === "DIALOG") return "dialog";
    if (tag === "NAV") return "navigation";
    if (tag === "MAIN") return "main";
    if (tag === "HEADER") return "banner";
    if (tag === "FOOTER") return "contentinfo";
    if (tag === "ASIDE") return "complementary";
    if (tag === "UL" || tag === "OL") return "list";
    if (tag === "LI") return "listitem";
    if (tag === "TABLE") return "table";
    if (tag === "TR") return "row";
    if (tag === "TD") return "cell";
    if (tag === "TH") return "columnheader";
    if (tag === "ARTICLE") return "article";
    if (tag === "FORM") return "form";
    if (tag === "PROGRESS") return "progressbar";
    if (tag === "HR") return "separator";
    if (tag === "SECTION") return (el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby")) ? "region" : "";
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "INPUT") {
      var t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "search") return "searchbox";
      if (t === "number") return "spinbutton";
      if (t === "range") return "slider";
      if (t === "hidden") return "";
      return "textbox";
    }
    return "";
  }
  function visibleTextOf(node, allowHiddenRoot, skipControl) {
    if (!node) return "";
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1 && node.nodeType !== 11) return "";
    if (node.nodeType === 1) {
      if (skipControl && node === skipControl) return "";
      var t = node.tagName ? node.tagName.toUpperCase() : "";
      if (t === "SCRIPT" || t === "STYLE" || t === "NOSCRIPT" || t === "TEMPLATE") return "";
      if (skipControl && (t === "SELECT" || t === "TEXTAREA" || t === "INPUT")) return "";
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
      var k = visibleTextOf(kids[i], false, skipControl);
      if (k) out.push(k);
    }
    return out.join(" ").replace(/\\s+/g, " ").trim();
  }
  function isAriaHidden(el) {
    if (!el) return true;
    var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var cur = el;
    var guard = 0;
    while (cur && guard++ < 32) {
      if (cur.getAttribute) {
        if (cur.getAttribute("aria-hidden") === "true") return true;
        if (cur.hasAttribute && cur.hasAttribute("inert")) return true;
      }
      if (cur.nodeType === 1 && win && win.getComputedStyle) {
        var cs = win.getComputedStyle(cur);
        if (cs && cs.display === "none") return true;
      }
      var root = typeof cur.getRootNode === "function" ? cur.getRootNode() : null;
      cur = cur.parentElement || (root && root.host) || null;
    }
    if (typeof el.checkVisibility === "function") {
      try {
        if (!el.checkVisibility({ visibilityProperty: true })) return true;
      } catch (e) {}
    } else if (win && win.getComputedStyle) {
      var selfCs = win.getComputedStyle(el);
      if (selfCs && (selfCs.visibility === "hidden" || selfCs.visibility === "collapse")) return true;
    }
    return false;
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
  function collectRoots(root, offsetX, offsetY, inShadow, inIframe, out) {
    if (!root) return;
    out.push({ root: root, offsetX: offsetX, offsetY: offsetY, inShadow: inShadow, inIframe: inIframe });
    if (root.shadowRoot) {
      collectRoots(root.shadowRoot, offsetX, offsetY, true, inIframe, out);
    }
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
  function findTextInRoot(root, needle, exact, ctx, pushHit) {
    var doc = root.ownerDocument || (root.nodeType === 9 ? root : document);
    if (doc && typeof doc.createTreeWalker === "function" && typeof NodeFilter !== "undefined") {
      var walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      var txtNode;
      while ((txtNode = walker.nextNode())) {
        var rawVal = (txtNode.nodeValue || "").trim();
        var val = rawVal.toLowerCase();
        var ok = exact ? rawVal === needle : (val && val.indexOf(needle.toLowerCase()) !== -1);
        if (ok && txtNode.parentElement) {
          pushHit(txtNode.parentElement, ctx);
        }
      }
      if (typeof root.querySelectorAll === "function") {
        var inputs = root.querySelectorAll("input, button");
        for (var ii = 0; ii < inputs.length; ii++) {
          var inp = inputs[ii];
          var rawInp = String(inp.value || "").trim();
          var inpOk = exact ? rawInp === needle : (rawInp && rawInp.toLowerCase().indexOf(needle.toLowerCase()) !== -1);
          if (inpOk) {
            pushHit(inp, ctx);
          }
        }
      }
      return;
    }
    var all = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (var k = 0; k < all.length; k++) {
      var node = all[k];
      var directText = "";
      for (var c = 0; c < node.childNodes.length; c++) {
        if (node.childNodes[c].nodeType === 3) directText += node.childNodes[c].textContent || "";
      }
      var trimmedDirect = directText.trim();
      var inpVal = (node.tagName === "INPUT" || node.tagName === "BUTTON") ? String(node.value || "").trim() : "";
      var directOk = exact ? trimmedDirect === needle : (trimmedDirect && trimmedDirect.toLowerCase().indexOf(needle.toLowerCase()) !== -1);
      var inputOk = exact ? inpVal === needle : (inpVal && inpVal.toLowerCase().indexOf(needle.toLowerCase()) !== -1);
      if (directOk || inputOk) {
        pushHit(node, ctx);
      }
    }
  }
  function findRoleInRoot(root, roleLower, nameSpec, exact, ctx, pushHit, includeHidden, level) {
    if (!root || !root.querySelectorAll) return;
    var candidates = root.querySelectorAll("*");
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (getImplicitRole(el) !== roleLower) continue;
      if (!includeHidden && isAriaHidden(el)) continue;
      if (level !== undefined && level !== null && headingLevelOf(el) !== Number(level)) continue;
      if (nameSpec !== undefined && nameSpec !== null) {
        var accName = getAccessibleName(el);
        if (!matchSpec(accName, nameSpec, Boolean(exact))) continue;
      }
      pushHit(el, ctx);
    }
  }
  function applyModifiersAndSlice(hits, sel) {
    if (!sel || typeof sel !== "object" || "point" in sel) return hits;
    var filtered = hits;
    if (sel.hasText !== undefined) {
      filtered = filtered.filter(function(h) {
        var txt = (h.el.innerText || h.el.textContent || h.el.value || getAccessibleName(h.el) || "");
        return matchSpec(txt, sel.hasText, false);
      });
    }
    if (sel.hasNotText !== undefined) {
      filtered = filtered.filter(function(h) {
        var txt = (h.el.innerText || h.el.textContent || h.el.value || getAccessibleName(h.el) || "");
        return !matchSpec(txt, sel.hasNotText, false);
      });
    }
    if (sel.has !== undefined) {
      filtered = filtered.filter(function(h) {
        return findInScope(sel.has, h.el, h.offsetX, h.offsetY, h.inShadow, h.inIframe).length > 0;
      });
    }
    if (sel.hasNot !== undefined) {
      filtered = filtered.filter(function(h) {
        return findInScope(sel.hasNot, h.el, h.offsetX, h.offsetY, h.inShadow, h.inIframe).length === 0;
      });
    }
    if (sel.first) return filtered.length > 0 ? [filtered[0]] : [];
    if (sel.last) return filtered.length > 0 ? [filtered[filtered.length - 1]] : [];
    if (typeof sel.nth === "number") {
      var idx = sel.nth < 0 ? filtered.length + sel.nth : sel.nth;
      return idx >= 0 && idx < filtered.length ? [filtered[idx]] : [];
    }
    return filtered;
  }
  function findInScope(sel, scopeRoot, baseOffsetX, baseOffsetY, baseInShadow, baseInIframe) {
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
    // Frame scoping: find matching <iframe> first, then search inside its contentDocument
    if (typeof sel === "object" && sel !== null && sel.frame) {
      var frameHits = findInScope(sel.frame, scopeRoot, baseOffsetX, baseOffsetY, baseInShadow, baseInIframe);
      var innerSel = Object.assign({}, sel);
      delete innerSel.frame;
      for (var fi = 0; fi < frameHits.length; fi++) {
        var fEl = frameHits[fi].el;
        if (fEl && fEl.tagName === "IFRAME") {
          try {
            var fDoc = fEl.contentDocument;
            if (fDoc) {
              var fRect = fEl.getBoundingClientRect();
              var sub = findInScope(innerSel, fDoc, frameHits[fi].offsetX + fRect.left, frameHits[fi].offsetY + fRect.top, frameHits[fi].inShadow, true);
              for (var si = 0; si < sub.length; si++) pushHit(sub[si].el, sub[si]);
            }
          } catch (e) {}
        }
      }
      return hits;
    }
    // Parent scoping: resolve 'within' first, then search inside each matched container
    if (typeof sel === "object" && sel !== null && sel.within) {
      var parentHits = findInScope(sel.within, scopeRoot, baseOffsetX, baseOffsetY, baseInShadow, baseInIframe);
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
        var subHits = findInScope(childSel, ph.el, ph.offsetX, ph.offsetY, ph.inShadow, ph.inIframe);
        for (var ci = 0; ci < subHits.length; ci++) {
          if (cSeen && cSeen.has(subHits[ci].el)) continue;
          if (cSeen) cSeen.add(subHits[ci].el);
          combined.push(subHits[ci]);
        }
      }
      return applyModifiersAndSlice(combined, sel);
    }
    // Logical OR composition (anyOf): union deduplicated hits across branches
    if (typeof sel === "object" && sel !== null && Array.isArray(sel.anyOf)) {
      for (var bi = 0; bi < sel.anyOf.length; bi++) {
        var branchHits = findInScope(sel.anyOf[bi], scopeRoot, baseOffsetX, baseOffsetY, baseInShadow, baseInIframe);
        for (var bh = 0; bh < branchHits.length; bh++) {
          pushHit(branchHits[bh].el, branchHits[bh]);
        }
      }
      return applyModifiersAndSlice(hits, sel);
    }

    var esc = function(v) {
      return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : String(v).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"');
    };
    var mainCtx = { root: scopeRoot, offsetX: baseOffsetX, offsetY: baseOffsetY, inShadow: baseInShadow, inIframe: baseInIframe };
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
        try {
          var fastCss = scopeRoot.querySelectorAll(sel.css);
          if (fastCss.length > 0) {
            for (var fc = 0; fc < fastCss.length; fc++) pushHit(fastCss[fc], mainCtx);
            return hits;
          }
        } catch (e) {}
      } else if (typeof sel === "object" && sel !== null && "accessibilityLabel" in sel) {
        var fastLbl = esc(sel.accessibilityLabel);
        var fastFoundLbl = scopeRoot.querySelectorAll('[aria-label="' + fastLbl + '"]');
        if (fastFoundLbl.length > 0) {
          for (var fj = 0; fj < fastFoundLbl.length; fj++) pushHit(fastFoundLbl[fj], mainCtx);
          return hits;
        }
      } else if (typeof sel === "object" && sel !== null && "role" in sel) {
        findRoleInRoot(scopeRoot, String(sel.role).toLowerCase(), sel.name, sel.exact, mainCtx, pushHit, sel.includeHidden, sel.level);
        if (hits.length > 0) return hits;
      } else if (typeof sel === "string" || (typeof sel === "object" && sel !== null && "text" in sel)) {
        var fastNeedle = typeof sel === "string" ? sel : sel.text;
        var fastExact = typeof sel === "object" && sel !== null && Boolean(sel.exact);
        findTextInRoot(scopeRoot, fastNeedle, fastExact, mainCtx, pushHit);
        if (hits.length > 0) return hits;
      }
    }

    var roots = [];
    collectRoots(scopeRoot, baseOffsetX, baseOffsetY, baseInShadow, baseInIframe, roots);
    for (var r = 0; r < roots.length; r++) {
      var ctx = roots[r];
      var root = ctx.root;
      if (!root || !root.querySelectorAll) continue;
      if (typeof sel === "object" && sel !== null && "testID" in sel) {
        var tid = esc(sel.testID);
        var found = root.querySelectorAll('[data-testid="' + tid + '"], [testID="' + tid + '"]');
        for (var i = 0; i < found.length; i++) pushHit(found[i], ctx);
      } else if (typeof sel === "object" && sel !== null && "css" in sel) {
        try {
          var foundCss = root.querySelectorAll(sel.css);
          for (var ci2 = 0; ci2 < foundCss.length; ci2++) pushHit(foundCss[ci2], ctx);
        } catch (e) {}
      } else if (typeof sel === "object" && sel !== null && "accessibilityLabel" in sel) {
        var lbl = esc(sel.accessibilityLabel);
        var foundLbl = root.querySelectorAll('[aria-label="' + lbl + '"]');
        for (var j = 0; j < foundLbl.length; j++) pushHit(foundLbl[j], ctx);
      } else if (typeof sel === "object" && sel !== null && "role" in sel) {
        findRoleInRoot(root, String(sel.role).toLowerCase(), sel.name, sel.exact, ctx, pushHit, sel.includeHidden, sel.level);
      } else if (typeof sel === "string" || (typeof sel === "object" && sel !== null && "text" in sel)) {
        var needle = typeof sel === "string" ? sel : sel.text;
        var isExact = typeof sel === "object" && sel !== null && Boolean(sel.exact);
        findTextInRoot(root, needle, isExact, ctx, pushHit);
      }
    }
    return applyModifiersAndSlice(hits, sel);
  }
  function findAcrossRoots(sel) {
    return findInScope(sel, document, 0, 0, false, false);
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
            var fr = el.getBoundingClientRect();
            var fx = x - fr.left;
            var fy = y - fr.top;
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
    var el = hit.el;
    var rect = el.getBoundingClientRect();
    var vw = (window.visualViewport && window.visualViewport.width) || window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight || document.documentElement.clientHeight || 0;
    var cx = rect.left + hit.offsetX + rect.width / 2;
    var cy = rect.top + hit.offsetY + rect.height / 2;
    if (vw > 0 && vh > 0 && (cx < 0 || cy < 0 || cx > vw || cy > vh)) {
      return "outside viewport";
    }
    var topEl = deepElementFromPoint(document, cx, cy);
    if (!topEl) return null;
    if (isSameOrDescendant(el, topEl)) return null;
    return describeEl(topEl);
  }
  function isHitTestClear(hit) {
    var el = hit.el;
    var rect = el.getBoundingClientRect();
    var vw = (window.visualViewport && window.visualViewport.width) || window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight || document.documentElement.clientHeight || 0;
    var cx = rect.left + hit.offsetX + rect.width / 2;
    var cy = rect.top + hit.offsetY + rect.height / 2;
    if (vw > 0 && vh > 0 && (cx < 0 || cy < 0 || cx > vw || cy > vh)) {
      return false;
    }
    var topEl = deepElementFromPoint(document, cx, cy);
    if (!topEl) return true;
    return isSameOrDescendant(el, topEl);
  }
  function ensureInViewport(hit) {
    var el = hit.el;
    var rect = el.getBoundingClientRect();
    var vw = (window.visualViewport && window.visualViewport.width) || window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight || document.documentElement.clientHeight || 0;
    var cx = rect.left + hit.offsetX + rect.width / 2;
    var cy = rect.top + hit.offsetY + rect.height / 2;
    if (vw > 0 && vh > 0 && (cx < 1 || cy < 1 || cx > vw - 1 || cy > vh - 1)) {
      if (typeof el.scrollIntoView === "function") {
        try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); }
        catch (e) { try { el.scrollIntoView(true); } catch (e2) {} }
      }
      return true;
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
      if (isHitTestClear(hit)) return true;
    }
    return false;
  }
  function hasActiveAnimation(el) {
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
    var normTextContent = (el.textContent || "").replace(/\\s+/g, " ").trim() || undefined;
    var accName = getAccessibleName(el) || undefined;
    var accDesc = getAccessibleDescription(el) || undefined;
    var role = getImplicitRole(el) || undefined;
    var isChecked =
      el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")
        ? Boolean(el.checked)
        : el.getAttribute("aria-checked") === "true"
          ? true
          : el.getAttribute("aria-checked") === "false"
            ? false
            : undefined;
    var isEditable = Boolean(
      !el.hasAttribute("disabled") &&
      el.getAttribute("aria-disabled") !== "true" &&
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
  const failFastWhenIdle = Boolean(opts.failFastWhenIdle);
  const idleQuietMs = Math.max(50, Math.round(opts.idleQuietMs ?? 250));
  const stableFrames =
    opts.stableFrames !== undefined
      ? Math.max(0, Math.round(opts.stableFrames))
      : forAction
        ? defaultActionStableFrames()
        : 0;
  const checkHitTest = opts.checkHitTest !== undefined ? Boolean(opts.checkHitTest) : forAction;
  const waitForAppReady = opts.waitForAppReady !== undefined ? Boolean(opts.waitForAppReady) : true;

  return `(function(sel, timeoutMs, forAction, failFastWhenIdle, idleQuietMs, reqStableFrames, checkHitTest, waitForAppReady) {
    ${SHARED_DOM_TRAVERSAL_HELPERS}
    var instantAnim = Boolean(typeof document !== "undefined" && document.getElementById && document.getElementById("__spana_instant_anim"));
    var explicitStableFrames = instantAnim ? 0 : reqStableFrames;

    function findCandidates() {
      if (waitForAppReady && !isAppReady()) return null;
      var rawHits = findAcrossRoots(sel);
      var ready = [];
      for (var i = 0; i < rawHits.length; i++) {
        var h = rawHits[i];
        var m = toMatch(h);
        if (!m.visible) continue;
        if (forAction && !m.enabled) continue;
        ready.push({ hit: h, match: m });
      }
      return ready.length > 0 ? ready : null;
    }

    function checkActionableNow() {
      var ready = findCandidates();
      if (!ready) return null;
      if (!forAction) return ready.map(function(r) { return r.match; });
      var target = ready[ready.length - 1];
      var didScroll = ensureInViewport(target.hit);
      if (checkHitTest && !isHitTestClear(target.hit)) {
        if (scrollToUnobscure(target.hit)) {
          didScroll = true;
        }
        if (!isHitTestClear(target.hit)) return null;
      }
      var updated = toMatch(target.hit);
      if (!updated.visible || !updated.enabled) return null;
      return { hits: ready, target: target, match: updated, didScroll: didScroll };
    }

    function neededStableFrames(candidate) {
      if (!forAction || typeof requestAnimationFrame !== "function") return 0;
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
      if (neededStableFrames(imm) <= 0) return [imm.match];
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
          if (document.readyState === "complete" && (!waitForAppReady || isAppReady())) {
            var hit = checkActionableNow();
            if (hit) {
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
            return;
          }
          if (checkHitTest && !isHitTestClear(candidate.target.hit)) {
            checkingStability = false;
            return;
          }
          var cur = toMatch(candidate.target.hit);
          if (!cur.visible || !cur.enabled) {
            checkingStability = false;
            return;
          }
          var dx = Math.abs(cur.rect.x - lastRect.x);
          var dy = Math.abs(cur.rect.y - lastRect.y);
          var dw = Math.abs(cur.rect.width - lastRect.width);
          var dh = Math.abs(cur.rect.height - lastRect.height);
          if (dx <= 1 && dy <= 1 && dw <= 1 && dh <= 1) {
            remainingFrames -= 1;
            if (remainingFrames <= 0) {
              finish([cur]);
              return;
            }
          } else {
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
        armIdleTimer();
      }

      var scheduled = false;
      function scheduleAttempt() {
        if (done || scheduled || checkingStability) return;
        scheduled = true;
        Promise.resolve().then(function() {
          scheduled = false;
          attempt();
        });
      }

      timeoutTimer = setTimeout(function() {
        var finalHit = checkActionableNow();
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

      attempt();
    });
  })(${serialized}, ${timeoutMs}, ${forAction}, ${failFastWhenIdle}, ${idleQuietMs}, ${stableFrames}, ${checkHitTest}, ${waitForAppReady})`;
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
      var hits = findAcrossRoots(sel);
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

  return `(function(sel, timeoutMs, kind, expected, expectedCount, attributeName, cssProperty, patternSource, patternFlags, negate) {
    ${SHARED_DOM_TRAVERSAL_HELPERS}
    var lastActual = undefined;
    var regex = patternSource !== null ? new RegExp(patternSource, patternFlags) : null;

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
      var hits = findAcrossRoots(sel);
      if (kind === "count") {
        var visibleCount = 0;
        for (var ci = 0; ci < hits.length; ci++) {
          if (toMatch(hits[ci]).visible) visibleCount += 1;
        }
        lastActual = String(visibleCount);
        var countOk = visibleCount === expectedCount;
        if (negate ? !countOk : countOk) return { matched: true, actual: String(visibleCount) };
        return null;
      }
      var anyVisible = false;
      for (var i = hits.length - 1; i >= 0; i--) {
        var m = toMatch(hits[i]);
        if (!m.visible) continue;
        anyVisible = true;
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
        } else if (kind === "editable") {
          var isEd = Boolean(m.editable);
          actualVal = isEd ? "editable" : "not editable";
          matched = isEd;
        } else if (kind === "empty") {
          var isEmp = Boolean(m.empty);
          actualVal = isEmp ? "empty" : (m.value || m.textContent || "non-empty");
          matched = isEmp;
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
          var elNode = hits[i].el;
          var winObj = (elNode.ownerDocument && elNode.ownerDocument.defaultView) || window;
          var cssVal = winObj && winObj.getComputedStyle ? winObj.getComputedStyle(elNode).getPropertyValue(cssProperty).trim() : "";
          actualVal = cssVal;
          matched = regex ? regex.test(cssVal) : (expected !== null && cssVal === String(expected).trim());
        } else if (kind === "accessibleName") {
          var acc = m.accessibleName || "";
          actualVal = acc;
          matched = regex ? regex.test(acc) : (expected === null ? acc.length > 0 : acc.trim() === String(expected).trim());
        } else if (kind === "accessibleDescription") {
          var accD = m.accessibleDescription || "";
          actualVal = accD;
          matched = regex ? regex.test(accD) : (expected === null ? accD.length > 0 : accD.trim() === String(expected).trim());
        } else if (kind === "text") {
          var normTxt = m.textContent !== undefined ? m.textContent : (m.text || "");
          actualVal = normTxt;
          matched = normTxt === (expected !== null ? String(expected).replace(/\\s+/g, " ").trim() : expected);
        } else if (kind === "containsText") {
          var actual = m.textContent !== undefined ? m.textContent : (m.text || "");
          actualVal = actual;
          matched = expected !== null && actual.toLowerCase().indexOf(String(expected).replace(/\\s+/g, " ").trim().toLowerCase()) !== -1;
        } else if (kind === "matchesText") {
          var actualRe = m.textContent !== undefined ? m.textContent : (m.text || "");
          actualVal = actualRe;
          matched = Boolean(regex && regex.test(actualRe));
        } else if (kind === "value") {
          var val = m.value !== undefined ? m.value : "";
          actualVal = val;
          matched = val === expected;
        } else if (kind === "attribute" && attributeName !== null) {
          var attrVal = m.attributes ? m.attributes[attributeName] : undefined;
          actualVal = attrVal;
          matched = expected === null ? attrVal !== undefined : attrVal === expected;
        } else if (kind === "accessibilityLabel") {
          var lbl = m.accessibilityLabel;
          actualVal = lbl;
          matched = expected === null ? (lbl !== undefined && lbl.length > 0) : lbl === expected;
        }
        lastActual = actualVal;
        if (negate ? !matched : matched) return { matched: true, actual: actualVal };
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
  })(${serialized}, ${timeoutMs}, ${kind}, ${expected}, ${expectedCount}, ${attributeName}, ${cssProperty}, ${patternSource}, ${patternFlags}, ${negate})`;
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

  return `(function(sel, val, timeoutMs, checkHitTest) {
    ${SHARED_DOM_TRAVERSAL_HELPERS}
    function writeValue(el) {
      if (typeof el.focus === "function") { try { el.focus(); } catch (e) {} }
      var tag = el.tagName;
      // Rich-text contenteditable editors (TipTap/ProseMirror/Lexical/Slate) require native keyboard input;
      // return false so coordinator falls back cleanly to real tap + SelectAll + Input.insertText.
      if (el.isContentEditable) return false;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        var proto = tag === "TEXTAREA"
          ? (window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype)
          : (window.HTMLInputElement && window.HTMLInputElement.prototype);
        var desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
        if (desc && typeof desc.set === "function") {
          desc.set.call(el, val);
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
      var hits = findAcrossRoots(sel);
      for (var i = hits.length - 1; i >= 0; i--) {
        var h = hits[i];
        var m = toMatch(h);
        if (!m.visible || !m.enabled) continue;
        ensureInViewport(h);
        if (checkHitTest && !isHitTestClear(h)) {
          scrollToUnobscure(h);
          if (!isHitTestClear(h)) continue;
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
        }, 12);
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
  })(${serializedSel}, ${serializedVal}, ${timeoutMs}, ${checkHitTest})`;
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
  if (typeof window === "undefined" || window.__spanaRt) return true;
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
  }

  function waitForSelector(sel, opts) {
    opts = opts || {};
    var timeoutMs = Math.max(10, Math.round(opts.timeoutMs != null ? opts.timeoutMs : 5000));
    var forAction = Boolean(opts.forAction);
    var failFastWhenIdle = Boolean(opts.failFastWhenIdle);
    var idleQuietMs = Math.max(50, Math.round(opts.idleQuietMs != null ? opts.idleQuietMs : 250));
    var reqStableFrames = opts.stableFrames !== undefined ? Math.max(0, Math.round(opts.stableFrames)) : (forAction ? 2 : 0);
    var checkHitTest = opts.checkHitTest !== undefined ? Boolean(opts.checkHitTest) : forAction;
    var waitForAppReady = opts.waitForAppReady !== undefined ? Boolean(opts.waitForAppReady) : true;
    var instantAnim = Boolean(typeof document !== "undefined" && document.getElementById && document.getElementById("__spana_instant_anim"));
    var explicitStableFrames = instantAnim ? 0 : reqStableFrames;

    function findCandidates() {
      if (waitForAppReady && !isAppReady()) return null;
      var rawHits = findAcrossRoots(sel);
      var ready = [];
      for (var i = 0; i < rawHits.length; i++) {
        var h = rawHits[i];
        var m = toMatch(h);
        if (!m.visible) continue;
        if (forAction && !m.enabled) continue;
        ready.push({ hit: h, match: m });
      }
      return ready.length > 0 ? ready : null;
    }

    function checkActionableNow() {
      var ready = findCandidates();
      if (!ready) return null;
      if (!forAction) return ready.map(function(r) { return r.match; });
      var target = ready[ready.length - 1];
      var didScroll = ensureInViewport(target.hit);
      if (checkHitTest && !isHitTestClear(target.hit)) {
        if (scrollToUnobscure(target.hit)) {
          didScroll = true;
        }
        if (!isHitTestClear(target.hit)) return null;
      }
      var updated = toMatch(target.hit);
      if (!updated.visible || !updated.enabled) return null;
      return { hits: ready, target: target, match: updated, didScroll: didScroll };
    }

    function neededStableFrames(candidate) {
      if (!forAction || typeof requestAnimationFrame !== "function") return 0;
      if (explicitStableFrames >= 0) return explicitStableFrames;
      if (hasActiveAnimation(candidate.target.hit.el)) return 2;
      if (candidate.didScroll) return 1;
      return 0;
    }

    var imm = checkActionableNow();
    if (imm) {
      if (!forAction) return imm;
      if (neededStableFrames(imm) <= 0) return [imm.match];
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
          if (document.readyState === "complete" && (!waitForAppReady || isAppReady())) {
            var hit = checkActionableNow();
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
          finish(forAction ? [candidate.match] : candidate);
          return;
        }
        checkingStability = true;
        var el = candidate.target.hit.el;
        var lastRect = candidate.match.rect;
        var remainingFrames = framesToWait;

        function step() {
          if (done) return;
          if (!el.isConnected) { checkingStability = false; return; }
          if (checkHitTest && !isHitTestClear(candidate.target.hit)) { checkingStability = false; return; }
          var cur = toMatch(candidate.target.hit);
          if (!cur.visible || !cur.enabled) { checkingStability = false; return; }
          var dx = Math.abs(cur.rect.x - lastRect.x);
          var dy = Math.abs(cur.rect.y - lastRect.y);
          var dw = Math.abs(cur.rect.width - lastRect.width);
          var dh = Math.abs(cur.rect.height - lastRect.height);
          if (dx <= 1 && dy <= 1 && dw <= 1 && dh <= 1) {
            remainingFrames -= 1;
            if (remainingFrames <= 0) { finish([cur]); return; }
          } else {
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
        armIdleTimer();
      }

      var scheduled = false;
      function scheduleAttempt() {
        if (done || scheduled || checkingStability) return;
        scheduled = true;
        Promise.resolve().then(function() { scheduled = false; attempt(); });
      }

      timeoutTimer = setTimeout(function() {
        var finalHit = checkActionableNow();
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
      attempt();
    });
  }

  function waitForHidden(sel, opts) {
    opts = opts || {};
    var timeoutMs = Math.max(10, Math.round(opts.timeoutMs != null ? opts.timeoutMs : 5000));
    function isHiddenNow() {
      var hits = findAcrossRoots(sel);
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
    var lastActual = undefined;
    var regex = patternSource !== null ? new RegExp(patternSource, patternFlags) : null;

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

      var hits = findAcrossRoots(sel);

      if (kind === "count") {
        var visibleCount = 0;
        for (var ci = 0; ci < hits.length; ci++) {
          if (toMatch(hits[ci]).visible) visibleCount++;
        }
        lastActual = String(visibleCount);
        var countOk = expectedCount !== null && visibleCount === expectedCount;
        if (negate ? !countOk : countOk) {
          return { matched: true, actual: String(visibleCount) };
        }
        return null;
      }

      for (var i = hits.length - 1; i >= 0; i--) {
        var m = toMatch(hits[i]);
        if (!m.visible) continue;
        var matched = false;
        var actualVal = undefined;
        if (kind === "text") {
          var normTxt = m.textContent !== undefined ? m.textContent : (m.text || "");
          actualVal = normTxt;
          matched = normTxt === (expected !== null ? String(expected).replace(/\\s+/g, " ").trim() : expected);
        } else if (kind === "containsText") {
          var actual = m.textContent !== undefined ? m.textContent : (m.text || "");
          actualVal = actual;
          matched = expected !== null && actual.toLowerCase().indexOf(String(expected).replace(/\\s+/g, " ").trim().toLowerCase()) !== -1;
        } else if (kind === "matchesText") {
          var actualRe = m.textContent !== undefined ? m.textContent : (m.text || "");
          actualVal = actualRe;
          matched = Boolean(regex && regex.test(actualRe));
        } else if (kind === "value") {
          var val = m.value !== undefined ? m.value : "";
          actualVal = val;
          matched = val === expected;
        } else if (kind === "attribute" && attributeName !== null) {
          var attrVal = m.attributes ? m.attributes[attributeName] : undefined;
          actualVal = attrVal;
          matched = expected === null ? attrVal !== undefined : attrVal === expected;
        } else if (kind === "accessibilityLabel") {
          var lbl = m.accessibilityLabel;
          actualVal = lbl;
          matched = expected === null ? (lbl !== undefined && lbl.length > 0) : lbl === expected;
        } else if (kind === "accessibleName") {
          var accName = m.accessibleName || m.accessibilityLabel || m.text || "";
          actualVal = accName;
          matched = regex ? regex.test(accName) : (expected === null ? accName.length > 0 : accName.trim() === String(expected).trim());
        } else if (kind === "accessibleDescription") {
          var accDesc = m.accessibleDescription || "";
          actualVal = accDesc;
          matched = regex ? regex.test(accDesc) : (expected === null ? accDesc.length > 0 : accDesc.trim() === String(expected).trim());
        } else if (kind === "focused") {
          actualVal = m.focused ? "focused" : "not focused";
          matched = Boolean(m.focused);
        } else if (kind === "checked") {
          actualVal = m.checked ? "checked" : "unchecked";
          matched = Boolean(m.checked);
        } else if (kind === "editable") {
          actualVal = m.editable ? "editable" : "not editable";
          matched = Boolean(m.editable);
        } else if (kind === "empty") {
          actualVal = m.empty ? "empty" : (m.value || m.textContent || "non-empty");
          matched = Boolean(m.empty);
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
          var elNode = hits[i].el;
          var winObj = (elNode.ownerDocument && elNode.ownerDocument.defaultView) || window;
          var cssVal = winObj && winObj.getComputedStyle ? winObj.getComputedStyle(elNode).getPropertyValue(cssProperty).trim() : "";
          actualVal = cssVal;
          matched = regex ? regex.test(cssVal) : (expected !== null && cssVal === String(expected).trim());
        }
        lastActual = actualVal;
        if (negate ? !matched : matched) return { matched: true, actual: actualVal };
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
        if (desc && typeof desc.set === "function") desc.set.call(el, val);
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
      var hits = findAcrossRoots(sel);
      for (var i = hits.length - 1; i >= 0; i--) {
        var h = hits[i];
        var m = toMatch(h);
        if (!m.visible || !m.enabled) continue;
        ensureInViewport(h);
        if (checkHitTest && !isHitTestClear(h)) {
          scrollToUnobscure(h);
          if (!isHitTestClear(h)) continue;
        }
        return h.el;
      }
      return null;
    }
    function verifyAndRetryFill(attemptsLeft) {
      var el = findEditableNow();
      if (!el || el.isContentEditable) return Promise.resolve(false);
      if (!writeValue(el)) return Promise.resolve(false);
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
        }, 12);
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

  window.__spanaRt = {
    query: query,
    scrollIntoView: scrollIntoView,
    tap: tap,
    waitForSelector: waitForSelector,
    waitForHidden: waitForHidden,
    waitForMatch: waitForMatch,
    fill: fill
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
    var el = hits[hits.length - 1].el;
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

/** Build an in-page diagnostic script reporting why an existing element failed actionability (covered/disabled/hidden). */
export function buildDomActionabilityDiagScript(selector: Selector): string {
  const serialized = JSON.stringify(serializeSelectorForDom(selector));
  return `(function(sel) {
    ${SHARED_DOM_TRAVERSAL_HELPERS}
    var hits = findAcrossRoots(sel);
    if (hits.length === 0) return { found: false };
    var target = hits[hits.length - 1];
    var m = toMatch(target);
    if (!m.visible) return { found: true, visible: false, enabled: m.enabled };
    if (!m.enabled) return { found: true, visible: true, enabled: false };
    var blocker = getHitTestBlocker(target);
    return { found: true, visible: true, enabled: true, obstructedBy: blocker || undefined };
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
