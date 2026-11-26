import {
  buildDomFillScript,
  buildDomQueryScript,
  buildDomScrollIntoViewScript,
  buildDomTapScript,
  buildDomWaitForHiddenScript,
  buildDomWaitForMatchScript,
  buildDomWaitForSelectorScript,
  type DomChannel,
  type DomClearStorageOptions,
  type DomElementMatch,
  type DomFillOptions,
  type DomIdleOptions,
  type DomStorageEntries,
  type DomTargetInfo,
  type DomWaitForHiddenOptions,
  type DomWaitForMatchOptions,
  type DomWaitForMatchResult,
  type DomWaitForSelectorOptions,
} from "./dom-channel.js";
import type { Selector } from "../schemas/selector.js";

export interface BidiWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

export type BidiWebSocketFactory = (url: string) => BidiWebSocketLike;

export interface WebDriverBidiClientOptions {
  /** W3C WebDriver BiDi WebSocket URL (e.g. `ws://127.0.0.1:9222/session/<id>`). */
  webSocketUrl: string;
  /** Optional browsing context ID (auto-discovered via `browsingContext.getTree` if omitted). */
  contextId?: string;
  /** Command timeout in ms (default: 15_000). */
  commandTimeoutMs?: number;
  /** Custom WebSocket factory (for unit tests or custom transports). */
  createWebSocket?: BidiWebSocketFactory;
}

interface PendingCommand {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Unwrap a W3C WebDriver BiDi `script.RemoteValue` into a plain JavaScript value.
 */
export function deserializeBidiRemoteValue(remote: unknown): unknown {
  if (!remote || typeof remote !== "object") return remote;
  const obj = remote as Record<string, unknown>;
  const type = obj["type"];
  switch (type) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "string":
    case "boolean":
    case "number":
      return obj["value"];
    case "bigint":
      return BigInt(String(obj["value"] ?? "0"));
    case "array":
    case "set":
      return Array.isArray(obj["value"])
        ? (obj["value"] as unknown[]).map(deserializeBidiRemoteValue)
        : [];
    case "object": {
      const out: Record<string, unknown> = {};
      if (Array.isArray(obj["value"])) {
        for (const pair of obj["value"] as Array<[unknown, unknown]>) {
          if (!Array.isArray(pair) || pair.length < 2) continue;
          const k =
            typeof pair[0] === "string" ? pair[0] : String(deserializeBidiRemoteValue(pair[0]));
          out[k] = deserializeBidiRemoteValue(pair[1]);
        }
      }
      return out;
    }
    default:
      return "value" in obj ? obj["value"] : obj;
  }
}

/**
 * Lightweight W3C WebDriver BiDi JSON-RPC over WebSocket client (works with Firefox BiDi,
 * ChromeDriver BiDi, GeckoDriver, and Safari/WebKit BiDi endpoints).
 */
export class WebDriverBidiClient {
  private readonly webSocketUrl: string;
  private readonly commandTimeoutMs: number;
  private readonly createWebSocket: BidiWebSocketFactory;
  private ws: BidiWebSocketLike | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCommand>();
  private eventListeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  private activeContextId: string | undefined;

  constructor(options: WebDriverBidiClientOptions) {
    this.webSocketUrl = options.webSocketUrl;
    this.activeContextId = options.contextId;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15_000;
    this.createWebSocket =
      options.createWebSocket ?? ((url) => new WebSocket(url) as unknown as BidiWebSocketLike);
  }

