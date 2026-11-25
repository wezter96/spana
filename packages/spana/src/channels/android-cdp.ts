import { execFileSync } from "node:child_process";
import { allocatePort, releasePort } from "../core/port-allocator.js";
import { findADB, adbShell } from "../device/android.js";
import type { Selector } from "../schemas/selector.js";
import type { BrowserMockResponse, BrowserRouteMatcher } from "../drivers/raw-driver.js";
import { CdpDomChannel, type WebSocketFactory } from "./cdp-client.js";
import type { DomChannel, DomElementMatch, DomTargetInfo } from "./dom-channel.js";

export interface AndroidWebViewSocket {
  socketName: string; // e.g. "webview_devtools_remote_12345"
  pid?: number;
}

export interface AndroidWebViewCdpOptions {
  serial: string;
  packageName?: string;
  /** Optional explicit local TCP port to forward to */
  localPort?: number;
  /** Optional explicit abstract socket name (skips /proc/net/unix discovery) */
  socketName?: string;
  timeoutMs?: number;
  /** Injectable command runner for tests */
  runAdb?: (args: string) => string;
  fetchFn?: typeof fetch;
  createWebSocket?: WebSocketFactory;
}

/**
 * Parse `/proc/net/unix` output from an Android device and extract all
 * `webview_devtools_remote_*` abstract Unix domain sockets.
 */
export function parseAndroidWebViewSockets(procNetUnixOutput: string): AndroidWebViewSocket[] {
  const seen = new Set<string>();
  const sockets: AndroidWebViewSocket[] = [];

  for (const line of procNetUnixOutput.split("\n")) {
    const match = line.match(/@(webview_devtools_remote(?:_(\d+))?|chrome_devtools_remote)\b/);
    if (!match) continue;
    const socketName = match[1]!;
    if (seen.has(socketName)) continue;
    seen.add(socketName);
    const pid = match[2] ? Number.parseInt(match[2], 10) : undefined;
    sockets.push({ socketName, pid });
  }

  return sockets;
}

/**
 * Select the best WebView DevTools socket for a given package PID list.
 */
export function selectAndroidWebViewSocket(
  sockets: AndroidWebViewSocket[],
  packagePids: number[] = [],
): AndroidWebViewSocket | undefined {
  if (sockets.length === 0) return undefined;
  if (packagePids.length > 0) {
    const pidSet = new Set(packagePids);
    const exact = sockets.find((s) => s.pid !== undefined && pidSet.has(s.pid));
    if (exact) return exact;
  }
  return sockets.find((s) => s.socketName.startsWith("webview_devtools_remote")) ?? sockets[0];
}

export function discoverAndroidWebViewSockets(
  serial: string,
  runAdb?: (args: string) => string,
): AndroidWebViewSocket[] {
  const output = runAdb
    ? runAdb(`-s ${serial} shell cat /proc/net/unix`)
    : adbShell(serial, "cat /proc/net/unix");
  return parseAndroidWebViewSockets(output);
}

export function resolveAndroidPackagePids(
  serial: string,
  packageName: string,
  runAdb?: (args: string) => string,
): number[] {
  if (!packageName) return [];
  try {
    const output = runAdb
      ? runAdb(`-s ${serial} shell pidof ${packageName}`)
      : adbShell(serial, `pidof ${packageName}`);
    return output
      .trim()
      .split(/\s+/)
      .map((token) => Number.parseInt(token, 10))
      .filter((pid) => Number.isFinite(pid));
  } catch {
    return [];
  }
}

/**
 * Direct Android System WebView CDP channel without Appium.
 *
 * Requires `WebView.setWebContentsDebuggingEnabled(true)` (Capacitor's
 * `webContentsDebuggingEnabled: true`). Discovers `webview_devtools_remote_<pid>`,
 * forwards it via `adb forward tcp:<port> localabstract:<socket>`, and speaks
 * CDP directly over WebSocket.
 */
