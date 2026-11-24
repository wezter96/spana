import type {
  BridgeClearStorageOptions,
  BridgeConsoleLog,
  BridgeElementMatch,
  BridgeJSError,
  BridgeMockResponse,
  BridgeRequestMessage,
  BridgeSelector,
  BridgeSerializedMatcher,
  BridgeStorageAdapter,
  BridgeStorageEntries,
} from "./protocol.js";

export interface SpanaBridgeClientOptions {
  /** Runner WebSocket URL (default: `ws://127.0.0.1:9333`) */
  url?: string;
  /** Port shorthand when url is omitted (default: 9333) */
  port?: number;
  /** Host shorthand when url is omitted (default: `127.0.0.1`) */
  host?: string;
  /** Optional metadata sent in the hello handshake (shell, appVersion, etc.) */
  meta?: Record<string, unknown>;
  /** Reconnect delay in ms on disconnect (default: 500; 0 disables reconnect) */
  reconnectDelayMs?: number;
  /** Optional platform storage adapter (e.g. Capacitor Preferences) */
  storageAdapter?: BridgeStorageAdapter;
  /** Injectable WebSocket constructor for tests or non-browser runtimes */
  WebSocketImpl?: typeof WebSocket;
  /** Injectable document/window references for unit tests */
  env?: {
    window?: any;
    document?: any;
  };
}

interface NetworkMockRule {
  kind: "mock" | "block";
  match: (url: string) => boolean;
  response?: BridgeMockResponse;
}

export interface SpanaBridgeHandle {
  readonly url: string;
  isConnected(): boolean;
  query(selector: BridgeSelector): BridgeElementMatch[];
  evaluate<T = unknown>(script: string, isFunction?: boolean, args?: unknown[]): Promise<T>;
  dispatch(
    selector: BridgeSelector,
    eventType: string,
    eventInit?: Record<string, unknown>,
  ): boolean;
  tap(selector: BridgeSelector): boolean;
  setStorage(entries: BridgeStorageEntries): Promise<void>;
  clearStorage(opts?: BridgeClearStorageOptions): Promise<void>;
  idle(opts?: { timeout?: number; quietPeriodMs?: number }): Promise<void>;
  mockNetwork(matcher: BridgeSerializedMatcher, response: BridgeMockResponse): void;
  blockNetwork(matcher: BridgeSerializedMatcher): void;
  clearNetworkMocks(): void;
  getConsoleLogs(): BridgeConsoleLog[];
  getJSErrors(): BridgeJSError[];
  destroy(): void;
}

function compileMatcher(matcher: BridgeSerializedMatcher): (url: string) => boolean {
  if (matcher.type === "regexp" && matcher.source) {
    const regex = new RegExp(matcher.source, matcher.flags);
    return (url) => regex.test(url);
  }
  const pattern = matcher.pattern ?? "";
  if (pattern.includes("*")) {
    const escaped = pattern
      .replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("**", ".*")
      .replaceAll("*", "[^/]*");
    const regex = new RegExp(escaped);
    return (url) => regex.test(url);
  }
  return (url) => url.includes(pattern);
}

function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function evaluateScript<T = unknown>(
  script: string,
  isFunction = false,
  args: unknown[] = [],
): Promise<T> {
  if (isFunction) {
    const fn = new Function(`return (${script})`)();
    return (await fn(...args)) as T;
  }
  const runner = /\breturn\b/.test(script)
    ? new Function(`return (async () => { ${script} })()`)
    : new Function(`return (${script})`);
  return (await runner()) as T;
}