  get contextId(): string | undefined {
    return this.activeContextId;
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    await new Promise<void>((resolve, reject) => {
      const ws = this.createWebSocket(this.webSocketUrl);
      this.ws = ws;
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      ws.addEventListener("open", () => done());
      ws.addEventListener("error", (ev) =>
        done(new Error(`BiDi WebSocket error: ${String(ev?.message ?? ev)}`)),
      );
      ws.addEventListener("close", () => {
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("WebDriver BiDi WebSocket closed"));
        }
        this.pending.clear();
        this.ws = null;
      });
      ws.addEventListener("message", (ev) => {
        this.handleMessage(typeof ev?.data === "string" ? ev.data : String(ev?.data ?? ""));
      });
      if (ws.readyState === 1) done();
    });

    if (!this.activeContextId) {
      const tree = await this.send("browsingContext.getTree", {}).catch(() => null);
      const contexts = (tree?.["contexts"] as Array<{ context?: string }> | undefined) ?? [];
      if (contexts[0]?.context) {
        this.activeContextId = contexts[0].context;
      }
    }
  }

  async disconnect(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("WebDriver BiDi client disconnected"));
    }
    this.pending.clear();
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (!this.ws) {
      throw new Error(`WebDriver BiDi client is not connected (attempted ${method})`);
    }
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `WebDriver BiDi command timed out (${method}) after ${this.commandTimeoutMs}ms`,
          ),
        );
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  onEvent(method: string, listener: (params: Record<string, unknown>) => void): () => void {
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

  async subscribe(events: string[], contexts?: string[]): Promise<void> {
    await this.send("session.subscribe", {
      events,
      ...(contexts ? { contexts } : {}),
    });
  }

  async navigate(
    url: string,
    wait: "none" | "interactive" | "complete" = "interactive",
  ): Promise<void> {
    const context = this.requireContextId();
    await this.send("browsingContext.navigate", { context, url, wait });
  }

  async reload(wait: "none" | "interactive" | "complete" = "interactive"): Promise<void> {
    const context = this.requireContextId();
    await this.send("browsingContext.reload", { context, wait });
  }

  async evaluate<T = unknown>(expression: string, awaitPromise = true): Promise<T> {
    const context = this.requireContextId();
    const res = await this.send("script.evaluate", {
      expression,
      target: { context },
      awaitPromise,
      resultOwnership: "none",
    });
    if (res["type"] === "exception") {
      const details = res["exceptionDetails"] as { text?: string } | undefined;
      throw new Error(`BiDi script exception: ${details?.text ?? JSON.stringify(details)}`);
    }
    return deserializeBidiRemoteValue(res["result"]) as T;
  }

  async captureScreenshot(): Promise<Uint8Array> {
    const context = this.requireContextId();
    const res = await this.send("browsingContext.captureScreenshot", { context });
    return new Uint8Array(Buffer.from(String(res["data"] ?? ""), "base64"));
  }

  private requireContextId(): string {
    if (!this.activeContextId) {
      throw new Error("No active WebDriver BiDi browsing context.");
    }
    return this.activeContextId;
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof msg["id"] === "number") {
      const pending = this.pending.get(msg["id"]);
      if (!pending) return;
      this.pending.delete(msg["id"]);
      clearTimeout(pending.timer);
      if (msg["type"] === "error") {
        pending.reject(
          new Error(
            `WebDriver BiDi error (${String(msg["error"] ?? "unknown")}): ${String(msg["message"] ?? "")}`,
          ),
        );
      } else {
        pending.resolve((msg["result"] as Record<string, unknown>) ?? {});
      }
      return;
    }

    if (msg["type"] === "event" && typeof msg["method"] === "string") {
      const listeners = this.eventListeners.get(msg["method"]);
      if (listeners) {
        const params = (msg["params"] as Record<string, unknown>) ?? {};
        for (const fn of listeners) {
          try {
            fn(params);
          } catch {
            // isolate event listener errors
          }
        }
      }
    }
  }
}

/**
 * Spana `DomChannel` adapter backed by W3C WebDriver BiDi (`script.evaluate`,
 * `browsingContext.reload`, `browsingContext.navigate`), enabling direct zero-Playwright
 * DOM queries, actionability waits, and storage injection on Firefox and BiDi browsers.
 */
export class BidiDomChannel implements DomChannel {
  readonly kind = "bidi" as const;
  readonly client: WebDriverBidiClient;

  constructor(options: WebDriverBidiClientOptions) {
    this.client = new WebDriverBidiClient(options);
  }

