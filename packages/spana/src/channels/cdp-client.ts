import type { Selector } from "../schemas/selector.js";
import {
  buildDomFillScript,
  buildDomQueryScript,
  buildDomScrollIntoViewScript,
  buildDomTapScript,
  buildDomWaitForHiddenScript,
  buildDomWaitForMatchScript,
  buildDomWaitForSelectorScript,
  buildEvaluateExpression,
  buildInjectedCallScript,
  SPANA_INJECTED_RUNTIME_SCRIPT,
  SPANA_RUNTIME_MISSING_SENTINEL,
  type DomChannel,
  type DomElementMatch,
  type DomFillOptions,
  type DomTargetInfo,
  type DomWaitForHiddenOptions,
  type DomWaitForMatchOptions,
  type DomWaitForMatchResult,
  type DomWaitForSelectorOptions,
  type InjectedRuntimeMethod,
} from "./dom-channel.js";

export interface MinimalWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener?(type: string, listener: (event: any) => void): void;
}

export type WebSocketFactory = (url: string) => MinimalWebSocket;

export interface CdpTargetDescriptor {
  id: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpDomChannelOptions {
  /** Base HTTP URL of the CDP debug endpoint, e.g. `http://127.0.0.1:9222` */
  endpointUrl: string;
  /** Optional direct WebSocket URL (skips `/json/list` discovery) */
  webSocketUrl?: string;
  /** Optional target filter (matches URL or title substring/RegExp) */
  targetFilter?: string | RegExp;
  /** Command timeout in ms. Default: 10_000. */
  timeoutMs?: number;
  /** Injectable fetch for testing */
  fetchFn?: typeof fetch;
  /** Injectable WebSocket factory for testing */
  createWebSocket?: WebSocketFactory;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const WS_OPEN = 1;

function defaultWebSocketFactory(url: string): MinimalWebSocket {
  return new WebSocket(url) as unknown as MinimalWebSocket;
}

export function selectCdpTarget(
  targets: CdpTargetDescriptor[],
  filter?: string | RegExp,
): CdpTargetDescriptor | undefined {
  const attachable = targets.filter((t) => Boolean(t.webSocketDebuggerUrl));
  if (attachable.length === 0) return undefined;

  if (filter) {
    const matched = attachable.find((t) => {
      const hay = `${t.title ?? ""} ${t.url ?? ""}`;
      return typeof filter === "string" ? hay.includes(filter) : filter.test(hay);
    });
    if (matched) return matched;
  }

  // Prefer visible page / webview targets over service workers or devtools
  const pageTarget = attachable.find(
    (t) =>
      (t.type === "page" || t.type === "webview" || !t.type) &&
      !(t.url ?? "").startsWith("devtools://"),
  );
  return pageTarget ?? attachable[0];
}

export interface CdpChildSessionInfo {
  sessionId: string;
  targetId?: string;
  url?: string;
}

export type CdpFrameOffsetResolver = (
  child: CdpChildSessionInfo,
) => Promise<{ x: number; y: number }>;

export class CdpDomChannel implements DomChannel {
  readonly kind = "cdp" as const;

  private readonly endpointUrl: string;
  private readonly explicitWsUrl?: string;
  private readonly targetFilter?: string | RegExp;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly createWebSocket: WebSocketFactory;

  private ws: MinimalWebSocket | null = null;
  private connected = false;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private eventListeners = new Map<string, Set<(params: any, sessionId?: string) => void>>();
  private currentTargetId: string | null = null;
  private activeSessionId: string | null = null;
  private childSessions = new Map<string, CdpChildSessionInfo>();
  private frameOffsetResolver?: CdpFrameOffsetResolver;

  constructor(options: CdpDomChannelOptions) {
    this.endpointUrl = options.endpointUrl.replace(/\/+$/, "");
    this.explicitWsUrl = options.webSocketUrl;
    this.targetFilter = options.targetFilter;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.createWebSocket = options.createWebSocket ?? defaultWebSocketFactory;
  }

  isConnected(): boolean {
    return this.connected && this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  async listTargets(): Promise<DomTargetInfo[]> {
    const raw = await this.fetchTargets();
    return raw.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      type: t.type,
    }));
  }

  private async fetchTargets(): Promise<CdpTargetDescriptor[]> {
    for (const path of ["/json/list", "/json"]) {
      try {
        const res = await this.fetchFn(`${this.endpointUrl}${path}`);
        if (!res.ok) continue;
        const data = (await res.json()) as unknown;
        if (Array.isArray(data)) {
          return data as CdpTargetDescriptor[];
        }
      } catch {
        // try next path
      }
    }
    throw new Error(`CDP: unable to list targets from ${this.endpointUrl}`);
  }