function findDomElements(doc: any, selector: BridgeSelector): any[] {
  if (!doc) return [];
  if (typeof selector === "object" && selector !== null && "testID" in selector) {
    const escaped = escapeAttrValue(selector.testID);
    return Array.from(doc.querySelectorAll(`[data-testid="${escaped}"], [testID="${escaped}"]`));
  }
  if (typeof selector === "object" && selector !== null && "accessibilityLabel" in selector) {
    const escaped = escapeAttrValue(selector.accessibilityLabel);
    return Array.from(doc.querySelectorAll(`[aria-label="${escaped}"]`));
  }
  if (typeof selector === "object" && selector !== null && "point" in selector) {
    const el =
      typeof doc.elementFromPoint === "function"
        ? doc.elementFromPoint(selector.point.x, selector.point.y)
        : null;
    return el ? [el] : [];
  }
  const needle = (typeof selector === "string" ? selector : selector.text).toLowerCase();
  const all = Array.from(doc.querySelectorAll("*")) as any[];
  const results: any[] = [];
  for (const node of all) {
    let directText = "";
    const children = node.childNodes ?? [];
    for (let i = 0; i < children.length; i++) {
      if (children[i]?.nodeType === 3) {
        directText += children[i].textContent ?? "";
      }
    }
    const trimmed = directText.trim().toLowerCase();
    const inputVal =
      node.tagName === "INPUT" || node.tagName === "BUTTON"
        ? String(node.value ?? "").toLowerCase()
        : "";
    if ((trimmed && trimmed.includes(needle)) || (inputVal && inputVal.includes(needle))) {
      results.push(node);
    }
  }
  return results;
}

function elementToMatch(win: any, doc: any, el: any): BridgeElementMatch {
  const rect =
    typeof el.getBoundingClientRect === "function"
      ? el.getBoundingClientRect()
      : { x: 0, y: 0, width: 0, height: 0 };

  const style =
    win && typeof win.getComputedStyle === "function"
      ? win.getComputedStyle(el)
      : { display: "block", visibility: "visible", opacity: "1", cursor: "auto" };

  const visible =
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number.parseFloat(style.opacity || "1") !== 0;

  const tag = typeof el.tagName === "string" ? el.tagName.toLowerCase() : undefined;
  const role = typeof el.getAttribute === "function" ? el.getAttribute("role") : null;
  const clickable =
    tag === "button" ||
    tag === "a" ||
    tag === "input" ||
    tag === "select" ||
    tag === "textarea" ||
    role === "button" ||
    role === "link" ||
    role === "tab" ||
    typeof el.onclick === "function" ||
    style.cursor === "pointer";

  const attrs: Record<string, string> = {};
  if (el.attributes) {
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i];
      if (a?.name) attrs[a.name] = String(a.value ?? "");
    }
  }

  const text = String(el.innerText ?? el.textContent ?? "").trim() || undefined;
  const value =
    tag === "input" || tag === "textarea" || tag === "select" ? String(el.value ?? "") : undefined;

  return {
    id:
      (typeof el.getAttribute === "function"
        ? el.getAttribute("data-testid") || el.getAttribute("testID")
        : undefined) || undefined,
    tag,
    text,
    value,
    accessibilityLabel:
      (typeof el.getAttribute === "function" ? el.getAttribute("aria-label") : undefined) ||
      undefined,
    rect: {
      x: rect.x ?? rect.left ?? 0,
      y: rect.y ?? rect.top ?? 0,
      width: rect.width ?? 0,
      height: rect.height ?? 0,
    },
    scrollX: win?.scrollX ?? win?.pageXOffset ?? 0,
    scrollY: win?.scrollY ?? win?.pageYOffset ?? 0,
    devicePixelRatio: win?.devicePixelRatio ?? 1,
    viewportWidth:
      win?.visualViewport?.width ?? win?.innerWidth ?? doc?.documentElement?.clientWidth ?? 0,
    viewportHeight:
      win?.visualViewport?.height ?? win?.innerHeight ?? doc?.documentElement?.clientHeight ?? 0,
    visible,
    enabled:
      !(typeof el.hasAttribute === "function" && el.hasAttribute("disabled")) &&
      (typeof el.getAttribute !== "function" || el.getAttribute("aria-disabled") !== "true"),
    clickable,
    focused: doc?.activeElement === el,
    attributes: Object.keys(attrs).length > 0 ? attrs : undefined,
  };
}

/**
 * Initialize the opt-in `spana-bridge` inside a test build of a web, Capacitor,
 * Electron, or Electrobun app. Connects back to Spana's runner over WebSocket
 * and provides millisecond DOM queries, idle detection, storage injection,
 * network mocking, and console/error capture.
 */
