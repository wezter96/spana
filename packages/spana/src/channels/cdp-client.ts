import type { Selector } from "../schemas/selector.js";
import {
  buildDomFillScript,
  buildDomFrameEvaluateScript,
  buildDomQueryScript,
  buildDomScrollIntoViewScript,
  buildDomTapScript,
  buildDomWaitForHiddenScript,
  buildDomWaitForMatchScript,
  buildDomWaitForSelectorScript,
  buildEvaluateExpression,
  buildInjectedCallScript,
  serializeEvaluateArg,
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
  /** Optional zero-copy fast path used by `CdpWebSocketMultiplexer` to avoid double JSON parse/stringify. */
  sendParsed?(payload: Record<string, unknown>): void;
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
const WS_CLOSED = 3;

function defaultWebSocketFactory(url: string): MinimalWebSocket {
  return new WebSocket(url) as unknown as MinimalWebSocket;
}

interface MultiplexerInFlight {
  client: VirtualCdpWebSocket;
  localId: number;
  method: string;
  sessionId?: string;
  browserContextId?: string;
}

class VirtualCdpWebSocket implements MinimalWebSocket {
  readyState: number;
  private readonly listeners = new Map<string, Set<(event: any) => void>>();

  constructor(
    private readonly mux: CdpWebSocketMultiplexer,
    initialReadyState: number,
  ) {
    this.readyState = initialReadyState;
  }

  send(data: string): void {
    this.mux.handleClientSend(this, data);
  }

  sendParsed(payload: Record<string, unknown>): void {
    this.mux.handleClientSendParsed(this, payload);
  }

  close(): void {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this.mux.handleClientClose(this);
    this.emit("close", {});
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: any): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch {
        // virtual listener error must not kill multiplexer loop
      }
    }
  }
}

/**
 * Multiplexes N independent `CdpDomChannel` workers over ONE real browser-level
 * CDP WebSocket connection.
 *
 * - Remaps JSON-RPC `id`s per virtual client and routes command responses directly
 *   back to the requesting client.
 * - Tracks `sessionId` ownership (from `Target.attachToTarget` responses,
 *   `Target.attachedToTarget` events, and client commands) and `browserContextId`
 *   ownership (from `Target.createBrowserContext` responses) for O(1) event routing
 *   with zero N× fan-out parsing overhead.
 * - Closes the underlying WebSocket automatically once the last virtual socket disconnects.
 */
export class CdpWebSocketMultiplexer {
  private readonly wsUrl: string;
  private readonly createWebSocket: WebSocketFactory;
  private realWs: MinimalWebSocket | null = null;
  private state = 0; // 0=connecting, 1=open, 3=closed
  private nextGlobalId = 1;
  private readonly clients = new Set<VirtualCdpWebSocket>();
  private readonly inFlight = new Map<number, MultiplexerInFlight>();
  private readonly sessionOwner = new Map<string, VirtualCdpWebSocket>();
  private readonly contextOwner = new Map<string, VirtualCdpWebSocket>();
  private readonly pendingFrames: string[] = [];

  constructor(wsUrl: string, createWebSocket: WebSocketFactory = defaultWebSocketFactory) {
    this.wsUrl = wsUrl;
    this.createWebSocket = createWebSocket;
  }

  get activeVirtualSockets(): number {
    return this.clients.size;
  }

  get underlyingSocketOpen(): boolean {
    return this.realWs !== null && this.state === WS_OPEN;
  }

  createVirtualSocket(): MinimalWebSocket {
    this.ensureConnected();
    const virtual = new VirtualCdpWebSocket(this, this.state);
    this.clients.add(virtual);
    return virtual;
  }

  private ensureConnected(): void {
    if (this.realWs && this.state !== WS_CLOSED) return;
    this.state = 0;
    const ws = this.createWebSocket(this.wsUrl);
    this.realWs = ws;

    const onOpen = () => {
      if (this.realWs !== ws) return;
      this.state = WS_OPEN;
      if (this.pendingFrames.length > 0) {
        const frames = this.pendingFrames.splice(0, this.pendingFrames.length);
        for (const frame of frames) {
          ws.send(frame);
        }
      }
      for (const client of this.clients) {
        if (client.readyState !== WS_CLOSED) {
          client.readyState = WS_OPEN;
          client.emit("open", {});
        }
      }
    };

    const onError = (err: unknown) => {
      if (this.realWs !== ws) return;
      for (const client of this.clients) {
        if (client.readyState !== WS_CLOSED) {
          client.emit("error", err);
        }
      }
    };

    const onClose = () => {
      if (this.realWs !== ws) return;
      this.state = WS_CLOSED;
      this.realWs = null;
      this.inFlight.clear();
      this.sessionOwner.clear();
      this.contextOwner.clear();
      this.pendingFrames.length = 0;
      for (const client of Array.from(this.clients)) {
        if (client.readyState !== WS_CLOSED) {
          client.readyState = WS_CLOSED;
          client.emit("close", {});
        }
      }
      this.clients.clear();
    };

    const onMessage = (event: { data?: unknown }) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data ?? "");
      let parsed: Record<string, any>;
      try {
        parsed = JSON.parse(raw) as Record<string, any>;
      } catch {
        return;
      }

      const globalId = parsed["id"];
      if (typeof globalId === "number") {
        const entry = this.inFlight.get(globalId);
        if (!entry) return;
        this.inFlight.delete(globalId);
        if (!parsed["error"]) {
          const res = parsed["result"];
          if (
            entry.method === "Target.createBrowserContext" &&
            typeof res?.browserContextId === "string"
          ) {
            this.contextOwner.set(res.browserContextId, entry.client);
          } else if (
            entry.method === "Target.attachToTarget" &&
            typeof res?.sessionId === "string"
          ) {
            this.sessionOwner.set(res.sessionId, entry.client);
          } else if (
            entry.method === "Target.disposeBrowserContext" &&
            typeof entry.browserContextId === "string"
          ) {
            this.contextOwner.delete(entry.browserContextId);
          }
        }
        if (entry.client.readyState === WS_CLOSED) return;
        parsed["id"] = entry.localId;
        entry.client.emit("message", { parsed });
        return;
      }