  async selectTarget(targetId: string): Promise<void> {
    const targets = await this.fetchTargets();
    const target = targets.find((t) => t.id === targetId && t.webSocketDebuggerUrl);
    if (!target || !target.webSocketDebuggerUrl) {
      throw new Error(`CDP: target "${targetId}" not found or has no webSocketDebuggerUrl`);
    }
    await this.disconnect();
    this.currentTargetId = target.id;
    await this.openSocket(target.webSocketDebuggerUrl);
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;

    let wsUrl = this.explicitWsUrl;
    if (!wsUrl) {
      const targets = await this.fetchTargets();
      const chosen = selectCdpTarget(targets, this.targetFilter);
      if (!chosen?.webSocketDebuggerUrl) {
        throw new Error(`CDP: no debuggable page/webview target found at ${this.endpointUrl}`);
      }
      this.currentTargetId = chosen.id;
      wsUrl = chosen.webSocketDebuggerUrl;
    }

    await this.openSocket(wsUrl);
  }

  private async openSocket(wsUrl: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = this.createWebSocket(wsUrl);
      this.ws = ws;

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(`CDP: WebSocket connection to ${wsUrl} timed out after ${this.timeoutMs}ms`),
        );
      }, this.timeoutMs);

      const onOpen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connected = true;
        resolve();
      };

      const onError = (err: unknown) => {
        const error = new Error(
          `CDP WebSocket error: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      };

      const onClose = () => {
        this.connected = false;
        this.rejectAllPending(new Error("CDP WebSocket closed"));
      };

      const onMessage = (event: { data?: unknown }) => {
        const raw = typeof event.data === "string" ? event.data : String(event.data ?? "");
        let parsed: Record<string, any>;
        try {
          parsed = JSON.parse(raw) as Record<string, any>;
        } catch {
          return;
        }
        const id = parsed["id"];
        if (typeof id === "number") {
          const entry = this.pending.get(id);
          if (!entry) return;
          this.pending.delete(id);
          clearTimeout(entry.timer);
          if (parsed["error"]) {
            const msg = parsed["error"].message ?? JSON.stringify(parsed["error"]);
            entry.reject(new Error(`CDP error: ${msg}`));
          } else {
            entry.resolve(parsed["result"]);
          }
          return;
        }
        const method = parsed["method"];
        if (typeof method === "string") {
          const listeners = this.eventListeners.get(method);
          if (listeners && listeners.size > 0) {
            const params = parsed["params"];
            const sessionId =
              typeof parsed["sessionId"] === "string" ? parsed["sessionId"] : undefined;
            for (const fn of listeners) {
              try {
                fn(params, sessionId);
              } catch {
                // listener error must not kill socket loop
              }
            }
          }
        }
      };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
      ws.addEventListener("message", onMessage);

      // Handle already-open mock sockets in synchronous unit tests
      if (ws.readyState === WS_OPEN) {
        onOpen();
      }
    });
  }

  private rejectAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  setSessionId(sessionId: string | null): void {
    this.activeSessionId = sessionId;
  }

  get sessionId(): string | null {
    return this.activeSessionId;
  }

  /** Register an attached cross-origin iframe (OOPIF) flattened CDP session. */
  addChildSession(sessionId: string, meta?: { targetId?: string; url?: string }): void {
    this.childSessions.set(sessionId, { sessionId, ...meta });
  }

  removeChildSession(sessionId: string): void {
    this.childSessions.delete(sessionId);
  }

  clearChildSessions(): void {
    this.childSessions.clear();
  }

  getChildSessions(): CdpChildSessionInfo[] {
    return Array.from(this.childSessions.values());
  }

  private useInjectedRuntime = false;

  enableInjectedRuntime(enabled = true): void {
    this.useInjectedRuntime = enabled;
  }

  private async invokeDom<T>(
    sessionId: string | null | undefined,
    method: InjectedRuntimeMethod,
    args: unknown[],
    fallbackScript: () => string,
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.useInjectedRuntime) {
      return this.evaluateOnSessionWithTimeout<T>(sessionId, fallbackScript(), timeoutMs);
    }
    const callExpr = buildInjectedCallScript(method, ...args);
    const res = await this.evaluateOnSessionWithTimeout<T | typeof SPANA_RUNTIME_MISSING_SENTINEL>(
      sessionId,
      callExpr,
      timeoutMs,
    );
    if (res !== SPANA_RUNTIME_MISSING_SENTINEL) {
      return res as T;
    }
    // Runtime wasn't present on this execution context yet (e.g. already-loaded page) — install once & retry
    await this.evaluateOnSessionWithTimeout(sessionId, SPANA_INJECTED_RUNTIME_SCRIPT, timeoutMs);
    return this.evaluateOnSessionWithTimeout<T>(sessionId, callExpr, timeoutMs);
  }

  setFrameOffsetResolver(resolver: CdpFrameOffsetResolver | undefined): void {
    this.frameOffsetResolver = resolver;
  }

  onEvent(method: string, listener: (params: any, sessionId?: string) => void): () => void {
    let set = this.eventListeners.get(method);
    if (!set) {
      set = new Set();
      this.eventListeners.set(method, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  waitForEvent<T = any>(
    method: string,
    timeoutMs: number = this.timeoutMs,
    predicate?: (params: T, sessionId?: string) => boolean,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`CDP event "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const off = this.onEvent(method, (params: T, sessionId?: string) => {
        if (predicate && !predicate(params, sessionId)) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  async sendCommand<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string | null,
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.isConnected()) {
      await this.connect();
    }
    const ws = this.ws!;
    const id = this.nextId++;
    const resolvedSessionId = sessionId === undefined ? this.activeSessionId : sessionId;
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command "${method}" timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);

      this.pending.set(id, { resolve, reject, timer });
      const payload: Record<string, unknown> = { id, method, params };
      if (resolvedSessionId) {
        payload["sessionId"] = resolvedSessionId;
      }
      ws.send(JSON.stringify(payload));
    });
  }

  private async evaluateOnSessionWithTimeout<T = unknown>(
    sessionId: string | null | undefined,
    script: string | ((...args: any[]) => T),
    timeoutMs?: number,
    args: any[] = [],
    contextId?: number,
    maxAttempts = 3,
  ): Promise<T> {
    const expression = buildEvaluateExpression(script, args);
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;
    const deadline = Date.now() + effectiveTimeout;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const remaining = Math.max(250, deadline - Date.now());
      try {
        const evalParams: Record<string, unknown> = {
          expression,
          returnByValue: true,
          awaitPromise: true,
        };
        if (contextId !== undefined) {
          evalParams["contextId"] = contextId;
        }
        const response = await this.sendCommand<{
          result?: { type?: string; value?: T; description?: string };
          exceptionDetails?: { text?: string; exception?: { description?: string } };
          wasThrown?: boolean;
        }>("Runtime.evaluate", evalParams, sessionId, remaining);

        if (response?.exceptionDetails) {
          const detail =
            response.exceptionDetails.exception?.description ??
            response.exceptionDetails.text ??
            "Evaluation threw an exception";
          throw new Error(`CDP evaluate failed: ${detail}`);
        }
        if (response?.wasThrown) {
          throw new Error(
            `CDP evaluate failed: ${response.result?.description ?? "Evaluation threw an exception"}`,
          );
        }

        return response?.result?.value as T;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isContextDestroyed =
          /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed/i.test(
            msg,
          );
        if (isContextDestroyed && attempt < maxAttempts - 1 && Date.now() < deadline) {
          lastError = new Error(
            `CDP evaluate failed because navigation destroyed the execution context: ${msg}`,
          );
          await new Promise((r) => setTimeout(r, 80));
          continue;
        }
        throw err;
      }
    }

    throw lastError ?? new Error("CDP evaluate failed: execution context was destroyed");
  }

  /** Single-attempt evaluate that fails immediately on navigation instead of sleeping/retrying. */
  async evaluateFast<T = unknown>(
    script: string | ((...args: any[]) => T),
    ...args: any[]
  ): Promise<T> {
    return this.evaluateOnSessionWithTimeout<T>(undefined, script, 2_000, args, undefined, 1);
  }

  async evaluateOnSession<T = unknown>(
    sessionId: string | null | undefined,
    script: string | ((...args: any[]) => T),
    ...args: any[]
  ): Promise<T> {
    return this.evaluateOnSessionWithTimeout<T>(sessionId, script, undefined, args);
  }

  async evaluate<T = unknown>(
    script: string | ((...args: any[]) => T),
    ...args: any[]
  ): Promise<T> {
    return this.evaluateOnSession<T>(undefined, script, ...args);
  }

  private async applyChildOffset(
    matches: DomElementMatch[],
    child: CdpChildSessionInfo,
  ): Promise<DomElementMatch[]> {
    const offset = this.frameOffsetResolver
      ? await this.frameOffsetResolver(child).catch(() => ({ x: 0, y: 0 }))
      : { x: 0, y: 0 };
    return matches.map((m) => ({
      ...m,
      inIframe: true,
      rect: {
        ...m.rect,
        x: m.rect.x + offset.x,
        y: m.rect.y + offset.y,
      },
    }));
  }

  private hasExplicitFrame(selector: Selector): boolean {
    return (
      typeof selector === "object" &&
      selector !== null &&
      "frame" in selector &&
      Boolean(selector.frame)
    );
  }

  private stripFrameFromSelector(selector: Selector): Selector {
    if (this.hasExplicitFrame(selector)) {
      const { frame: _frame, ...rest } = selector as unknown as Record<string, unknown>;
      return rest as Selector;
    }
    return selector;
  }

  private applyFrameOffset(
    matches: DomElementMatch[],
    offset: { x: number; y: number },
  ): DomElementMatch[] {
    return matches.map((m) => ({
      ...m,
      inIframe: true,
      rect: {
        ...m.rect,
        x: m.rect.x + offset.x,
        y: m.rect.y + offset.y,
      },
    }));
  }

  /**
   * Resolve in-process cross-origin child frames (e.g. same-site subdomains such as
   * `notes.app.localhost` embedded in `studio.app.localhost`). Chromium places same-site
   * iframes in the same renderer process (so no OOPIF target/session is created), while
   * Same-Origin Policy still blocks `iframe.contentDocument` from JS in the top document.
   * Using `Page.getFrameTree` + `Page.createIsolatedWorld` accesses them cleanly via CDP.
   */
  private async resolveInProcessChildFrames(
    selector: Selector,
  ): Promise<Array<{ frameId: string; url: string; offset: { x: number; y: number } }>> {
    if (!this.hasExplicitFrame(selector)) return [];
    const frameSel = (selector as { frame?: unknown }).frame;

    const treeRes = await this.sendCommand<{
      frameTree?: {
        frame?: { id: string; url?: string; name?: string };
        childFrames?: Array<any>;
      };
    }>("Page.getFrameTree").catch(() => null);
    if (!treeRes?.frameTree?.childFrames?.length) return [];

    const flatFrames: Array<{ id: string; url: string; name: string }> = [];
    const walk = (nodes: Array<any> | undefined) => {
      if (!Array.isArray(nodes)) return;
      for (const n of nodes) {
        if (n?.frame?.id) {
          flatFrames.push({
            id: n.frame.id,
            url: n.frame.url ?? "",
            name: n.frame.name ?? "",
          });
        }
        if (n?.childFrames) walk(n.childFrames);
      }
    };
    walk(treeRes.frameTree.childFrames);
    if (flatFrames.length === 0) return [];

    // Locate matching <iframe> elements in the main document to read their `src` and viewport offset
    const iframeInfos = await this.evaluateOnSession<
      Array<{ src: string; name: string; x: number; y: number }>
    >(
      undefined,
      `((fSel) => {
        try {
          const iframes = Array.from(document.querySelectorAll("iframe"));
          const matched = [];
          for (const el of iframes) {
            let ok = false;
            if (typeof fSel === "string") {
              if (el.getAttribute("title") === fSel || el.getAttribute("aria-label") === fSel || el.getAttribute("name") === fSel) ok = true;
              else { try { if (el.matches(fSel)) ok = true; } catch {} }
            } else if (fSel && typeof fSel === "object") {
              if (fSel.css) {
                try { if (el.matches(fSel.css)) ok = true; } catch {}
              } else if (fSel.testID && (el.getAttribute("data-testid") === fSel.testID || el.getAttribute("testID") === fSel.testID)) {
                ok = true;
              } else if (fSel.accessibilityLabel && (el.getAttribute("aria-label") === fSel.accessibilityLabel || el.getAttribute("title") === fSel.accessibilityLabel)) {
                ok = true;
              } else if (fSel.text && (el.getAttribute("title") === fSel.text || el.getAttribute("aria-label") === fSel.text)) {
                ok = true;
              }
            }
            if (ok) {
              const r = el.getBoundingClientRect();
              matched.push({ src: el.src || "", name: el.getAttribute("name") || "", x: r.left, y: r.top });
            }
          }
          return matched;
        } catch { return []; }
      })(${JSON.stringify(frameSel)})`,
    ).catch(() => [] as Array<{ src: string; name: string; x: number; y: number }>);

    if (iframeInfos.length === 0) return [];

    const out: Array<{ frameId: string; url: string; offset: { x: number; y: number } }> = [];
    for (const info of iframeInfos) {
      const match =
        flatFrames.find((f) => {
          if (info.name && f.name && f.name === info.name) return true;
          if (!info.src || !f.url) return false;
          try {
            const a = new URL(info.src);
            const b = new URL(f.url);
            return (
              a.origin === b.origin && (b.pathname === a.pathname || f.url.startsWith(info.src))
            );
          } catch {
            return f.url === info.src || f.url.startsWith(info.src);
          }
        }) ??
        flatFrames.find((f) => {
          if (!info.src || !f.url) return false;
          try {
            return new URL(info.src).origin === new URL(f.url).origin;
          } catch {
            return false;
          }
        });
      if (match && !out.some((x) => x.frameId === match.id)) {
        out.push({ frameId: match.id, url: match.url, offset: { x: info.x, y: info.y } });
      }
    }
    return out;
  }

  private async evaluateInProcessFrame<T>(
    frameId: string,
    script: string,
    timeoutMs?: number,
  ): Promise<T> {
    const world = await this.sendCommand<{ executionContextId: number }>(
      "Page.createIsolatedWorld",
      {
        frameId,
        worldName: "spana-frame",
        grantUniveralAccess: false,
      },
    );
    return this.evaluateOnSessionWithTimeout<T>(
      undefined,
      script,
      timeoutMs,
      [],
      world.executionContextId,
    );
  }

  private async resolveMatchingChildSessions(selector: Selector): Promise<CdpChildSessionInfo[]> {
    const all = Array.from(this.childSessions.values());
    if (all.length === 0) return [];
    if (
      typeof selector !== "object" ||
      selector === null ||
      !("frame" in selector) ||
      !selector.frame
    ) {
      return all;
    }
    const frameSel = selector.frame;
    const hints: string[] = [];
    if (typeof frameSel === "string") hints.push(frameSel);
    else if (typeof frameSel === "object" && frameSel !== null) {
      if ("css" in frameSel && frameSel.css) hints.push(frameSel.css);
      if ("testID" in frameSel && frameSel.testID) hints.push(frameSel.testID);
      if ("accessibilityLabel" in frameSel && frameSel.accessibilityLabel) {
        hints.push(frameSel.accessibilityLabel);
      }
      if ("text" in frameSel && frameSel.text) hints.push(frameSel.text);
    }
    // Try to read the matching iframe's `src` attribute from the main document so we pick the exact OOPIF session
    const iframeSrcs = await this.evaluateOnSession<string[]>(
      undefined,
      `((fSel) => {
        try {
          const iframes = Array.from(document.querySelectorAll("iframe"));
          const matched = [];
          for (const el of iframes) {
            if (typeof fSel === "string") {
              if (el.getAttribute("title") === fSel || el.getAttribute("aria-label") === fSel || el.getAttribute("name") === fSel || el.matches(fSel)) {
                if (el.src) matched.push(el.src);
              }
            } else if (fSel && typeof fSel === "object") {
              if (fSel.css) {
                try { if (el.matches(fSel.css) && el.src) matched.push(el.src); } catch {}
              } else if (fSel.testID && (el.getAttribute("data-testid") === fSel.testID || el.getAttribute("testID") === fSel.testID)) {
                if (el.src) matched.push(el.src);
              } else if (fSel.accessibilityLabel && (el.getAttribute("aria-label") === fSel.accessibilityLabel || el.getAttribute("title") === fSel.accessibilityLabel)) {
                if (el.src) matched.push(el.src);
              }
            }
          }
          return matched;
        } catch { return []; }
      })(${JSON.stringify(frameSel)})`,
    ).catch(() => [] as string[]);

    if (iframeSrcs.length > 0) {
      const matched = all.filter(
        (c) =>
          c.url &&
          iframeSrcs.some((src) => {
            try {
              const a = new URL(src);
              const b = new URL(c.url!);
              return a.origin === b.origin && (b.pathname === a.pathname || c.url!.startsWith(src));
            } catch {
              return c.url!.includes(src) || src.includes(c.url!);
            }
          }),
      );
      if (matched.length > 0) return matched;
    }

    if (hints.length > 0) {
      const byHint = all.filter((c) => c.url && hints.some((h) => c.url!.includes(h)));
      if (byHint.length > 0) return byHint;
    }
    return all;
  }

  async query(selector: Selector): Promise<DomElementMatch[]> {
    const fallback = () => buildDomQueryScript(selector);
    const result = await this.invokeDom<DomElementMatch[]>(
      undefined,
      "query",
      [selector],
      fallback,
    );
    if (Array.isArray(result) && result.length > 0) return result;

    const innerSel = this.stripFrameFromSelector(selector);
    const childFallback = () => buildDomQueryScript(innerSel);

    if (this.childSessions.size > 0) {
      const candidates = await this.resolveMatchingChildSessions(selector);
      for (const child of candidates) {
        const childRes = await this.invokeDom<DomElementMatch[]>(
          child.sessionId,
          "query",
          [innerSel],
          childFallback,
        ).catch(() => []);
        if (Array.isArray(childRes) && childRes.length > 0) {
          return this.applyChildOffset(childRes, child);
        }
      }
    }

    if (this.hasExplicitFrame(selector)) {
      const inProcessFrames = await this.resolveInProcessChildFrames(selector);
      for (const frame of inProcessFrames) {
        const frameRes = await this.evaluateInProcessFrame<DomElementMatch[]>(
          frame.frameId,
          childFallback(),
        ).catch(() => []);
        if (Array.isArray(frameRes) && frameRes.length > 0) {
          return this.applyFrameOffset(frameRes, frame.offset);
        }
      }
    }
    return [];
  }

  async waitForSelector(
    selector: Selector,
    opts?: DomWaitForSelectorOptions,
  ): Promise<DomElementMatch[]> {
    const rpcTimeout = Math.max((opts?.timeoutMs ?? 5000) + 5000, this.timeoutMs);
    const fallback = () => buildDomWaitForSelectorScript(selector, opts);
    const explicitFrame = this.hasExplicitFrame(selector);
    if (this.childSessions.size === 0 && !explicitFrame) {
      const result = await this.invokeDom<DomElementMatch[]>(
        undefined,
        "waitForSelector",
        [selector, opts ?? {}],
        fallback,
        rpcTimeout,
      );
      return Array.isArray(result) ? result : [];
    }

    // Fast immediate check on main frame first, then attached OOPIF / in-process frames
    const immediate = await this.query(selector);
    const filtered = immediate.filter((m) => m.visible && (!opts?.forAction || m.enabled));
    if (filtered.length > 0 && !opts?.forAction) return filtered;

    const innerSel = this.stripFrameFromSelector(selector);
    const childFallback = () => buildDomWaitForSelectorScript(innerSel, opts);
    const candidates =
      this.childSessions.size > 0 ? await this.resolveMatchingChildSessions(selector) : [];
    const inProcessFrames = explicitFrame ? await this.resolveInProcessChildFrames(selector) : [];

    // Race reactive MutationObserver wait across main frame, OOPIF sessions, and in-process cross-origin frames
    const racers: Array<Promise<DomElementMatch[]>> = [
      this.invokeDom<DomElementMatch[]>(
        undefined,
        "waitForSelector",
        [selector, opts ?? {}],
        fallback,
        rpcTimeout,
      ).catch(() => []),
      ...candidates.map(async (child) => {
        const res = await this.invokeDom<DomElementMatch[]>(
          child.sessionId,
          "waitForSelector",
          [innerSel, opts ?? {}],
          childFallback,
          rpcTimeout,
        ).catch(() => []);
        return Array.isArray(res) && res.length > 0 ? this.applyChildOffset(res, child) : [];
      }),
      ...inProcessFrames.map(async (frame) => {
        const res = await this.evaluateInProcessFrame<DomElementMatch[]>(
          frame.frameId,
          childFallback(),
          rpcTimeout,
        ).catch(() => []);
        return Array.isArray(res) && res.length > 0 ? this.applyFrameOffset(res, frame.offset) : [];
      }),
    ];

    // If an explicit frame hasn't navigated/mounted into Page.getFrameTree yet, poll briefly until it appears
    if (explicitFrame && candidates.length === 0 && inProcessFrames.length === 0) {
      const deadline = Date.now() + (opts?.timeoutMs ?? 5000);
      racers.push(
        (async () => {
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 60));
            const appeared = await this.resolveInProcessChildFrames(selector);
            if (appeared.length > 0) {
              const remaining = Math.max(200, deadline - Date.now());
              const waitScript = buildDomWaitForSelectorScript(innerSel, {
                ...opts,
                timeoutMs: remaining,
              });
              for (const frame of appeared) {
                const res = await this.evaluateInProcessFrame<DomElementMatch[]>(
                  frame.frameId,
                  waitScript,
                  remaining + 2000,
                ).catch(() => []);
                if (Array.isArray(res) && res.length > 0) {
                  return this.applyFrameOffset(res, frame.offset);
                }
              }
            }
          }
          return [];
        })(),
      );
    }

    return new Promise<DomElementMatch[]>((resolve) => {
      let remaining = racers.length;
      let resolved = false;
      for (const p of racers) {
        void p.then((matches) => {
          if (resolved) return;
          if (Array.isArray(matches) && matches.length > 0) {
            resolved = true;
            resolve(matches);
            return;
          }
          remaining -= 1;
          if (remaining <= 0) {
            resolved = true;
            resolve([]);
          }
        });
      }
    });
  }

  async waitForHidden(selector: Selector, opts?: DomWaitForHiddenOptions): Promise<boolean> {
    const rpcTimeout = Math.max((opts?.timeoutMs ?? 5000) + 5000, this.timeoutMs);
    const fallback = () => buildDomWaitForHiddenScript(selector, opts);
    // Check in-process cross-origin frames BEFORE waiting on the main frame when `selector.frame` is set
    const explicitFrame = this.hasExplicitFrame(selector);
    const inProcessFrames = explicitFrame ? await this.resolveInProcessChildFrames(selector) : [];
    if (inProcessFrames.length > 0) {
      const innerSel = this.stripFrameFromSelector(selector);
      const childFallback = () => buildDomWaitForHiddenScript(innerSel, opts);
      for (const frame of inProcessFrames) {
        const ok = Boolean(
          await this.evaluateInProcessFrame<boolean>(
            frame.frameId,
            childFallback(),
            rpcTimeout,
          ).catch(() => true),
        );
        if (!ok) return false;
      }
      return true;
    }

    const mainHidden = Boolean(
      await this.invokeDom<boolean>(
        undefined,
        "waitForHidden",
        [selector, opts ?? {}],
        fallback,
        rpcTimeout,
      ),
    );
    if (!mainHidden || this.childSessions.size === 0) return mainHidden;
    const innerSel = this.stripFrameFromSelector(selector);
    const childFallback = () => buildDomWaitForHiddenScript(innerSel, opts);
    const candidates = await this.resolveMatchingChildSessions(selector);
    for (const child of candidates) {
      const ok = Boolean(
        await this.invokeDom<boolean>(
          child.sessionId,
          "waitForHidden",
          [innerSel, opts ?? {}],
          childFallback,
          rpcTimeout,
        ).catch(() => true),
      );
      if (!ok) return false;
    }
    return true;
  }

  async waitForMatch(
    selector: Selector,
    opts: DomWaitForMatchOptions,
  ): Promise<DomWaitForMatchResult> {
    const rpcTimeout = Math.max((opts?.timeoutMs ?? 5000) + 5000, this.timeoutMs);
    const fallback = () => buildDomWaitForMatchScript(selector, opts);
    const explicitFrame = this.hasExplicitFrame(selector);
    const innerSel = this.stripFrameFromSelector(selector);
    const childFallback = () => buildDomWaitForMatchScript(innerSel, opts);

    // If an explicit frame resolves to an in-process cross-origin frame (where main-frame SOP blocks
    // iframe.contentDocument), evaluate directly inside that frame instead of burning timeoutMs on main first!
    if (explicitFrame) {
      const inProcessFrames = await this.resolveInProcessChildFrames(selector);
      if (inProcessFrames.length > 0) {
        let lastRes: DomWaitForMatchResult = { matched: false };
        for (const frame of inProcessFrames) {
          const frameRes = await this.evaluateInProcessFrame<DomWaitForMatchResult>(
            frame.frameId,
            childFallback(),
            rpcTimeout,
          ).catch(() => ({ matched: false }) as DomWaitForMatchResult);
          if (frameRes?.matched) return frameRes;
          lastRes = frameRes;
        }
        return lastRes;
      }
    }

    if (this.childSessions.size > 0) {
      const candidates = await this.resolveMatchingChildSessions(selector);
      if (explicitFrame && candidates.length > 0) {
        let lastRes: DomWaitForMatchResult = { matched: false };
        for (const child of candidates) {
          const childRes = await this.invokeDom<DomWaitForMatchResult>(
            child.sessionId,
            "waitForMatch",
            [innerSel, opts],
            childFallback,
            rpcTimeout,
          ).catch(() => ({ matched: false }) as DomWaitForMatchResult);
          if (childRes?.matched) return childRes;
          lastRes = childRes;
        }
        return lastRes;
      }
    }

    const result = await this.invokeDom<DomWaitForMatchResult>(
      undefined,
      "waitForMatch",
      [selector, opts],
      fallback,
      rpcTimeout,
    );
    if (result && typeof result === "object" && result.matched) return result;
    if (this.childSessions.size > 0) {
      const candidates = await this.resolveMatchingChildSessions(selector);
      for (const child of candidates) {
        const childRes = await this.invokeDom<DomWaitForMatchResult>(
          child.sessionId,
          "waitForMatch",
          [innerSel, opts],
          childFallback,
          rpcTimeout,
        ).catch(() => ({ matched: false }));
        if (childRes?.matched) return childRes;
      }
    }
    return result && typeof result === "object" ? result : { matched: false };
  }

  async fillDom(selector: Selector, value: string, opts?: DomFillOptions): Promise<boolean> {
    const rpcTimeout = Math.max((opts?.timeoutMs ?? 5000) + 5000, this.timeoutMs);
    const fallback = () => buildDomFillScript(selector, value, opts);
    const explicitFrame = this.hasExplicitFrame(selector);
    const innerSel = this.stripFrameFromSelector(selector);
    const childFallback = () => buildDomFillScript(innerSel, value, opts);
    if (explicitFrame) {
      const inProcessFrames = await this.resolveInProcessChildFrames(selector);
      if (inProcessFrames.length > 0) {
        for (const frame of inProcessFrames) {
          const ok = Boolean(
            await this.evaluateInProcessFrame<boolean>(
              frame.frameId,
              childFallback(),
              rpcTimeout,
            ).catch(() => false),
          );
          if (ok) return true;
        }
        return false;
      }
    }
    const mainFilled = Boolean(
      await this.invokeDom<boolean>(
        undefined,
        "fill",
        [selector, value, opts ?? {}],
        fallback,
        rpcTimeout,
      ),
    );
    if (mainFilled || this.childSessions.size === 0) return mainFilled;
    const candidates = await this.resolveMatchingChildSessions(selector);
    for (const child of candidates) {
      const ok = Boolean(
        await this.invokeDom<boolean>(
          child.sessionId,
          "fill",
          [innerSel, value, opts ?? {}],
          childFallback,
          rpcTimeout,
        ).catch(() => false),
      );
      if (ok) return true;
    }
    return false;
  }

  async tapDom(selector: Selector): Promise<boolean> {
    const fallback = () => buildDomTapScript(selector);
    const mainTapped = Boolean(
      await this.invokeDom<boolean>(undefined, "tap", [selector], fallback),
    );
    const explicitFrame = this.hasExplicitFrame(selector);
    if (mainTapped || (this.childSessions.size === 0 && !explicitFrame)) return mainTapped;
    const innerSel = this.stripFrameFromSelector(selector);
    const childFallback = () => buildDomTapScript(innerSel);
    if (this.childSessions.size > 0) {
      const candidates = await this.resolveMatchingChildSessions(selector);
      for (const child of candidates) {
        const ok = Boolean(
          await this.invokeDom<boolean>(child.sessionId, "tap", [innerSel], childFallback).catch(
            () => false,
          ),
        );
        if (ok) return true;
      }
    }
    if (explicitFrame) {
      const inProcessFrames = await this.resolveInProcessChildFrames(selector);
      for (const frame of inProcessFrames) {
        const ok = Boolean(
          await this.evaluateInProcessFrame<boolean>(frame.frameId, childFallback()).catch(
            () => false,
          ),
        );
        if (ok) return true;
      }
    }
    return false;
  }

  async scrollIntoView(selector: Selector): Promise<DomElementMatch | null> {
    const fallback = () => buildDomScrollIntoViewScript(selector);
    const result = await this.invokeDom<DomElementMatch | null>(
      undefined,
      "scrollIntoView",
      [selector],
      fallback,
    );
    if (result) return result;
    const innerSel = this.stripFrameFromSelector(selector);
    const childFallback = () => buildDomScrollIntoViewScript(innerSel);
    if (this.childSessions.size > 0) {
      const candidates = await this.resolveMatchingChildSessions(selector);
      for (const child of candidates) {
        const childRes = await this.invokeDom<DomElementMatch | null>(
          child.sessionId,
          "scrollIntoView",
          [innerSel],
          childFallback,
        ).catch(() => null);
        if (childRes) {
          const adjusted = await this.applyChildOffset([childRes], child);
          return adjusted[0] ?? null;
        }
      }
    }
    if (this.hasExplicitFrame(selector)) {
      const inProcessFrames = await this.resolveInProcessChildFrames(selector);
      for (const frame of inProcessFrames) {
        const frameRes = await this.evaluateInProcessFrame<DomElementMatch | null>(
          frame.frameId,
          childFallback(),
        ).catch(() => null);
        if (frameRes) {
          const adjusted = this.applyFrameOffset([frameRes], frame.offset);
          return adjusted[0] ?? null;
        }
      }
    }
    return null;
  }

  async reload(): Promise<void> {
    await this.sendCommand("Page.reload", { ignoreCache: false }).catch(async () => {
      await this.evaluate("window.location.reload()");
    });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.rejectAllPending(new Error("CDP channel disconnected"));
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore close errors
      }
      this.ws = null;
    }
  }

  get targetId(): string | null {
    return this.currentTargetId;
  }
}

export function createCdpDomChannel(options: CdpDomChannelOptions): CdpDomChannel {
  return new CdpDomChannel(options);
}
