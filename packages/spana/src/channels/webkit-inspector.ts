import { execSync, spawn, type ChildProcess } from "node:child_process";
import type { Selector } from "../schemas/selector.js";
import type { MinimalWebSocket, WebSocketFactory } from "./cdp-client.js";
import {
  buildDomQueryScript,
  buildDomScrollIntoViewScript,
  buildDomTapScript,
  buildEvaluateExpression,
  type DomChannel,
  type DomElementMatch,
  type DomTargetInfo,
} from "./dom-channel.js";
import { AppleWebInspectorClient, findSimulatorWebInspectorSocket } from "./apple-webinspector.js";

export interface WebKitInspectorTarget {
  id: string;
  title?: string;
  url?: string;
  type?: string;
  webSocketDebuggerUrl?: string;
  appId?: string;
}

export interface WebKitInspectorOptions {
  /** Base HTTP URL of the WebKit inspector proxy (e.g. `http://127.0.0.1:9221` or `27753`) */
  endpointUrl?: string;
  /** Port for ios-webkit-debug-proxy / simulator webinspectord bridge (default: 9221) */
  port?: number;
  /** Direct WebSocket URL (skips `/json` target listing) */
  webSocketUrl?: string;
  /** Target device / simulator UDID (used when auto-starting ios_webkit_debug_proxy) */
  udid?: string;
  /** Optional bundleId / URL filter to pick the right WKWebView page */
  bundleId?: string;
  /** Automatically spawn `ios_webkit_debug_proxy` if installed and endpoint isn't up */
  autoStartProxy?: boolean;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  createWebSocket?: WebSocketFactory;
}

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const WS_OPEN = 1;

function defaultWebSocketFactory(url: string): MinimalWebSocket {
  return new WebSocket(url) as unknown as MinimalWebSocket;
}

/**
 * Parse target listings returned by `ios_webkit_debug_proxy` (`/json`) or a
 * simulator `webinspectord` bridge.
 */
export function parseWebKitTargetListing(payload: unknown): WebKitInspectorTarget[] {
  if (!Array.isArray(payload)) return [];
  const results: WebKitInspectorTarget[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = String(obj["id"] ?? obj["pageId"] ?? obj["devtoolsFrontendUrl"] ?? "");
    const wsUrl =
      typeof obj["webSocketDebuggerUrl"] === "string"
        ? obj["webSocketDebuggerUrl"]
        : typeof obj["wsUrl"] === "string"
          ? obj["wsUrl"]
          : undefined;
    if (!id && !wsUrl) continue;
    results.push({
      id: id || wsUrl!,
      title: typeof obj["title"] === "string" ? obj["title"] : undefined,
      url: typeof obj["url"] === "string" ? obj["url"] : undefined,
      type: typeof obj["type"] === "string" ? obj["type"] : "page",
      webSocketDebuggerUrl: wsUrl,
      appId: typeof obj["appId"] === "string" ? obj["appId"] : undefined,
    });
  }
  return results;
}

export function selectWebKitTarget(
  targets: WebKitInspectorTarget[],
  bundleId?: string,
): WebKitInspectorTarget | undefined {
  const attachable = targets.filter((t) => Boolean(t.webSocketDebuggerUrl));
  if (attachable.length === 0) return undefined;

  if (bundleId) {
    const byBundle = attachable.find(
      (t) =>
        t.appId === bundleId ||
        (t.url ?? "").includes(bundleId) ||
        (t.title ?? "").includes(bundleId),
    );
    if (byBundle) return byBundle;
  }

  // Prefer Capacitor / http(s) / localhost pages over about:blank
  const nonBlank = attachable.find(
    (t) => t.url && t.url !== "about:blank" && !t.url.startsWith("webkit-"),
  );
  return nonBlank ?? attachable[0];
}

/**
 * Check whether `ios_webkit_debug_proxy` is available on PATH.
 */