      const method = parsed["method"];
      if (typeof method !== "string") return;

      const sid = typeof parsed["sessionId"] === "string" ? parsed["sessionId"] : undefined;
      const params = parsed["params"];
      const bcid =
        typeof params?.targetInfo?.browserContextId === "string"
          ? params.targetInfo.browserContextId
          : typeof params?.browserContextId === "string"
            ? params.browserContextId
            : undefined;

      let owner: VirtualCdpWebSocket | undefined =
        (sid ? this.sessionOwner.get(sid) : undefined) ??
        (bcid ? this.contextOwner.get(bcid) : undefined);

      if (method === "Target.attachedToTarget" && typeof params?.sessionId === "string") {
        if (owner) {
          this.sessionOwner.set(params.sessionId, owner);
        }
      } else if (method === "Target.detachedFromTarget" && typeof params?.sessionId === "string") {
        const detachedSid = params.sessionId as string;
        if (!owner) owner = this.sessionOwner.get(detachedSid);
        this.sessionOwner.delete(detachedSid);
      }

      if (owner) {
        if (owner.readyState !== WS_CLOSED) {
          owner.emit("message", { parsed, data: raw });
        }
        return;
      }

      // Unscoped browser-level event without a known context/session owner: broadcast
      for (const client of this.clients) {
        if (client.readyState !== WS_CLOSED) {
          client.emit("message", { parsed, data: raw });
        }
      }
    };

    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
    ws.addEventListener("message", onMessage);

    if (ws.readyState === WS_OPEN) {
      onOpen();
    }
  }

  /** @internal */
  handleClientSend(client: VirtualCdpWebSocket, data: string): void {
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(data) as Record<string, any>;
    } catch {
      return;
    }
    this.handleClientSendParsed(client, parsed);
  }

  /** @internal */
  handleClientSendParsed(client: VirtualCdpWebSocket, parsed: Record<string, any>): void {
    const localId = parsed["id"];
    if (typeof localId !== "number") return;

    const method = typeof parsed["method"] === "string" ? parsed["method"] : "";
    const sessionId = typeof parsed["sessionId"] === "string" ? parsed["sessionId"] : undefined;
    const browserContextId =
      typeof parsed["params"]?.browserContextId === "string"
        ? (parsed["params"].browserContextId as string)
        : undefined;

    if (sessionId && !this.sessionOwner.has(sessionId)) {
      this.sessionOwner.set(sessionId, client);
    }

    const globalId = this.nextGlobalId++;
    this.inFlight.set(globalId, { client, localId, method, sessionId, browserContextId });
    parsed["id"] = globalId;
    const serialized = JSON.stringify(parsed);

    if (this.realWs && this.state === WS_OPEN) {
      this.realWs.send(serialized);
    } else {
      this.pendingFrames.push(serialized);
    }
  }

  /** @internal */
  handleClientClose(client: VirtualCdpWebSocket): void {
    this.clients.delete(client);
    for (const [id, entry] of this.inFlight) {
      if (entry.client === client) this.inFlight.delete(id);
    }
    for (const [sid, owner] of this.sessionOwner) {
      if (owner === client) this.sessionOwner.delete(sid);
    }
    for (const [bcid, owner] of this.contextOwner) {
      if (owner === client) this.contextOwner.delete(bcid);
    }
    if (this.clients.size === 0 && this.realWs) {
      const ws = this.realWs;
      this.realWs = null;
      this.state = WS_CLOSED;
      this.pendingFrames.length = 0;
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
    }
  }
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

export interface CdpFrameTransform {
  x: number;
  y: number;
  scaleX?: number;
  scaleY?: number;
}