export class AndroidWebViewCdpChannel implements DomChannel {
  readonly kind = "cdp" as const;

  private readonly options: AndroidWebViewCdpOptions;
  private forwardedPort: number | null = null;
  private allocatedByUs = false;
  private activeSocketName: string | null = null;
  private cdp: CdpDomChannel | null = null;
  private readonly routes: Array<{
    matches: (url: string) => boolean;
    response?: {
      responseCode: number;
      responseHeaders: Array<{ name: string; value: string }>;
      body: string;
    };
  }> = [];
  private enableInterception?: Promise<unknown>;

  constructor(options: AndroidWebViewCdpOptions) {
    this.options = options;
  }

  private execAdb(args: string[]): string {
    if (this.options.runAdb) {
      return this.options.runAdb(args.join(" "));
    }
    const adb = findADB();
    if (!adb) {
      throw new Error("adb not found on PATH or ANDROID_HOME");
    }
    return execFileSync(adb, args, { encoding: "utf-8" });
  }

  isConnected(): boolean {
    return this.cdp?.isConnected() ?? false;
  }

  get socketName(): string | null {
    return this.activeSocketName;
  }

  get localPort(): number | null {
    return this.forwardedPort;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;

    let socketName = this.options.socketName;
    if (!socketName) {
      const sockets = discoverAndroidWebViewSockets(this.options.serial, this.options.runAdb);
      const pids = this.options.packageName
        ? resolveAndroidPackagePids(
            this.options.serial,
            this.options.packageName,
            this.options.runAdb,
          )
        : [];
      const chosen = selectAndroidWebViewSocket(sockets, pids);
      if (!chosen) {
        throw new Error(
          `No debuggable Android WebView socket found on ${this.options.serial}. ` +
            `Enable WebView.setWebContentsDebuggingEnabled(true) (Capacitor: webContentsDebuggingEnabled: true) ` +
            `or use spana-bridge.`,
        );
      }
      socketName = chosen.socketName;
    }

    const port = this.options.localPort ?? allocatePort(9222);
    this.allocatedByUs = this.options.localPort === undefined;
    this.forwardedPort = port;
    this.activeSocketName = socketName;

    try {
      this.execAdb([
        "-s",
        this.options.serial,
        "forward",
        `tcp:${port}`,
        `localabstract:${socketName}`,
      ]);
      this.cdp = new CdpDomChannel({
        endpointUrl: `http://127.0.0.1:${port}`,
        timeoutMs: this.options.timeoutMs,
        fetchFn: this.options.fetchFn,
        createWebSocket: this.options.createWebSocket,
      });
      const cdp = this.cdp;
      cdp.onEvent("Fetch.requestPaused", (params, sessionId) => {
        const requestId = params?.requestId;
        if (typeof requestId !== "string") return;
        const route = this.routes.findLast((candidate) =>
          candidate.matches(String(params?.request?.url ?? "")),
        );
        const resume = () => cdp.sendCommand("Fetch.continueRequest", { requestId }, sessionId);
        const operation = route
          ? route.response
            ? cdp.sendCommand("Fetch.fulfillRequest", { requestId, ...route.response }, sessionId)
            : cdp.sendCommand(
                "Fetch.failRequest",
                { requestId, errorReason: "BlockedByClient" },
                sessionId,
              )
          : resume();
        void operation.catch(() => (route ? resume().catch(() => {}) : undefined));
      });
      await this.cdp.connect();
      if (this.routes.length) await this.ensureInterception();
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async evaluate<T = unknown>(
    script: string | ((...args: any[]) => T),
    ...args: any[]
  ): Promise<T> {
    if (!this.isConnected()) {
      await this.connect();
    }
    return this.cdp!.evaluate<T>(script, ...args);
  }

  async query(selector: Selector): Promise<DomElementMatch[]> {
    if (!this.isConnected()) {
      await this.connect();
    }
    return this.cdp!.query(selector);
  }

  async tapDom(selector: Selector): Promise<boolean> {
    if (!this.isConnected()) {
      await this.connect();
    }
    return this.cdp!.tapDom(selector);
  }

  async scrollIntoView(selector: Selector): Promise<DomElementMatch | null> {
    if (!this.isConnected()) {
      await this.connect();
    }
    return this.cdp!.scrollIntoView(selector);
  }

  async listTargets(): Promise<DomTargetInfo[]> {
    if (!this.cdp) {
      await this.connect();
    }
    return this.cdp!.listTargets();
  }

  async selectTarget(targetId: string): Promise<void> {
    if (!this.cdp) {
      await this.connect();
    }
    await this.cdp!.selectTarget(targetId);
    this.enableInterception = undefined;
    if (this.routes.length) await this.ensureInterception();
  }

  private async ensureInterception(): Promise<void> {
    this.enableInterception ??= this.cdp!.sendCommand("Fetch.enable", {
      patterns: [{ urlPattern: "*" }],
    });
    try {
      await this.enableInterception;
    } catch (error) {
      this.enableInterception = undefined;
      throw error;
    }
  }

  private async addRoute(
    matcher: BrowserRouteMatcher,
    response?: AndroidWebViewCdpChannel["routes"][number]["response"],
  ): Promise<void> {
    if (!this.isConnected()) await this.connect();
    await this.ensureInterception();
    const regex =
      typeof matcher === "string"
        ? matcher.includes("*")
          ? new RegExp(
              matcher
                .split(/(\*\*|\*)/)
                .map((part) =>
                  part === "**"
                    ? ".*"
                    : part === "*"
                      ? "[^/]*"
                      : part.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&"),
                )
                .join(""),
            )
          : undefined
        : new RegExp(matcher.source, matcher.flags.replaceAll(/[gy]/g, ""));
    this.routes.push({
      matches: regex ? (url) => regex.test(url) : (url) => url.includes(matcher as string),
      response,
    });
  }

  async mockNetwork(matcher: BrowserRouteMatcher, response: BrowserMockResponse): Promise<void> {
    if (response.body !== undefined && response.json !== undefined) {
      throw new Error("mockNetwork() response cannot include both body and json.");
    }
    const headers = { ...response.headers };
    const type =
      response.contentType ?? (response.json === undefined ? undefined : "application/json");
    if (type && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      headers["content-type"] = type;
    }
    await this.addRoute(matcher, {
      responseCode: response.status ?? 200,
      responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
      body: Buffer.from(
        response.json !== undefined ? JSON.stringify(response.json) : (response.body ?? ""),
      ).toString("base64"),
    });
  }

  async blockNetwork(matcher: BrowserRouteMatcher): Promise<void> {
    await this.addRoute(matcher);
  }

  async clearNetworkMocks(): Promise<void> {
    this.routes.length = 0;
    if (this.enableInterception && this.isConnected()) {
      await this.enableInterception;
      await this.cdp!.sendCommand("Fetch.disable");
      this.enableInterception = undefined;
    }
  }

  async reload(): Promise<void> {
    if (!this.isConnected()) {
      await this.connect();
    }
    await this.cdp!.reload();
  }

  async disconnect(): Promise<void> {
    this.enableInterception = undefined;
    if (this.cdp) {
      await this.cdp.disconnect();
      this.cdp = null;
    }
    if (this.forwardedPort !== null) {
      const port = this.forwardedPort;
      this.forwardedPort = null;
      try {
        this.execAdb(["-s", this.options.serial, "forward", "--remove", `tcp:${port}`]);
      } catch {
        // best-effort forward cleanup
      }
      if (this.allocatedByUs) {
        releasePort(port);
        this.allocatedByUs = false;
      }
    }
    this.activeSocketName = null;
  }
}

export function createAndroidWebViewCdpChannel(
  options: AndroidWebViewCdpOptions,
): AndroidWebViewCdpChannel {
  return new AndroidWebViewCdpChannel(options);
}