export function isWebKitDebugProxyInstalled(): boolean {
  try {
    execSync("which ios_webkit_debug_proxy", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Direct WebKit Remote Inspector channel for iOS `WKWebView` (iOS 16.4+
 * `webView.isInspectable = true`) and macOS WKWebView — without Appium.
 *
 * Talks WebKit Inspector JSON-RPC (`Runtime.evaluate` with `returnByValue`)
 * over WebSocket via `ios_webkit_debug_proxy` or a simulator `webinspectord`
 * endpoint.
 */
export class WebKitInspectorChannel implements DomChannel {
  readonly kind = "webkit-inspector" as const;

  private readonly endpointUrl: string;
  private readonly explicitWsUrl?: string;
  private readonly udid?: string;
  private readonly bundleId?: string;
  private readonly port: number;
  private readonly autoStartProxy: boolean;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly createWebSocket: WebSocketFactory;

  private ws: MinimalWebSocket | null = null;
  private nativeInspector: AppleWebInspectorClient | null = null;
  private proxyProcess: ChildProcess | null = null;
  private connected = false;
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private currentTargetId: string | null = null;

  constructor(options: WebKitInspectorOptions = {}) {
    this.port = options.port ?? 9221;
    this.endpointUrl = (options.endpointUrl ?? `http://127.0.0.1:${this.port}`).replace(/\/+$/, "");
    this.explicitWsUrl = options.webSocketUrl;
    this.udid = options.udid;
    this.bundleId = options.bundleId;
    this.autoStartProxy = options.autoStartProxy ?? false;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.createWebSocket = options.createWebSocket ?? defaultWebSocketFactory;
  }

  isConnected(): boolean {
    return (
      (this.connected && this.ws !== null && this.ws.readyState === WS_OPEN) ||
      (this.nativeInspector?.isConnected() ?? false)
    );
  }

  private async ensureProxyIfNeeded(): Promise<void> {
    if (!this.autoStartProxy || this.proxyProcess || !this.udid) return;
    if (!isWebKitDebugProxyInstalled()) return;

    // Probe first — maybe a proxy is already running on this port
    try {
      const probe = await this.fetchFn(`${this.endpointUrl}/json`);
      if (probe.ok) return;
    } catch {
      // Not listening yet — spawn ios_webkit_debug_proxy
    }

    const proc = spawn("ios_webkit_debug_proxy", ["-c", `${this.udid}:${this.port}`, "-d"], {
      stdio: "ignore",
      detached: true,
    });
    proc.unref();
    this.proxyProcess = proc;

    // Wait briefly for proxy to bind
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        const res = await this.fetchFn(`${this.endpointUrl}/json`);
        if (res.ok) return;
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  private async fetchTargets(): Promise<WebKitInspectorTarget[]> {
    for (const path of ["/json", "/json/list"]) {
      try {
        const res = await this.fetchFn(`${this.endpointUrl}${path}`);
        if (!res.ok) continue;
        const data = (await res.json()) as unknown;
        const parsed = parseWebKitTargetListing(data);
        if (parsed.length > 0 || Array.isArray(data)) {
          return parsed;
        }
      } catch {
        // try next endpoint
      }
    }
    throw new Error(
      `WebKit Inspector unreachable at ${this.endpointUrl}. ` +
        `Ensure WKWebView.isInspectable = true (iOS 16.4+) and start ios_webkit_debug_proxy ` +
        `(or use spana-bridge for zero-protocol DOM access).`,
    );
  }

  async listTargets(): Promise<DomTargetInfo[]> {
    await this.ensureProxyIfNeeded();
    const targets = await this.fetchTargets();
    return targets.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      type: t.type,
    }));
  }

  async selectTarget(targetId: string): Promise<void> {
    const targets = await this.fetchTargets();
    const match = targets.find((t) => t.id === targetId && t.webSocketDebuggerUrl);
    if (!match?.webSocketDebuggerUrl) {
      throw new Error(`WebKit Inspector: target "${targetId}" not found`);
    }
    await this.disconnectSocketOnly();
    this.currentTargetId = match.id;
    await this.openSocket(match.webSocketDebuggerUrl);
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;

    let wsUrl = this.explicitWsUrl;
    if (!wsUrl) {
      await this.ensureProxyIfNeeded();
      try {
        const targets = await this.fetchTargets();
        const chosen = selectWebKitTarget(targets, this.bundleId);
        if (!chosen?.webSocketDebuggerUrl) {
          throw new Error(
            `WebKit Inspector: no inspectable WKWebView page found at ${this.endpointUrl}. ` +
              `Verify webView.isInspectable = true on iOS 16.4+.`,
          );
        }
        this.currentTargetId = chosen.id;
        wsUrl = chosen.webSocketDebuggerUrl;
      } catch (proxyErr) {
        // Zero-dependency fallback: connect directly to Apple's simulator
        // `com.apple.webinspector` Unix socket when ios_webkit_debug_proxy is absent.
        const nativeSock = findSimulatorWebInspectorSocket(this.udid);
        if (!nativeSock) {
          throw proxyErr;
        }
        this.nativeInspector = new AppleWebInspectorClient({
          socketPath: nativeSock,
          bundleId: this.bundleId,
          timeoutMs: this.timeoutMs,
        });
        await this.nativeInspector.connect();
        await this.nativeInspector.ensurePageAttached();
        return;
      }
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
          new Error(`WebKit Inspector connection to ${wsUrl} timed out after ${this.timeoutMs}ms`),
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
          `WebKit Inspector WebSocket error: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      };

      const onClose = () => {
        this.connected = false;
        this.rejectAllPending(new Error("WebKit Inspector WebSocket closed"));
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
            entry.reject(new Error(`WebKit Inspector error: ${msg}`));
          } else {
            entry.resolve(parsed["result"]);
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
    });
  }

  private rejectAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  async sendCommand<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.isConnected()) {
      await this.connect();
    }
    if (this.nativeInspector?.isConnected()) {
      return this.nativeInspector.sendInspectorCommand<T>(method, params);
    }
    const ws = this.ws!;
    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`WebKit Inspector command "${method}" timed out after ${this.timeoutMs}ms`),
        );
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T = unknown>(
    script: string | ((...args: any[]) => T),
    ...args: any[]
  ): Promise<T> {
    const expression = buildEvaluateExpression(script, args);
    // WebKit Inspector Runtime.evaluate supports returnByValue and awaitPromise (on modern WebKit)
    const response = await this.sendCommand<{
      result?: { type?: string; value?: T; description?: string };
      wasThrown?: boolean;
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      includeCommandLineAPI: false,
    });

    if (response?.wasThrown) {
      throw new Error(
        `WebKit Inspector evaluate failed: ${response.result?.description ?? "Evaluation threw"}`,
      );
    }
    if (response?.exceptionDetails) {
      const detail =
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "Evaluation threw";
      throw new Error(`WebKit Inspector evaluate failed: ${detail}`);
    }

    return response?.result?.value as T;
  }

  async query(selector: Selector): Promise<DomElementMatch[]> {
    const result = await this.evaluate<DomElementMatch[]>(buildDomQueryScript(selector));
    return Array.isArray(result) ? result : [];
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

  private async disconnectSocketOnly(): Promise<void> {
    this.connected = false;
    this.rejectAllPending(new Error("WebKit Inspector disconnected"));
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    if (this.nativeInspector) {
      await this.nativeInspector.disconnect();
      this.nativeInspector = null;
    }
  }

  async disconnect(): Promise<void> {
    await this.disconnectSocketOnly();
    if (this.proxyProcess) {
      try {
        this.proxyProcess.kill();
      } catch {
        // already exited
      }
      this.proxyProcess = null;
    }
  }

  get targetId(): string | null {
    return this.currentTargetId;
  }
}

export function createWebKitInspectorChannel(
  options: WebKitInspectorOptions = {},
): WebKitInspectorChannel {
  return new WebKitInspectorChannel(options);
}
