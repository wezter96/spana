import type { Selector } from "../schemas/selector.js";
import type {
  BrowserConsoleLog,
  BrowserJSError,
  BrowserMockResponse,
  BrowserRouteMatcher,
} from "../drivers/raw-driver.js";
import type {
  DomChannel,
  DomClearStorageOptions,
  DomElementMatch,
  DomIdleOptions,
  DomStorageEntries,
} from "./dom-channel.js";
import { startMinimalWsServer, type MinimalWsServer, type WsConnection } from "./ws-server.js";

export interface SpanaBridgeServerOptions {
  host?: string;
  port?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface PendingBridgeCall {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runner-side WebSocket server that accepts connections from `spana-bridge`
 * running inside the app under test (web, Capacitor iOS/Android, Electron,
 * or Electrobun) and exposes the unified `DomChannel` interface.
 */
export class SpanaBridgeChannel implements DomChannel {
  readonly kind = "bridge" as const;

  private readonly host: string;
  private readonly requestedPort: number;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  private server: MinimalWsServer | null = null;
  private activeConn: WsConnection | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingBridgeCall>();
  private connectionWaiters: Array<{
    resolve: (conn: WsConnection) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private helloMeta: Record<string, unknown> | null = null;

  constructor(options: SpanaBridgeServerOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 9333;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  get url(): string | null {
    return this.server?.url ?? null;
  }

  get port(): number | null {
    return this.server?.port ?? null;
  }

  get clientMetadata(): Record<string, unknown> | null {
    return this.helloMeta;
  }

  isConnected(): boolean {
    return this.activeConn !== null && this.activeConn.isOpen;
  }

  /** Start listening for an incoming `spana-bridge` WebSocket connection. */
  async start(): Promise<{ host: string; port: number; url: string }> {
    if (this.server) {
      return { host: this.server.host, port: this.server.port, url: this.server.url };
    }

    const server = await startMinimalWsServer(this.host, this.requestedPort);
    this.server = server;

    server.onConnection((conn) => {
      this.activeConn = conn;
      conn.onMessage((raw) => this.handleMessage(raw));
      conn.onClose(() => {
        if (this.activeConn === conn) {
          this.activeConn = null;
          this.rejectAllPending(new Error("spana-bridge client disconnected"));
        }
      });

      while (this.connectionWaiters.length > 0) {
        const waiter = this.connectionWaiters.shift()!;
        clearTimeout(waiter.timer);
        waiter.resolve(conn);
      }
    });

    return { host: server.host, port: server.port, url: server.url };
  }

  /** Wait until a `spana-bridge` client connects (starting the server if needed). */
  async connect(): Promise<void> {
    if (!this.server) {
      await this.start();
    }
    if (this.isConnected()) return;
    await this.waitForClient(this.connectTimeoutMs);
  }

  async waitForClient(timeoutMs = this.connectTimeoutMs): Promise<WsConnection> {
    if (this.activeConn && this.activeConn.isOpen) {
      return this.activeConn;
    }
    return this.waitForNextClient(timeoutMs);
  }

  /** Wait for a brand-new bridge client connection (e.g. after a page navigation or reload). */
  async waitForNextClient(timeoutMs = this.connectTimeoutMs): Promise<WsConnection> {
    return new Promise<WsConnection>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.connectionWaiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.connectionWaiters.splice(idx, 1);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for spana-bridge client on ${this.url ?? `${this.host}:${this.requestedPort}`}`,
          ),
        );
      }, timeoutMs);
      this.connectionWaiters.push({ resolve, reject, timer });
    });
  }

  private handleMessage(raw: string): void {
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(raw) as Record<string, any>;
    } catch {
      return;
    }

    if (parsed["type"] === "hello") {
      this.helloMeta = (parsed["meta"] as Record<string, unknown>) ?? {};
      return;
    }

    const id = parsed["id"];
    if (typeof id !== "number") return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);

    if (parsed["error"]) {
      const errMsg =
        typeof parsed["error"] === "string"
          ? parsed["error"]
          : (parsed["error"].message ?? JSON.stringify(parsed["error"]));
      entry.reject(new Error(`spana-bridge error: ${errMsg}`));
    } else {
      entry.resolve(parsed["result"]);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  async call<T = any>(method: string, params?: Record<string, unknown>): Promise<T> {
    const conn =
      this.activeConn && this.activeConn.isOpen
        ? this.activeConn
        : await this.waitForClient(this.connectTimeoutMs);

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`spana-bridge "${method}" timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      conn.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
  }

  async evaluate<T = unknown>(
    script: string | ((...args: any[]) => T),
    ...args: any[]
  ): Promise<T> {
    const serializedScript = typeof script === "function" ? script.toString() : script;
    const isFunction = typeof script === "function";
    return this.call<T>("evaluate", { script: serializedScript, isFunction, args });
  }

  async query(selector: Selector): Promise<DomElementMatch[]> {
    const res = await this.call<DomElementMatch[]>("query", { selector });
    return Array.isArray(res) ? res : [];
  }

  async tapDom(selector: Selector): Promise<boolean> {
    const res = await this.call<boolean>("tap", { selector });
    return Boolean(res);
  }

  async scrollIntoView(selector: Selector): Promise<DomElementMatch | null> {
    const res = await this.call<DomElementMatch | null>("scrollIntoView", { selector });
    return res ?? null;
  }

  async dispatch(
    selector: Selector,
    eventType: string,
    eventInit?: Record<string, unknown>,
  ): Promise<boolean> {
    const res = await this.call<boolean>("dispatch", { selector, eventType, eventInit });
    return Boolean(res);
  }

  async waitForIdle(opts?: DomIdleOptions): Promise<void> {
    await this.call("idle", {
      timeout: opts?.timeout ?? 5000,
      quietPeriodMs: opts?.quietPeriodMs ?? 50,
    });
  }

  async setStorage(entries: DomStorageEntries): Promise<void> {
    await this.call("setStorage", entries as Record<string, unknown>);
  }

  async clearStorage(opts?: DomClearStorageOptions): Promise<void> {
    await this.call("clearStorage", (opts ?? {}) as Record<string, unknown>);
  }

  async reload(): Promise<void> {
    const nextConnPromise = this.waitForNextClient(this.connectTimeoutMs);
    await this.call("reload");
    await nextConnPromise;
  }

  async mockNetwork(matcher: BrowserRouteMatcher, response: BrowserMockResponse): Promise<void> {
    const serializedMatcher =
      matcher instanceof RegExp
        ? { type: "regexp", source: matcher.source, flags: matcher.flags }
        : { type: "string", pattern: matcher };
    await this.call("mockNetwork", { matcher: serializedMatcher, response });
  }

  async blockNetwork(matcher: BrowserRouteMatcher): Promise<void> {
    const serializedMatcher =
      matcher instanceof RegExp
        ? { type: "regexp", source: matcher.source, flags: matcher.flags }
        : { type: "string", pattern: matcher };
    await this.call("blockNetwork", { matcher: serializedMatcher });
  }

  async clearNetworkMocks(): Promise<void> {
    await this.call("clearNetworkMocks");
  }

  async getConsoleLogs(): Promise<BrowserConsoleLog[]> {
    const logs = await this.call<BrowserConsoleLog[]>("getConsoleLogs");
    return Array.isArray(logs) ? logs : [];
  }

  async getJSErrors(): Promise<BrowserJSError[]> {
    const errors = await this.call<BrowserJSError[]>("getJSErrors");
    return Array.isArray(errors) ? errors : [];
  }

  async disconnect(): Promise<void> {
    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("spana-bridge server stopped"));
    }
    this.connectionWaiters = [];
    this.rejectAllPending(new Error("spana-bridge server stopped"));
    this.activeConn = null;
    if (this.server) {
      await this.server.close();
      this.server = null;
    }
  }
}

export function createSpanaBridgeChannel(
  options: SpanaBridgeServerOptions = {},
): SpanaBridgeChannel {
  return new SpanaBridgeChannel(options);
}

/**
 * Composite channel that tries an ordered list of DOM channels (e.g. bridge
 * first, then WebKit Inspector or Android WebView CDP).
 */
export function createCompositeDomChannel(channels: DomChannel[]): DomChannel {
  const active = (): DomChannel | undefined => channels.find((c) => c.isConnected()) ?? channels[0];

  const ensureOneConnected = async (
    candidates = channels,
    unavailableMessage = "No DOM channel available",
  ): Promise<DomChannel> => {
    const already = candidates.find((c) => c.isConnected());
    if (already) return already;

    let lastError: unknown;
    for (const ch of candidates) {
      try {
        await ch.connect();
        return ch;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error(unavailableMessage);
  };

  return {
    get kind() {
      return active()?.kind ?? "bridge";
    },
    isConnected: () => channels.some((c) => c.isConnected()),
    connect: async () => {
      await ensureOneConnected();
    },
    disconnect: async () => {
      await Promise.allSettled(channels.map((c) => c.disconnect()));
    },
    evaluate: async (script, ...args) => {
      const ch = await ensureOneConnected();
      return ch.evaluate(script, ...args);
    },
    query: async (selector) => {
      const ch = await ensureOneConnected();
      return ch.query(selector);
    },
    tapDom: async (selector) => {
      const ch = await ensureOneConnected();
      return ch.tapDom(selector);
    },
    scrollIntoView: async (selector) => {
      const ch = await ensureOneConnected();
      if (ch.scrollIntoView) return ch.scrollIntoView(selector);
      return null;
    },
    dispatch: async (selector, eventType, eventInit) => {
      const ch = await ensureOneConnected();
      if (ch.dispatch) return ch.dispatch(selector, eventType, eventInit);
      return false;
    },
    waitForIdle: async (opts) => {
      const ch = channels.find((c) => c.isConnected() && c.waitForIdle);
      if (ch?.waitForIdle) {
        await ch.waitForIdle(opts);
      }
    },
    setStorage: async (entries) => {
      const ch = await ensureOneConnected();
      if (!ch.setStorage) throw new Error(`DOM channel "${ch.kind}" does not support setStorage()`);
      await ch.setStorage(entries);
    },
    clearStorage: async (opts) => {
      const ch = await ensureOneConnected();
      if (!ch.clearStorage)
        throw new Error(`DOM channel "${ch.kind}" does not support clearStorage()`);
      await ch.clearStorage(opts);
    },
    reload: async () => {
      const ch = await ensureOneConnected();
      if (ch.reload) {
        await ch.reload();
      } else {
        await ch.evaluate("window.location.reload()");
      }
    },
    mockNetwork: async (matcher, response) => {
      const ch = await ensureOneConnected(
        channels.filter((c) => c.mockNetwork),
        "mockNetwork() requires a WebView with spana-bridge or Android WebView debugging enabled",
      );
      await ch.mockNetwork!(matcher, response);
    },
    blockNetwork: async (matcher) => {
      const ch = await ensureOneConnected(
        channels.filter((c) => c.blockNetwork),
        "blockNetwork() requires a WebView with spana-bridge or Android WebView debugging enabled",
      );
      await ch.blockNetwork!(matcher);
    },
    clearNetworkMocks: async () => {
      await Promise.all(
        channels
          .filter((ch) => ch.isConnected() || ch.kind === "cdp")
          .map((ch) => ch.clearNetworkMocks?.()),
      );
    },
    getConsoleLogs: async () => {
      const ch = await ensureOneConnected();
      if (!ch.getConsoleLogs) return [];
      return ch.getConsoleLogs();
    },
    getJSErrors: async () => {
      const ch = await ensureOneConnected();
      if (!ch.getJSErrors) return [];
      return ch.getJSErrors();
    },
    listTargets: async () => {
      for (const ch of channels) {
        if (ch.listTargets) {
          try {
            return await ch.listTargets();
          } catch {
            // try next channel
          }
        }
      }
      return [];
    },
    selectTarget: async (targetId) => {
      for (const ch of channels) {
        if (ch.selectTarget) {
          await ch.selectTarget(targetId);
          return;
        }
      }
    },
  };
}