export function initSpanaBridge(options: SpanaBridgeClientOptions = {}): SpanaBridgeHandle {
  const win = options.env?.window ?? (typeof window !== "undefined" ? window : globalThis);
  const doc = options.env?.document ?? (typeof document !== "undefined" ? document : undefined);
  const WsCtor = options.WebSocketImpl ?? (globalThis as any).WebSocket;

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 9333;
  const url = options.url ?? `ws://${host}:${port}`;
  const reconnectDelayMs = options.reconnectDelayMs ?? 500;

  let ws: WebSocket | null = null;
  let connected = false;
  let destroyed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Track in-flight network requests for `idle()`
  let inFlightRequests = 0;
  let lastMutationAt = Date.now();
  const networkMocks: NetworkMockRule[] = [];
  const consoleLogs: BridgeConsoleLog[] = [];
  const jsErrors: BridgeJSError[] = [];

  // ── Instrument fetch ──────────────────────────────────────────────────
  const originalFetch = typeof win?.fetch === "function" ? win.fetch.bind(win) : undefined;
  if (originalFetch && win) {
    win.fetch = async (input: any, init?: any) => {
      const reqUrl = typeof input === "string" ? input : String(input?.url ?? "");
      const rule = networkMocks.find((r) => r.match(reqUrl));
      if (rule) {
        if (rule.kind === "block") {
          throw new TypeError(`Blocked by spana-bridge: ${reqUrl}`);
        }
        const resp = rule.response ?? {};
        const headers = new Headers(resp.headers ?? {});
        if (resp.contentType && !headers.has("content-type")) {
          headers.set("content-type", resp.contentType);
        }
        const body = resp.json !== undefined ? JSON.stringify(resp.json) : (resp.body ?? "");
        if (resp.json !== undefined && !headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
        return new Response(body, { status: resp.status ?? 200, headers });
      }

      inFlightRequests++;
      try {
        return await originalFetch(input, init);
      } finally {
        inFlightRequests = Math.max(0, inFlightRequests - 1);
      }
    };
  }

  // ── Instrument XMLHttpRequest ─────────────────────────────────────────
  const OriginalXHR = win?.XMLHttpRequest;
  const originalXhrOpen = OriginalXHR?.prototype?.open;
  const originalXhrSend = OriginalXHR?.prototype?.send;
  if (OriginalXHR && originalXhrOpen && originalXhrSend) {
    OriginalXHR.prototype.open = function (
      this: any,
      method: string,
      reqUrl: string,
      ...rest: any[]
    ) {
      this.__spanaUrl = String(reqUrl);
      return originalXhrOpen.call(this, method, reqUrl, ...rest);
    };
    OriginalXHR.prototype.send = function (this: any, body?: any) {
      const reqUrl = String(this.__spanaUrl ?? "");
      const rule = networkMocks.find((r) => r.match(reqUrl));
      if (rule) {
        if (rule.kind === "block") {
          setTimeout(() => {
            if (typeof this.onerror === "function") this.onerror(new Event("error"));
          }, 0);
          return;
        }
        const resp = rule.response ?? {};
        const text = resp.json !== undefined ? JSON.stringify(resp.json) : (resp.body ?? "");
        Object.defineProperty(this, "readyState", { configurable: true, value: 4 });
        Object.defineProperty(this, "status", { configurable: true, value: resp.status ?? 200 });
        Object.defineProperty(this, "responseText", { configurable: true, value: text });
        Object.defineProperty(this, "response", { configurable: true, value: text });
        setTimeout(() => {
          if (typeof this.onreadystatechange === "function") this.onreadystatechange();
          if (typeof this.onload === "function") this.onload();
        }, 0);
        return;
      }

      inFlightRequests++;
      const done = () => {
        inFlightRequests = Math.max(0, inFlightRequests - 1);
      };
      this.addEventListener?.("loadend", done, { once: true });
      return originalXhrSend.call(this, body);
    };
  }

  // ── Instrument console & errors ───────────────────────────────────────
  const originalConsole: Partial<Record<string, (...a: any[]) => void>> = {};
  const consoleObj = win?.console;
  if (consoleObj) {
    for (const level of ["log", "warn", "error", "info", "debug"] as const) {
      const fn = consoleObj[level];
      if (typeof fn === "function") {
        originalConsole[level] = fn.bind(consoleObj);
        consoleObj[level] = (...args: unknown[]) => {
          consoleLogs.push({
            type: level,
            text: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
          });
          return originalConsole[level]!(...args);
        };
      }
    }
  }

  const onWindowError = (event: any) => {
    jsErrors.push({
      name: event?.error?.name ?? "Error",
      message: String(event?.message ?? event?.error?.message ?? "Unknown error"),
      stack: event?.error?.stack,
    });
  };
  const onUnhandledRejection = (event: any) => {
    const reason = event?.reason;
    jsErrors.push({
      name: reason?.name ?? "UnhandledRejection",
      message: String(reason?.message ?? reason ?? "Unhandled rejection"),
      stack: reason?.stack,
    });
  };
  win?.addEventListener?.("error", onWindowError);
  win?.addEventListener?.("unhandledrejection", onUnhandledRejection);

  // ── Track DOM mutations for framework render settle ───────────────────
  let mutationObserver: MutationObserver | null = null;
  if (typeof MutationObserver !== "undefined" && doc?.documentElement) {
    mutationObserver = new MutationObserver(() => {
      lastMutationAt = Date.now();
    });
    try {
      mutationObserver.observe(doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    } catch {
      mutationObserver = null;
    }
  }

  // ── Core bridge operations ────────────────────────────────────────────
  const query = (selector: BridgeSelector): BridgeElementMatch[] => {
    return findDomElements(doc, selector).map((el) => elementToMatch(win, doc, el));
  };

  const evaluate = evaluateScript;

  const dispatch = (
    selector: BridgeSelector,
    eventType: string,
    eventInit: Record<string, unknown> = {},
  ): boolean => {
    const el = findDomElements(doc, selector)[0];
    if (!el || typeof el.dispatchEvent !== "function") return false;
    const EventCtor = win?.CustomEvent ?? win?.Event ?? Event;
    const evt = new EventCtor(eventType, { bubbles: true, cancelable: true, ...eventInit });
    return Boolean(el.dispatchEvent(evt));
  };

  const tap = (selector: BridgeSelector): boolean => {
    const el = findDomElements(doc, selector)[0];
    if (!el) return false;
    if (typeof el.scrollIntoView === "function") {
      try {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
      } catch {}
    }
    const rect =
      typeof el.getBoundingClientRect === "function"
        ? el.getBoundingClientRect()
        : { left: 0, top: 0, width: 0, height: 0 };
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    if (typeof win?.PointerEvent === "function") {
      try {
        el.dispatchEvent(new win.PointerEvent("pointerdown", init));
      } catch {}
    }
    if (typeof win?.MouseEvent === "function") {
      try {
        el.dispatchEvent(new win.MouseEvent("mousedown", init));
      } catch {}
    }
    if (typeof el.focus === "function") {
      try {
        el.focus();
      } catch {}
    }
    if (typeof win?.PointerEvent === "function") {
      try {
        el.dispatchEvent(new win.PointerEvent("pointerup", init));
      } catch {}
    }
    if (typeof win?.MouseEvent === "function") {
      try {
        el.dispatchEvent(new win.MouseEvent("mouseup", init));
      } catch {}
    }
    if (typeof el.click === "function") {
      el.click();
    } else if (typeof win?.MouseEvent === "function") {
      el.dispatchEvent(new win.MouseEvent("click", init));
    }
    return true;
  };

  const setStorage = async (entries: BridgeStorageEntries): Promise<void> => {
    if (entries.localStorage && win?.localStorage) {
      for (const [k, v] of Object.entries(entries.localStorage)) {
        win.localStorage.setItem(k, v);
      }
    }
    if (entries.sessionStorage && win?.sessionStorage) {
      for (const [k, v] of Object.entries(entries.sessionStorage)) {
        win.sessionStorage.setItem(k, v);
      }
    }
    if (entries.cookies && doc) {
      for (const cookie of entries.cookies) {
        const path = cookie.path ? `; path=${cookie.path}` : "; path=/";
        const domain = cookie.domain ? `; domain=${cookie.domain}` : "";
        doc.cookie = `${encodeURIComponent(cookie.name)}=${encodeURIComponent(cookie.value)}${path}${domain}`;
      }
    }
    if (entries.capacitorPreferences) {
      if (options.storageAdapter?.setPreferences) {
        await options.storageAdapter.setPreferences(entries.capacitorPreferences);
      } else if (win?.Capacitor?.Plugins?.Preferences?.set) {
        for (const [key, value] of Object.entries(entries.capacitorPreferences)) {
          await win.Capacitor.Plugins.Preferences.set({ key, value });
        }
      }
    }
  };

  const clearStorage = async (opts: BridgeClearStorageOptions = {}): Promise<void> => {
    if (opts.localStorage !== false && win?.localStorage) {
      try {
        win.localStorage.clear();
      } catch {}
    }
    if (opts.sessionStorage !== false && win?.sessionStorage) {
      try {
        win.sessionStorage.clear();
      } catch {}
    }
    if (opts.cookies !== false && doc && typeof doc.cookie === "string") {
      const pairs = doc.cookie.split(";");
      for (const pair of pairs) {
        const eqIdx = pair.indexOf("=");
        const name = (eqIdx >= 0 ? pair.slice(0, eqIdx) : pair).trim();
        if (name) {
          doc.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
        }
      }
    }
    if (opts.indexedDB !== false && win?.indexedDB?.databases) {
      try {
        const dbs = await win.indexedDB.databases();
        for (const db of dbs) {
          if (db?.name) {
            win.indexedDB.deleteDatabase(db.name);
          }
        }
      } catch {}
    }
    if (opts.capacitorPreferences !== false) {
      if (options.storageAdapter?.clearPreferences) {
        await options.storageAdapter.clearPreferences();
      } else if (win?.Capacitor?.Plugins?.Preferences?.clear) {
        await win.Capacitor.Plugins.Preferences.clear();
      }
    }
  };

  const hasRunningAnimations = (): boolean => {
    if (typeof doc?.getAnimations !== "function") return false;
    try {
      const animations = doc.getAnimations() as Array<{
        playState?: string;
        effect?: { getComputedTiming?: () => { iterations?: number } };
      }>;
      return animations.some((anim) => {
        if (anim.playState !== "running") return false;
        // Ignore infinite decorative spinners/pulses so idle() never deadlocks
        const iterations = anim.effect?.getComputedTiming?.()?.iterations;
        return iterations !== Number.POSITIVE_INFINITY;
      });
    } catch {
      return false;
    }
  };

  const nextFrame = (): Promise<void> =>
    new Promise((resolve) => {
      if (typeof win?.requestAnimationFrame === "function") {
        win.requestAnimationFrame(() => resolve());
      } else {
        setTimeout(resolve, 16);
      }
    });

  const idle = async (opts?: { timeout?: number; quietPeriodMs?: number }): Promise<void> => {
    const timeout = opts?.timeout ?? 5000;
    const quietPeriodMs = opts?.quietPeriodMs ?? 50;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const noNetwork = inFlightRequests === 0;
      const noAnim = !hasRunningAnimations();
      const domQuiet = Date.now() - lastMutationAt >= quietPeriodMs;

      if (noNetwork && noAnim && domQuiet) {
        // Wait two frames to let React / Vue / Svelte flush effects & paints
        await nextFrame();
        await nextFrame();
        if (inFlightRequests === 0 && !hasRunningAnimations()) {
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  };

  const mockNetwork = (matcher: BridgeSerializedMatcher, response: BridgeMockResponse): void => {
    networkMocks.push({ kind: "mock", match: compileMatcher(matcher), response });
  };

  const blockNetwork = (matcher: BridgeSerializedMatcher): void => {
    networkMocks.push({ kind: "block", match: compileMatcher(matcher) });
  };

  const clearNetworkMocks = (): void => {
    networkMocks.length = 0;
  };

  // ── WebSocket RPC dispatch ────────────────────────────────────────────
  const handleRequest = async (req: BridgeRequestMessage): Promise<void> => {
    const send = (payload: Record<string, unknown>) => {
      if (ws && connected) {
        ws.send(JSON.stringify(payload));
      }
    };

    try {
      const params = req.params ?? {};
      let result: unknown;
      switch (req.method) {
        case "ping":
          result = { pong: true, ts: Date.now() };
          break;
        case "query":
          result = query(params["selector"]);
          break;
        case "evaluate":
          result = await evaluate(
            params["script"],
            Boolean(params["isFunction"]),
            params["args"] ?? [],
          );
          break;
        case "dispatch":
          result = dispatch(params["selector"], String(params["eventType"]), params["eventInit"]);
          break;
        case "tap":
          result = tap(params["selector"]);
          break;
        case "setStorage":
          await setStorage(params as BridgeStorageEntries);
          result = true;
          break;
        case "clearStorage":
          await clearStorage(params as BridgeClearStorageOptions);
          result = true;
          break;
        case "reload":
          send({ id: req.id, result: true });
          win?.location?.reload?.();
          return;
        case "idle":
          await idle({ timeout: params["timeout"], quietPeriodMs: params["quietPeriodMs"] });
          result = true;
          break;
        case "mockNetwork":
          mockNetwork(params["matcher"], params["response"]);
          result = true;
          break;
        case "blockNetwork":
          blockNetwork(params["matcher"]);
          result = true;
          break;
        case "clearNetworkMocks":
          clearNetworkMocks();
          result = true;
          break;
        case "getConsoleLogs":
          result = [...consoleLogs];
          break;
        case "getJSErrors":
          result = [...jsErrors];
          break;
        default:
          throw new Error(`Unknown spana-bridge method: ${req.method}`);
      }
      send({ id: req.id, result });
    } catch (error) {
      send({
        id: req.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const connectSocket = () => {
    if (destroyed || !WsCtor) return;
    try {
      const socket: WebSocket = new WsCtor(url);
      ws = socket;

      socket.addEventListener("open", () => {
        connected = true;
        socket.send(
          JSON.stringify({
            type: "hello",
            meta: {
              userAgent: win?.navigator?.userAgent,
              href: win?.location?.href,
              ...options.meta,
            },
          }),
        );
      });

      socket.addEventListener("message", (event: MessageEvent) => {
        const raw = typeof event.data === "string" ? event.data : String(event.data ?? "");
        let parsed: BridgeRequestMessage;
        try {
          parsed = JSON.parse(raw) as BridgeRequestMessage;
        } catch {
          return;
        }
        if (typeof parsed.id === "number" && typeof parsed.method === "string") {
          void handleRequest(parsed);
        }
      });

      const scheduleReconnect = () => {
        connected = false;
        if (ws === socket) ws = null;
        if (!destroyed && reconnectDelayMs > 0 && !reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectSocket();
          }, reconnectDelayMs);
        }
      };

      socket.addEventListener("close", scheduleReconnect);
      socket.addEventListener("error", () => {
        // close event will trigger reconnect
      });
    } catch {
      if (!destroyed && reconnectDelayMs > 0 && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectSocket();
        }, reconnectDelayMs);
      }
    }
  };

  connectSocket();

  const destroy = () => {
    destroyed = true;
    connected = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    if (originalFetch && win) {
      win.fetch = originalFetch;
    }
    if (OriginalXHR && originalXhrOpen && originalXhrSend) {
      OriginalXHR.prototype.open = originalXhrOpen;
      OriginalXHR.prototype.send = originalXhrSend;
    }
    if (consoleObj) {
      for (const [level, fn] of Object.entries(originalConsole)) {
        if (fn) consoleObj[level] = fn;
      }
    }
    win?.removeEventListener?.("error", onWindowError);
    win?.removeEventListener?.("unhandledrejection", onUnhandledRejection);
  };

  const handle: SpanaBridgeHandle = {
    url,
    isConnected: () => connected,
    query,
    evaluate,
    dispatch,
    tap,
    setStorage,
    clearStorage,
    idle,
    mockNetwork,
    blockNetwork,
    clearNetworkMocks,
    getConsoleLogs: () => [...consoleLogs],
    getJSErrors: () => [...jsErrors],
    destroy,
  };

  if (win) {
    (win as Record<string, unknown>)["__SPANA_BRIDGE__"] = handle;
  }

  return handle;
}
