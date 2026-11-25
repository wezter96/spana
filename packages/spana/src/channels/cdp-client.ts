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
  type DomChannel,
  type DomElementMatch,
  type DomFillOptions,
  type DomTargetInfo,
  type DomWaitForHiddenOptions,
  type DomWaitForMatchOptions,
  type DomWaitForMatchResult,
  type DomWaitForSelectorOptions,
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
  ): Promise<T> {
    if (!this.isConnected()) {
      await this.connect();
    }
    const ws = this.ws!;
    const id = this.nextId++;
    const resolvedSessionId = sessionId === undefined ? this.activeSessionId : sessionId;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command "${method}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      const payload: Record<string, unknown> = { id, method, params };
      if (resolvedSessionId) {
        payload["sessionId"] = resolvedSessionId;
      }
      ws.send(JSON.stringify(payload));
    });
  }

  async evaluateOnSession<T = unknown>(
    sessionId: string | null | undefined,
    script: string | ((...args: any[]) => T),
    ...args: any[]
  ): Promise<T> {
    const expression = buildEvaluateExpression(script, args);
    const response = await this.sendCommand<{
      result?: { type?: string; value?: T; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
      wasThrown?: boolean;
    }>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId,
    );

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

  async query(selector: Selector): Promise<DomElementMatch[]> {
    const script = buildDomQueryScript(selector);
    const result = await this.evaluate<DomElementMatch[]>(script);
    if (Array.isArray(result) && result.length > 0) return result;
    if (this.childSessions.size === 0) return [];

    for (const child of this.childSessions.values()) {
      const childRes = await this.evaluateOnSession<DomElementMatch[]>(
        child.sessionId,
        script,
      ).catch(() => []);
      if (Array.isArray(childRes) && childRes.length > 0) {
        return this.applyChildOffset(childRes, child);
      }
    }
    return [];
  }

  async waitForSelector(
    selector: Selector,
    opts?: DomWaitForSelectorOptions,
  ): Promise<DomElementMatch[]> {
    if (this.childSessions.size === 0) {
      const result = await this.evaluate<DomElementMatch[]>(
        buildDomWaitForSelectorScript(selector, opts),
      );
      return Array.isArray(result) ? result : [];
    }

    // Fast immediate check on main frame first, then attached OOPIF frames
    const immediate = await this.query(selector);
    const filtered = immediate.filter((m) => m.visible && (!opts?.forAction || m.enabled));
    if (filtered.length > 0 && !opts?.forAction) return filtered;

    // Race reactive MutationObserver wait across main frame and attached OOPIF sessions
    const script = buildDomWaitForSelectorScript(selector, opts);
    const racers: Array<Promise<DomElementMatch[]>> = [
      this.evaluate<DomElementMatch[]>(script).catch(() => []),
      ...Array.from(this.childSessions.values()).map(async (child) => {
        const res = await this.evaluateOnSession<DomElementMatch[]>(child.sessionId, script).catch(
          () => [],
        );
        return Array.isArray(res) && res.length > 0 ? this.applyChildOffset(res, child) : [];
      }),
    ];

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
    const script = buildDomWaitForHiddenScript(selector, opts);
    const mainHidden = Boolean(await this.evaluate<boolean>(script));
    if (!mainHidden || this.childSessions.size === 0) return mainHidden;
    for (const child of this.childSessions.values()) {
      const ok = Boolean(
        await this.evaluateOnSession<boolean>(child.sessionId, script).catch(() => true),
      );
      if (!ok) return false;
    }
    return true;
  }

  async waitForMatch(
    selector: Selector,
    opts: DomWaitForMatchOptions,
  ): Promise<DomWaitForMatchResult> {
    const script = buildDomWaitForMatchScript(selector, opts);
    const result = await this.evaluate<DomWaitForMatchResult>(script);
    if (result && typeof result === "object" && result.matched) return result;
    if (this.childSessions.size > 0) {
      for (const child of this.childSessions.values()) {
        const childRes = await this.evaluateOnSession<DomWaitForMatchResult>(
          child.sessionId,
          script,
        ).catch(() => ({ matched: false }));
        if (childRes?.matched) return childRes;
      }
    }
    return result && typeof result === "object" ? result : { matched: false };
  }

  async fillDom(selector: Selector, value: string, opts?: DomFillOptions): Promise<boolean> {
    const script = buildDomFillScript(selector, value, opts);
    const mainFilled = Boolean(await this.evaluate<boolean>(script));
    if (mainFilled || this.childSessions.size === 0) return mainFilled;
    for (const child of this.childSessions.values()) {
      const ok = Boolean(
        await this.evaluateOnSession<boolean>(child.sessionId, script).catch(() => false),
      );
      if (ok) return true;
    }
    return false;
  }

  async tapDom(selector: Selector): Promise<boolean> {
    const script = buildDomTapScript(selector);
    const mainTapped = Boolean(await this.evaluate<boolean>(script));
    if (mainTapped || this.childSessions.size === 0) return mainTapped;
    for (const child of this.childSessions.values()) {
      const ok = Boolean(
        await this.evaluateOnSession<boolean>(child.sessionId, script).catch(() => false),
      );
      if (ok) return true;
    }
    return false;
  }

  async scrollIntoView(selector: Selector): Promise<DomElementMatch | null> {
    const script = buildDomScrollIntoViewScript(selector);
    const result = await this.evaluate<DomElementMatch | null>(script);
    if (result) return result;
    if (this.childSessions.size > 0) {
      for (const child of this.childSessions.values()) {
        const childRes = await this.evaluateOnSession<DomElementMatch | null>(
          child.sessionId,
          script,
        ).catch(() => null);
        if (childRes) {
          const adjusted = await this.applyChildOffset([childRes], child);
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