  isConnected(): boolean {
    return this.client.isConnected();
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  async getTargetInfo(): Promise<DomTargetInfo> {
    const info = await this.client.evaluate<{ url?: string; title?: string }>(
      "({ url: window.location.href, title: document.title })",
      false,
    );
    return {
      id: this.client.contextId ?? "bidi-context",
      url: info?.url,
      title: info?.title,
      type: "page",
    };
  }

  async query(selector: Selector): Promise<DomElementMatch[]> {
    const res = await this.client.evaluate<DomElementMatch[]>(buildDomQueryScript(selector), false);
    return Array.isArray(res) ? res : [];
  }

  async evaluate<T = unknown>(
    script: string | ((...args: any[]) => T),
    ...args: any[]
  ): Promise<T> {
    if (typeof script === "string") {
      return this.client.evaluate<T>(script, true);
    }
    const serializedArgs = args.map((a) => JSON.stringify(a)).join(", ");
    return this.client.evaluate<T>(`(${script.toString()})(${serializedArgs})`, true);
  }

  async waitForIdle(options?: DomIdleOptions): Promise<void> {
    const quietMs = 150;
    const timeoutMs = Math.max(50, options?.timeout ?? 5000);
    await this.client.evaluate(
      `new Promise((resolve) => {
        const deadline = setTimeout(resolve, ${timeoutMs});
        requestAnimationFrame(() => setTimeout(() => { clearTimeout(deadline); resolve(undefined); }, ${quietMs}));
      })`,
      true,
    );
  }

  async scrollIntoView(selector: Selector): Promise<DomElementMatch | null> {
    return this.client.evaluate<DomElementMatch | null>(
      buildDomScrollIntoViewScript(selector),
      false,
    );
  }

  async tapDom(selector: Selector): Promise<boolean> {
    return Boolean(await this.client.evaluate<boolean>(buildDomTapScript(selector), false));
  }

  async fillDom(selector: Selector, value: string, options?: DomFillOptions): Promise<boolean> {
    return Boolean(
      await this.client.evaluate<boolean>(buildDomFillScript(selector, value, options), true),
    );
  }

  async waitForSelector(
    selector: Selector,
    options?: DomWaitForSelectorOptions,
  ): Promise<DomElementMatch[]> {
    const res = await this.client.evaluate<DomElementMatch[]>(
      buildDomWaitForSelectorScript(selector, options),
      true,
    );
    return Array.isArray(res) ? res : [];
  }

  async waitForHidden(selector: Selector, options?: DomWaitForHiddenOptions): Promise<boolean> {
    return Boolean(
      await this.client.evaluate<boolean>(buildDomWaitForHiddenScript(selector, options), true),
    );
  }

  async waitForMatch(
    selector: Selector,
    options: DomWaitForMatchOptions,
  ): Promise<DomWaitForMatchResult> {
    return this.client.evaluate<DomWaitForMatchResult>(
      buildDomWaitForMatchScript(selector, options),
      true,
    );
  }

  async setStorage(entries: DomStorageEntries): Promise<void> {
    const serialized = JSON.stringify(entries);
    await this.client.evaluate(
      `((payload) => {
        if (payload.localStorage) {
          for (const [k, v] of Object.entries(payload.localStorage)) window.localStorage.setItem(k, String(v));
        }
        if (payload.sessionStorage) {
          for (const [k, v] of Object.entries(payload.sessionStorage)) window.sessionStorage.setItem(k, String(v));
        }
        if (payload.cookies) {
          for (const c of payload.cookies) {
            document.cookie = encodeURIComponent(c.name) + "=" + encodeURIComponent(c.value) + "; path=" + (c.path || "/");
          }
        }
      })(${serialized})`,
      false,
    );
  }

  async clearStorage(options?: DomClearStorageOptions): Promise<void> {
    const serialized = JSON.stringify(options ?? {});
    await this.client.evaluate(
      `((opts) => {
        if (opts.localStorage !== false) { try { window.localStorage.clear(); } catch {} }
        if (opts.sessionStorage !== false) { try { window.sessionStorage.clear(); } catch {} }
      })(${serialized})`,
      false,
    );
  }

  async reload(): Promise<void> {
    await this.client.reload("interactive");
  }
}

export function createBidiDomChannel(options: WebDriverBidiClientOptions): BidiDomChannel {
  return new BidiDomChannel(options);
}