export type CdpFrameOffsetResolver = (child: CdpChildSessionInfo) => Promise<CdpFrameTransform>;

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
  private permanentlyClosed = false;
  private closedReason = "Browser context closed";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private pendingEventCancels = new Set<(err: Error) => void>();
  private eventListeners = new Map<string, Set<(params: any, sessionId?: string) => void>>();
  private currentTargetId: string | null = null;
  private activeSessionId: string | null = null;
  private childSessions = new Map<string, CdpChildSessionInfo>();
  private inProcessFrameWorlds = new Map<string, number>();
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
    return (
      !this.permanentlyClosed &&
      this.connected &&
      this.ws !== null &&
      this.ws.readyState === WS_OPEN
    );
  }

  /** Permanently close this channel so subsequent commands reject immediately instead of auto-reconnecting. */
  markClosed(reason = "Browser context closed"): void {
    this.permanentlyClosed = true;
    this.closedReason = reason;
    this.connected = false;
    this.inProcessFrameWorlds.clear();
    this.rejectAllPending(new Error(reason));
  }

  isPermanentlyClosed(): boolean {
    return this.permanentlyClosed;
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
    if (this.permanentlyClosed) {
      throw new Error(this.closedReason);
    }
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

      const onMessage = (event: { data?: unknown; parsed?: Record<string, any> }) => {
        let parsed: Record<string, any>;
        if (event.parsed && typeof event.parsed === "object") {
          parsed = event.parsed;
        } else {
          const raw = typeof event.data === "string" ? event.data : String(event.data ?? "");
          try {
            parsed = JSON.parse(raw) as Record<string, any>;
          } catch {
            return;
          }
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
          const params = parsed["params"];
          const sessionId =
            typeof parsed["sessionId"] === "string" ? parsed["sessionId"] : undefined;
          if (method === "Page.frameNavigated" || method === "Page.frameDetached") {
            const fid =
              typeof params?.frame?.id === "string"
                ? params.frame.id
                : typeof params?.frameId === "string"
                  ? params.frameId
                  : undefined;
            if (fid) {
              this.inProcessFrameWorlds.delete(`${sessionId ?? this.activeSessionId ?? ""}:${fid}`);
              // Main frame navigation destroys all child frame worlds on this session
              if (method === "Page.frameNavigated" && !params?.frame?.parentId) {
                const prefix = `${sessionId ?? this.activeSessionId ?? ""}:`;
                for (const key of this.inProcessFrameWorlds.keys()) {
                  if (key.startsWith(prefix)) this.inProcessFrameWorlds.delete(key);
                }
              }
            }
          }
          const listeners = this.eventListeners.get(method);
          if (listeners && listeners.size > 0) {
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
    for (const cancel of Array.from(this.pendingEventCancels)) {
      cancel(error);
    }
    this.pendingEventCancels.clear();
  }

  setSessionId(sessionId: string | null): void {
    this.activeSessionId = sessionId;
    this.inProcessFrameWorlds.clear();
  }

  get sessionId(): string | null {
    return this.activeSessionId;
  }

  /** Register an attached cross-origin iframe (OOPIF) flattened CDP session. */
  addChildSession(sessionId: string, meta?: { targetId?: string; url?: string }): void {
    this.childSessions.set(sessionId, { sessionId, ...meta });
  }

  /** Update cached URL metadata for an OOPIF child session when `Target.targetInfoChanged` fires. */
  updateChildSessionByTargetId(targetId: string, meta: { url?: string }): void {
    for (const entry of this.childSessions.values()) {
      if (entry.targetId === targetId) {
        if (meta.url !== undefined) {
          entry.url = meta.url;
        }
      }
    }
  }

  removeChildSession(sessionId: string): void {
    this.childSessions.delete(sessionId);
  }

  clearChildSessions(): void {
    this.childSessions.clear();
    this.inProcessFrameWorlds.clear();
  }

  getChildSessions(): CdpChildSessionInfo[] {
    return Array.from(this.childSessions.values());
  }

  private useInjectedRuntime = false;

  enableInjectedRuntime(enabled = true): void {
    this.useInjectedRuntime = enabled;
  }

  supportsInlineTapGuard(): boolean {
    return true;
  }

  async checkTapGuard(): Promise<boolean> {
    const res = await this.evaluateFast<boolean>(
      "(window.__spanaRt&&window.__spanaRt.checkTapGuard?window.__spanaRt.checkTapGuard():(()=>{const m=!!window.__spanaTapMissed;if(window.__spanaTapGuardCleanup)window.__spanaTapGuardCleanup();delete window.__spanaTapMissed;return m;})())",
    );
    return Boolean(res);
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

  waitForEventCancellable<T = any>(
    method: string,
    timeoutMs: number = this.timeoutMs,
    predicate?: (params: T, sessionId?: string) => boolean,
  ): { promise: Promise<T>; cancel: () => void } {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let off: (() => void) | undefined;
    let abortOnClose: ((err: Error) => void) | undefined;
    let resolveFn: ((val: T) => void) | undefined;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (off) {
        off();
        off = undefined;
      }
      if (abortOnClose) {
        this.pendingEventCancels.delete(abortOnClose);
        abortOnClose = undefined;
      }
    };

    const promise = new Promise<T>((resolve, reject) => {
      resolveFn = resolve;
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`CDP event "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      abortOnClose = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      this.pendingEventCancels.add(abortOnClose);
      off = this.onEvent(method, (params: T, sessionId?: string) => {
        if (settled) return;
        if (predicate && !predicate(params, sessionId)) return;
        settled = true;
        cleanup();
        resolve(params);
      });
    });

    const cancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveFn?.(undefined as unknown as T);
    };

    return { promise, cancel };
  }

  waitForEvent<T = any>(
    method: string,
    timeoutMs: number = this.timeoutMs,
    predicate?: (params: T, sessionId?: string) => boolean,
  ): Promise<T> {
    return this.waitForEventCancellable<T>(method, timeoutMs, predicate).promise;
  }

  async sendCommand<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string | null,
    timeoutMs?: number,
  ): Promise<T> {
    if (this.permanentlyClosed) {
      throw new Error(this.closedReason);
    }
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
      if (ws.sendParsed) {
        ws.sendParsed(payload);
      } else {
        ws.send(JSON.stringify(payload));
      }
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

    const targetSid = sessionId === undefined ? this.activeSessionId : sessionId;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const remaining = Math.max(250, deadline - Date.now());
      let offDestroyed: (() => void) | undefined;
      let offCleared: (() => void) | undefined;
      let offNavigated: (() => void) | undefined;
      try {
        const evalParams: Record<string, unknown> = {
          expression,
          returnByValue: true,
          awaitPromise: true,
        };
        if (contextId !== undefined) {
          evalParams["contextId"] = contextId;
        }
        const evalPromise = this.sendCommand<{
          result?: { type?: string; value?: T; description?: string };
          exceptionDetails?: { text?: string; exception?: { description?: string } };
          wasThrown?: boolean;
        }>("Runtime.evaluate", evalParams, sessionId, remaining);

        // Cancel a hung Runtime.evaluate shortly after navigation/reload destroys its execution context (2.21),
        // while giving Chromium a short 150ms grace window so normal evaluations queued right as a navigation
        // commits resolve cleanly on the new document without spurious `executionContextsCleared` errors.
        let abortGraceTimer: ReturnType<typeof setTimeout> | undefined;
        const contextDestroyedPromise = new Promise<never>((_resolve, reject) => {
          const matchesTargetSession = (sid?: string) =>
            (sid ?? null) === (targetSid ?? null) || (!targetSid && !sid);
          const triggerAbort = (reason: string) => {
            if (abortGraceTimer !== undefined) return;
            abortGraceTimer = setTimeout(() => {
              reject(new Error(`Execution context was destroyed (${reason})`));
            }, 150);
          };
          offCleared = this.onEvent("Runtime.executionContextsCleared", (_p, sid) => {
            if (matchesTargetSession(sid)) triggerAbort("executionContextsCleared");
          });
          if (contextId !== undefined) {
            offDestroyed = this.onEvent("Runtime.executionContextDestroyed", (p, sid) => {
              if (matchesTargetSession(sid) && p?.executionContextId === contextId) {
                triggerAbort("executionContextDestroyed");
              }
            });
          } else {
            offNavigated = this.onEvent("Page.frameNavigated", (p, sid) => {
              if (matchesTargetSession(sid) && p?.frame && !p.frame.parentId) {
                triggerAbort("mainFrameNavigated");
              }
            });
          }
        });
        // Prevent unhandled rejection if evalPromise settles first
        contextDestroyedPromise.catch(() => {});

        const response = await Promise.race([evalPromise, contextDestroyedPromise]).finally(() => {
          if (abortGraceTimer !== undefined) {
            clearTimeout(abortGraceTimer);
            abortGraceTimer = undefined;
          }
        });

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
      } finally {
        offDestroyed?.();
        offCleared?.();
        offNavigated?.();
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

  /** Single-attempt evaluate with the default command timeout — used for user `app.evaluate()` so navigation aborts immediately instead of re-executing user code in the new document. */
  async evaluateOnce<T = unknown>(
    script: string | ((...args: any[]) => T),
    ...args: any[]
  ): Promise<T> {
    return this.evaluateOnSessionWithTimeout<T>(undefined, script, undefined, args, undefined, 1);
  }

  async evaluateOnSession<T = unknown>(
    sessionId: string | null | undefined,
    script: string | ((...args: any[]) => T),
    ...args: any[]
  ): Promise<T> {
    return this.evaluateOnSessionWithTimeout<T>(sessionId, script, undefined, args, undefined, 3);
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
      ? await this.frameOffsetResolver(child).catch(() => ({ x: 0, y: 0, scaleX: 1, scaleY: 1 }))
      : { x: 0, y: 0, scaleX: 1, scaleY: 1 };
    return this.applyFrameOffset(matches, offset);
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
    offset: CdpFrameTransform,
  ): DomElementMatch[] {
    const sx =
      offset.scaleX && Number.isFinite(offset.scaleX) && offset.scaleX > 0 ? offset.scaleX : 1;
    const sy =
      offset.scaleY && Number.isFinite(offset.scaleY) && offset.scaleY > 0 ? offset.scaleY : 1;
    return matches.map((m) => ({
      ...m,
      inIframe: true,
      rect: {
        ...m.rect,
        x: offset.x + m.rect.x * sx,
        y: offset.y + m.rect.y * sy,
        width: m.rect.width * sx,
        height: m.rect.height * sy,
      },
      ...(m.clickPoint
        ? {
            clickPoint: {
              x: offset.x + m.clickPoint.x * sx,
              y: offset.y + m.clickPoint.y * sy,
            },
          }
        : {}),
    }));
  }

  private async inspectMatchingIframes(
    frameSel: unknown,
    contextId?: number,
    sessionId?: string | null,
  ): Promise<
    Array<{
      frameId?: string;
      src: string;
      name: string;
      x: number;
      y: number;
      scaleX: number;
      scaleY: number;
      sameOriginAccessible: boolean;
      isSrcdoc?: boolean;
    }>
  > {
    const matcherFn = `function __matchIframes(fSel) {
      var iframes = Array.from(document.querySelectorAll("iframe"));
      var matched = [];
      for (var i = 0; i < iframes.length; i++) {
        var el = iframes[i];
        var ok = false;
        if (typeof fSel === "string") {
          if (el.getAttribute("title") === fSel || el.getAttribute("aria-label") === fSel || el.getAttribute("name") === fSel) ok = true;
          else { try { if (el.matches(fSel)) ok = true; } catch (e) {} }
        } else if (fSel && typeof fSel === "object") {
          if (fSel.css) {
            try { if (el.matches(fSel.css)) ok = true; } catch (e) {}
          } else if (fSel.testID && (el.getAttribute("data-testid") === fSel.testID || el.getAttribute("testID") === fSel.testID)) {
            ok = true;
          } else if (fSel.accessibilityLabel && (el.getAttribute("aria-label") === fSel.accessibilityLabel || el.getAttribute("title") === fSel.accessibilityLabel)) {
            ok = true;
          } else if (fSel.text && (el.getAttribute("title") === fSel.text || el.getAttribute("aria-label") === fSel.text)) {
            ok = true;
          }
        }
        if (ok) matched.push(el);
      }
      return matched;
    }`;

    const metaList = await this.evaluateOnSessionWithTimeout<
      Array<{
        src: string;
        name: string;
        x: number;
        y: number;
        scaleX: number;
        scaleY: number;
        sameOriginAccessible: boolean;
        isSrcdoc?: boolean;
      }>
    >(
      sessionId,
      `((fSel) => {
        try {
          ${matcherFn}
          return __matchIframes(fSel).map((el) => {
            var r = el.getBoundingClientRect();
            var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
            var cs = win && win.getComputedStyle ? win.getComputedStyle(el) : null;
            var bLeft = cs ? (parseFloat(cs.borderLeftWidth) || 0) : 0;
            var bTop = cs ? (parseFloat(cs.borderTopWidth) || 0) : 0;
            var bRight = cs ? (parseFloat(cs.borderRightWidth) || 0) : 0;
            var bBottom = cs ? (parseFloat(cs.borderBottomWidth) || 0) : 0;
            var layoutW = el.offsetWidth || (el.clientWidth + bLeft + bRight);
            var layoutH = el.offsetHeight || (el.clientHeight + bTop + bBottom);
            var sx = layoutW > 0 ? (r.width / layoutW) : 1;
            var sy = layoutH > 0 ? (r.height / layoutH) : 1;
            if (!isFinite(sx) || sx <= 0) sx = 1;
            if (!isFinite(sy) || sy <= 0) sy = 1;
            var accessible = false;
            var isSrcdoc = el.hasAttribute("srcdoc");
            var sandboxAttr = el.getAttribute("sandbox");
            var sandboxNoScripts = sandboxAttr !== null && !/\\ballow-scripts\\b/i.test(sandboxAttr);
            try {
              var srcAttr = el.getAttribute("src") || "";
              var crossOriginSrc = false;
              if (srcAttr && !srcAttr.startsWith("about:") && !srcAttr.startsWith("javascript:")) {
                try {
                  var parsedSrc = new URL(srcAttr, window.location.href);
                  if (parsedSrc.origin !== window.location.origin) crossOriginSrc = true;
                } catch (e2) {}
              }
              accessible = !crossOriginSrc && Boolean(el.contentDocument && el.contentDocument.documentElement);
            } catch (e) {}
            return {
              src: el.src || "",
              name: el.getAttribute("name") || "",
              x: r.left + bLeft * sx,
              y: r.top + bTop * sy,
              scaleX: sx,
              scaleY: sy,
              sameOriginAccessible: accessible,
              sandboxNoScripts: sandboxNoScripts,
              isSrcdoc: isSrcdoc
            };
          });
        } catch (e) { return []; }
      })(${JSON.stringify(frameSel)})`,
      3_000,
      [],
      contextId,
      1,
    ).catch(() => []);

    if (!Array.isArray(metaList) || metaList.length === 0) return [];

    // Resolve exact CDP frameId for each matched <iframe> via DOM.describeNode so multiple
    // iframes sharing an origin never collide (2.18d).
    const enriched: Array<{
      frameId?: string;
      src: string;
      name: string;
      x: number;
      y: number;
      scaleX: number;
      scaleY: number;
      sameOriginAccessible: boolean;
      isSrcdoc?: boolean;
    }> = [];
    for (let idx = 0; idx < metaList.length; idx++) {
      const info = metaList[idx]!;
      let frameId: string | undefined;
      try {
        const evalParams: Record<string, unknown> = {
          expression: `((fSel, idx) => { ${matcherFn} return __matchIframes(fSel)[idx] || null; })(${JSON.stringify(frameSel)}, ${idx})`,
          returnByValue: false,
        };
        if (contextId !== undefined) evalParams["contextId"] = contextId;
        const evalRes = await this.sendCommand<{ result?: { objectId?: string } }>(
          "Runtime.evaluate",
          evalParams,
          sessionId,
          2_000,
        );
        const objectId = evalRes?.result?.objectId;
        if (objectId) {
          const desc = await this.sendCommand<{
            node?: { frameId?: string; contentDocument?: { frameId?: string } };
          }>("DOM.describeNode", { objectId, depth: 1 }, sessionId, 2_000).catch(() => null);
          frameId = desc?.node?.contentDocument?.frameId ?? desc?.node?.frameId;
          void this.sendCommand("Runtime.releaseObject", { objectId }, sessionId, 1_000).catch(
            () => {},
          );
        }
      } catch {
        // Fall back to src/name matching if DOM.describeNode is unavailable
      }
      enriched.push({ ...info, ...(frameId ? { frameId } : {}) });
    }
    return enriched;
  }

  /**
   * Resolve in-process cross-origin child frames (e.g. same-site subdomains such as
   * `notes.app.localhost` embedded in `studio.app.localhost`), including nested iframes.
   * Uses `DOM.describeNode` for exact `frameId` resolution + `Page.getFrameTree` +
   * `Page.createIsolatedWorld` so multiple iframes sharing an origin never collide.
   */
  private async resolveInProcessChildFrames(
    selector: Selector,
  ): Promise<Array<{ frameId: string; url: string; offset: CdpFrameTransform }>> {
    if (!this.hasExplicitFrame(selector)) return [];
    const frameSel = (selector as { frame?: unknown }).frame;

    const treeRes = await this.sendCommand<{
      frameTree?: {
        frame?: { id: string; url?: string; name?: string };
        childFrames?: Array<any>;
      };
    }>("Page.getFrameTree").catch(() => null);
    if (!treeRes?.frameTree?.childFrames?.length) return [];

    const flatFrames: Array<{ id: string; parentId?: string; url: string; name: string }> = [];
    const walk = (nodes: Array<any> | undefined, parentId?: string) => {
      if (!Array.isArray(nodes)) return;
      for (const n of nodes) {
        if (n?.frame?.id) {
          flatFrames.push({
            id: n.frame.id,
            parentId: n.frame.parentId ?? parentId,
            url: n.frame.url ?? "",
            name: n.frame.name ?? "",
          });
        }
        if (n?.childFrames) walk(n.childFrames, n?.frame?.id);
      }
    };
    walk(treeRes.frameTree.childFrames, treeRes.frameTree.frame?.id);
    if (flatFrames.length === 0) return [];

    const matchInfoToFrame = (
      info: { frameId?: string; src: string; name: string; isSrcdoc?: boolean },
      pool: Array<{ id: string; url: string; name: string }>,
    ) => {
      if (info.frameId) {
        const exact = pool.find((f) => f.id === info.frameId);
        if (exact) return exact;
      }
      if (info.isSrcdoc) {
        const srcdocFrame = pool.find(
          (f) => f.url === "about:srcdoc" && (!info.name || f.name === info.name),
        );
        if (srcdocFrame) return srcdocFrame;
      }
      return (
        pool.find((f) => {
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
        pool.find((f) => {
          if (!info.src || !f.url) return false;
          try {
            return new URL(info.src).origin === new URL(f.url).origin;
          } catch {
            return false;
          }
        })
      );
    };

    const out: Array<{ frameId: string; url: string; offset: CdpFrameTransform }> = [];
    const topInfos = await this.inspectMatchingIframes(frameSel);
    // Same-origin accessible iframes (including `<iframe sandbox="allow-same-origin">` without
    // `allow-scripts`) are traversed directly in the parent realm via `iframe.contentDocument` —
    // never route them through `Page.createIsolatedWorld`, which Chromium blocks without `allow-scripts`.
    if (topInfos.length > 0 && topInfos.every((info) => info.sameOriginAccessible)) {
      return [];
    }
    for (const info of topInfos) {
      if (info.sameOriginAccessible) continue;
      const match = matchInfoToFrame(info, flatFrames);
      if (match && !out.some((x) => x.frameId === match.id)) {
        out.push({
          frameId: match.id,
          url: match.url,
          offset: { x: info.x, y: info.y, scaleX: info.scaleX, scaleY: info.scaleY },
        });
      }
    }

    // Support nested iframes: if not matched directly in the top document, walk child frames recursively (2.18c)
    if (out.length === 0 && topInfos.length === 0) {
      const topFrameId = treeRes.frameTree.frame?.id;
      const visited = new Set<string>();
      const searchChildrenOf = async (
        parentFrameId: string,
        parentOffset: CdpFrameTransform,
        depth: number,
      ) => {
        if (depth > 4 || visited.has(parentFrameId)) return;
        visited.add(parentFrameId);
        const directChildren = flatFrames.filter((f) => f.parentId === parentFrameId);
        if (directChildren.length === 0) return;

        // First collect offsets of direct child iframes inside parentFrameId
        const childIframeRects = await (async () => {
          if (parentFrameId === topFrameId) {
            return this.inspectMatchingIframes("iframe");
          }
          try {
            const ctxId = await this.getOrCreateFrameWorld(parentFrameId);
            return await this.inspectMatchingIframes("iframe", ctxId);
          } catch {
            return [];
          }
        })();

        const pSx = parentOffset.scaleX ?? 1;
        const pSy = parentOffset.scaleY ?? 1;

        for (const childFrame of directChildren) {
          const rectInfo = childIframeRects.find(
            (r) =>
              r.frameId === childFrame.id ||
              (r.name && childFrame.name && r.name === childFrame.name) ||
              (r.src && childFrame.url && childFrame.url.startsWith(r.src)),
          );
          const childOffset: CdpFrameTransform = {
            x: parentOffset.x + (rectInfo?.x ?? 0) * pSx,
            y: parentOffset.y + (rectInfo?.y ?? 0) * pSy,
            scaleX: pSx * (rectInfo?.scaleX ?? 1),
            scaleY: pSy * (rectInfo?.scaleY ?? 1),
          };
          try {
            const ctxId = await this.getOrCreateFrameWorld(childFrame.id);
            const nestedInfos = await this.inspectMatchingIframes(frameSel, ctxId);
            for (const nInfo of nestedInfos) {
              const grandChildren = flatFrames.filter((f) => f.parentId === childFrame.id);
              const match = matchInfoToFrame(
                nInfo,
                grandChildren.length > 0 ? grandChildren : flatFrames,
              );
              if (match && !out.some((x) => x.frameId === match.id)) {
                out.push({
                  frameId: match.id,
                  url: match.url,
                  offset: {
                    x: childOffset.x + nInfo.x * (childOffset.scaleX ?? 1),
                    y: childOffset.y + nInfo.y * (childOffset.scaleY ?? 1),
                    scaleX: (childOffset.scaleX ?? 1) * nInfo.scaleX,
                    scaleY: (childOffset.scaleY ?? 1) * nInfo.scaleY,
                  },
                });
              }
            }
          } catch {
            // child frame may be out-of-process or detached
          }
          if (out.length === 0) {
            await searchChildrenOf(childFrame.id, childOffset, depth + 1);
          }
        }
      };
      if (topFrameId) {
        await searchChildrenOf(topFrameId, { x: 0, y: 0, scaleX: 1, scaleY: 1 }, 0);
      }
    }

    return out;
  }

  private async getOrCreateFrameWorld(frameId: string, forceFresh = false): Promise<number> {
    const key = `${this.activeSessionId ?? ""}:${frameId}`;
    if (!forceFresh) {
      const cached = this.inProcessFrameWorlds.get(key);
      if (cached !== undefined) return cached;
    }
    const world = await this.sendCommand<{ executionContextId: number }>(
      "Page.createIsolatedWorld",
      {
        frameId,
        worldName: "spana-frame",
        grantUniveralAccess: false,
      },
    );
    this.inProcessFrameWorlds.set(key, world.executionContextId);
    return world.executionContextId;
  }

  private async invokeInProcessFrame<T>(
    frameId: string,
    method: InjectedRuntimeMethod,
    args: unknown[],
    fallbackScript: () => string,
    timeoutMs?: number,
  ): Promise<T> {
    const key = `${this.activeSessionId ?? ""}:${frameId}`;
    const runWithContext = async (contextId: number): Promise<T> => {
      if (!this.useInjectedRuntime) {
        return this.evaluateOnSessionWithTimeout<T>(
          undefined,
          fallbackScript(),
          timeoutMs,
          [],
          contextId,
          1,
        );
      }
      const callExpr = buildInjectedCallScript(method, ...args);
      const res = await this.evaluateOnSessionWithTimeout<
        T | typeof SPANA_RUNTIME_MISSING_SENTINEL
      >(undefined, callExpr, timeoutMs, [], contextId, 1);
      if (res !== SPANA_RUNTIME_MISSING_SENTINEL) {
        return res as T;
      }
      await this.evaluateOnSessionWithTimeout(
        undefined,
        SPANA_INJECTED_RUNTIME_SCRIPT,
        timeoutMs,
        [],
        contextId,
        1,
      );
      return this.evaluateOnSessionWithTimeout<T>(undefined, callExpr, timeoutMs, [], contextId, 1);
    };

    const contextId = await this.getOrCreateFrameWorld(frameId);
    try {
      return await runWithContext(contextId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        /Execution context was destroyed|Cannot find context with specified id|No frame for given id/i.test(
          msg,
        )
      ) {
        this.inProcessFrameWorlds.delete(key);
        const freshContextId = await this.getOrCreateFrameWorld(frameId, true);
        return runWithContext(freshContextId);
      }
      throw err;
    }
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
      if ("text" in frameSel && typeof frameSel.text === "string" && frameSel.text) {
        hints.push(frameSel.text);
      }
    }
    // Prefer exact CDP frameId matching via DOM.describeNode so multiple iframes sharing an origin never collide (2.18d)
    const inspected = await this.inspectMatchingIframes(frameSel);
    const exactFrameIds = new Set(
      inspected.map((i) => i.frameId).filter((id): id is string => Boolean(id)),
    );
    if (exactFrameIds.size > 0) {
      const byExactId = all.filter((c) => c.targetId && exactFrameIds.has(c.targetId));
      if (byExactId.length > 0) return byExactId;
    }

    const iframeSrcs = inspected.map((i) => i.src).filter(Boolean);
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
    // If the host DOM already has a matching iframe with a known frameId or non-blank src,
    // and NONE of the currently attached OOPIF sessions match it, the target OOPIF is still
    // attaching/navigating — return [] rather than returning unrelated sibling OOPIFs!
    const hasSpecificIdentity =
      exactFrameIds.size > 0 || iframeSrcs.some((src) => src && src !== "about:blank");
    if (inspected.length === 0 || hasSpecificIdentity) {
      return [];
    }
    return all;
  }

  async evaluateInFrame<T = unknown>(
    frameSelector: Selector,
    script: string | ((doc: any, win: any, ...args: any[]) => T),
    ...args: any[]
  ): Promise<T> {
    // 1. Same-origin accessible iframes (including `<iframe sandbox="allow-same-origin">`
    // without `allow-scripts`): evaluate in the parent realm bound to `(contentDocument, contentWindow)`.
    const inspected = await this.inspectMatchingIframes(frameSelector);
    if (inspected.some((i) => i.sameOriginAccessible)) {
      const parentExpr = buildDomFrameEvaluateScript(frameSelector, script, args);
      const res = await this.evaluateOnSession<{ __spanaFrameEvalOk?: boolean; value?: T }>(
        undefined,
        parentExpr,
      );
      if (res?.__spanaFrameEvalOk) {
        return res.value as T;
      }
    }

    const serializedArgs = args.map((a) => serializeEvaluateArg(a)).join(", ");
    const frameExpr =
      typeof script === "function"
        ? `(${script.toString()})(document, window${serializedArgs ? `, ${serializedArgs}` : ""})`
        : buildEvaluateExpression(script, args);

    // 2. In-process cross-origin / opaque-sandboxed child frames (with `allow-scripts`)
    const syntheticSel: Selector = { css: "*", frame: frameSelector };
    const inProcessFrames = await this.resolveInProcessChildFrames(syntheticSel);
    if (inProcessFrames.length > 0) {
      const ctxId = await this.getOrCreateFrameWorld(inProcessFrames[0]!.frameId);
      return this.evaluateOnSessionWithTimeout<T>(
        undefined,
        frameExpr,
        this.timeoutMs,
        [],
        ctxId,
        1,
      );
    }

    // 3. OOPIF child sessions
    if (this.childSessions.size > 0) {
      const candidates = await this.resolveMatchingChildSessions(syntheticSel);
      if (candidates.length > 0) {
        return this.evaluateOnSession<T>(candidates[0]!.sessionId, frameExpr);
      }
    }

    // 4. Final parent-realm attempt (e.g. iframe mounted between inspect and evaluate)
    const retryExpr = buildDomFrameEvaluateScript(frameSelector, script, args);
    const retryRes = await this.evaluateOnSession<{ __spanaFrameEvalOk?: boolean; value?: T }>(
      undefined,
      retryExpr,
    );
    if (retryRes?.__spanaFrameEvalOk) {
      return retryRes.value as T;
    }
    throw new Error(`Iframe matching ${JSON.stringify(frameSelector)} not found`);
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
        const frameRes = await this.invokeInProcessFrame<DomElementMatch[]>(
          frame.frameId,
          "query",
          [innerSel],
          childFallback,
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
        const res = await this.invokeInProcessFrame<DomElementMatch[]>(
          frame.frameId,
          "waitForSelector",
          [innerSel, opts ?? {}],
          childFallback,
          rpcTimeout,
        ).catch(() => []);
        return Array.isArray(res) && res.length > 0 ? this.applyFrameOffset(res, frame.offset) : [];
      }),
    ];

    const raceState = { done: false };
    // Poll continuously for newly mounted or process-swapped (about:blank -> OOPIF) child frames
    // without letting a transient in-process frame block discovery of an OOPIF childSession.
    if (explicitFrame) {
      const triedSessionIds = new Set(candidates.map((c) => c.sessionId));
      const triedFrameIds = new Set(inProcessFrames.map((f) => f.frameId));
      const deadline = Date.now() + (opts?.timeoutMs ?? 5000);
      racers.push(
        new Promise<DomElementMatch[]>((resolvePoller) => {
          const pollerState = { done: false };
          const finishPoller = (hits: DomElementMatch[]) => {
            if (pollerState.done) return;
            pollerState.done = true;
            resolvePoller(hits);
          };
          void (async () => {
            while (!raceState.done && !pollerState.done && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 50));
              if (raceState.done || pollerState.done) break;
              const remaining = Math.max(200, deadline - Date.now());
              const remOpts = { ...opts, timeoutMs: remaining };
              const appearedOopif =
                this.childSessions.size > 0
                  ? await this.resolveMatchingChildSessions(selector)
                  : [];
              for (const child of appearedOopif) {
                if (triedSessionIds.has(child.sessionId)) continue;
                triedSessionIds.add(child.sessionId);
                void this.invokeDom<DomElementMatch[]>(
                  child.sessionId,
                  "waitForSelector",
                  [innerSel, remOpts],
                  () => buildDomWaitForSelectorScript(innerSel, remOpts),
                  remaining + 2000,
                )
                  .then(async (res) => {
                    if (Array.isArray(res) && res.length > 0) {
                      finishPoller(await this.applyChildOffset(res, child));
                    }
                  })
                  .catch(() => {});
              }
              if (raceState.done || pollerState.done) break;
              const appearedFrames = await this.resolveInProcessChildFrames(selector);
              for (const frame of appearedFrames) {
                if (triedFrameIds.has(frame.frameId)) continue;
                triedFrameIds.add(frame.frameId);
                void this.invokeInProcessFrame<DomElementMatch[]>(
                  frame.frameId,
                  "waitForSelector",
                  [innerSel, remOpts],
                  () => buildDomWaitForSelectorScript(innerSel, remOpts),
                  remaining + 2000,
                )
                  .then((res) => {
                    if (Array.isArray(res) && res.length > 0) {
                      finishPoller(this.applyFrameOffset(res, frame.offset));
                    }
                  })
                  .catch(() => {});
              }
            }
            finishPoller([]);
          })();
        }),
      );
    }

    const finalMatches = await new Promise<DomElementMatch[]>((resolve) => {
      let remaining = racers.length;
      let resolved = false;
      for (const p of racers) {
        void p.then((matches) => {
          if (resolved) return;
          if (Array.isArray(matches) && matches.length > 0) {
            resolved = true;
            raceState.done = true;
            resolve(matches);
            return;
          }
          remaining -= 1;
          if (remaining <= 0) {
            resolved = true;
            raceState.done = true;
            resolve([]);
          }
        });
      }
    });
    if (finalMatches.length === 0 && explicitFrame) {
      const frameSel = (selector as { frame?: unknown }).frame;
      const stillMissing =
        (await this.inspectMatchingIframes(frameSel)).length === 0 &&
        (await this.resolveInProcessChildFrames(selector)).length === 0 &&
        (await this.resolveMatchingChildSessions(selector)).length === 0;
      if (stillMissing) {
        throw new Error(
          `Iframe matching ${JSON.stringify(frameSel)} not found within ${opts?.timeoutMs ?? 5000}ms`,
        );
      }
    }
    return finalMatches;
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
          await this.invokeInProcessFrame<boolean>(
            frame.frameId,
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
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const deadline = Date.now() + timeoutMs;
    const rpcTimeout = Math.max(timeoutMs + 5000, this.timeoutMs);
    const fallback = () => buildDomWaitForMatchScript(selector, opts);
    const explicitFrame = this.hasExplicitFrame(selector);
    const innerSel = this.stripFrameFromSelector(selector);
    const childFallback = (remOpts: DomWaitForMatchOptions) =>
      buildDomWaitForMatchScript(innerSel, remOpts);

    // Explicit frame handling with late-mounting frame polling & clear missing-frame diagnostic (2.18a, 2.18b)
    if (explicitFrame) {
      const frameSel = (selector as { frame?: unknown }).frame;
      let frameEverFound = false;
      let lastRes: DomWaitForMatchResult = { matched: false };

      while (true) {
        const remaining = Math.max(10, deadline - Date.now());
        const remOpts: DomWaitForMatchOptions = { ...opts, timeoutMs: remaining };
        const remRpc = Math.max(remaining + 5000, this.timeoutMs);

        // 1. Check same-origin accessible iframe on main document
        const inspected = await this.inspectMatchingIframes(frameSel);
        if (inspected.some((i) => i.sameOriginAccessible)) {
          frameEverFound = true;
          const mainRes = await this.invokeDom<DomWaitForMatchResult>(
            undefined,
            "waitForMatch",
            [selector, remOpts],
            () => buildDomWaitForMatchScript(selector, remOpts),
            remRpc,
          ).catch(() => ({ matched: false }) as DomWaitForMatchResult);
          if (mainRes?.matched) return mainRes;
          lastRes = mainRes;
          if (Date.now() >= deadline) return lastRes;
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }

        // 2. Check in-process cross-origin child frames (Page.getFrameTree + createIsolatedWorld)
        const inProcessFrames = await this.resolveInProcessChildFrames(selector);
        if (inProcessFrames.length > 0) {
          frameEverFound = true;
          for (const frame of inProcessFrames) {
            const frameRes = await this.invokeInProcessFrame<DomWaitForMatchResult>(
              frame.frameId,
              "waitForMatch",
              [innerSel, remOpts],
              () => childFallback(remOpts),
              remRpc,
            ).catch(() => ({ matched: false }) as DomWaitForMatchResult);
            if (frameRes?.matched) return frameRes;
            lastRes = frameRes;
          }
          if (Date.now() >= deadline) return lastRes;
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }

        // 3. Check attached OOPIF child sessions
        const candidates =
          this.childSessions.size > 0 ? await this.resolveMatchingChildSessions(selector) : [];
        if (candidates.length > 0) {
          frameEverFound = true;
          for (const child of candidates) {
            const childRes = await this.invokeDom<DomWaitForMatchResult>(
              child.sessionId,
              "waitForMatch",
              [innerSel, remOpts],
              () => childFallback(remOpts),
              remRpc,
            ).catch(() => ({ matched: false }) as DomWaitForMatchResult);
            if (childRes?.matched) return childRes;
            lastRes = childRes;
          }
          if (Date.now() >= deadline) return lastRes;
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }

        // Frame not mounted yet — poll until deadline
        if (Date.now() >= deadline) {
          if (!frameEverFound) {
            throw new Error(
              `Iframe matching ${JSON.stringify(frameSel)} not found within ${timeoutMs}ms`,
            );
          }
          return lastRes;
        }
        await new Promise((r) => setTimeout(r, 60));
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
          () => childFallback(opts),
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
            await this.invokeInProcessFrame<boolean>(
              frame.frameId,
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
          await this.invokeInProcessFrame<boolean>(
            frame.frameId,
            "tap",
            [innerSel],
            childFallback,
          ).catch(() => false),
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
        const frameRes = await this.invokeInProcessFrame<DomElementMatch | null>(
          frame.frameId,
          "scrollIntoView",
          [innerSel],
          childFallback,
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
    this.inProcessFrameWorlds.clear();
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
