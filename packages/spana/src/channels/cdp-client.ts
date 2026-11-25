import type { Selector } from "../schemas/selector.js";
import {
  buildDomQueryScript,
  buildDomScrollIntoViewScript,
  buildDomTapScript,
  buildDomWaitForHiddenScript,
  buildDomWaitForMatchScript,
  buildDomWaitForSelectorScript,
  buildEvaluateExpression,
  type DomChannel,
  type DomElementMatch,
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

  async evaluate<T = unknown>(
    script: string | ((...args: any[]) => T),
    ...args: any[]
  ): Promise<T> {
    const expression = buildEvaluateExpression(script, args);
    const response = await this.sendCommand<{
      result?: { type?: string; value?: T; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
      wasThrown?: boolean;
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
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
  }

  async query(selector: Selector): Promise<DomElementMatch[]> {
    const result = await this.evaluate<DomElementMatch[]>(buildDomQueryScript(selector));
    return Array.isArray(result) ? result : [];
  }

  async waitForSelector(
    selector: Selector,
    opts?: DomWaitForSelectorOptions,
  ): Promise<DomElementMatch[]> {
    const result = await this.evaluate<DomElementMatch[]>(
      buildDomWaitForSelectorScript(selector, opts),
    );
    return Array.isArray(result) ? result : [];
  }

  async waitForHidden(selector: Selector, opts?: DomWaitForHiddenOptions): Promise<boolean> {
    const result = await this.evaluate<boolean>(buildDomWaitForHiddenScript(selector, opts));
    return Boolean(result);
  }

  async waitForMatch(
    selector: Selector,
    opts: DomWaitForMatchOptions,
  ): Promise<DomWaitForMatchResult> {
    const result = await this.evaluate<DomWaitForMatchResult>(
      buildDomWaitForMatchScript(selector, opts),
    );
    return result && typeof result === "object" ? result : { matched: false };
  }

  async tapDom(selector: Selector): Promise<boolean> {
    const result = await this.evaluate<boolean>(buildDomTapScript(selector));
    return Boolean(result);
  }

  async scrollIntoView(selector: Selector): Promise<DomElementMatch | null> {
    const result = await this.evaluate<DomElementMatch | null>(
      buildDomScrollIntoViewScript(selector),
    );
    return result ?? null;
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
