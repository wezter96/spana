import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

/**
 * Zero-dependency Apple WebInspector RPC framing over Unix domain sockets
 * (iOS Simulator `com.apple.webinspector` / CoreSimulator tmp sockets).
 *
 * Apple's `webinspectord` exchanges length-prefixed XML/binary plist envelopes:
 *   - 4-byte big-endian uint32 byte length
 *   - XML plist payload containing `__selector` + `__argument` dictionary
 *
 * This lets Spana evaluate JS and query WKWebView DOMs on iOS Simulators even
 * when `ios_webkit_debug_proxy` is not installed.
 */

export interface WebInspectorListingPage {
  appId: string;
  pageId: number;
  title?: string;
  url?: string;
  type?: string;
}

export interface WebInspectorRpcMessage {
  selector: string;
  args: Record<string, unknown>;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function encodePlistValue(value: unknown): string {
  if (typeof value === "string") {
    return `<string>${escapeXml(value)}</string>`;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? `<integer>${value}</integer>` : `<real>${value}</real>`;
  }
  if (typeof value === "boolean") {
    return value ? "<true/>" : "<false/>";
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `<data>${Buffer.from(value).toString("base64")}</data>`;
  }
  if (Array.isArray(value)) {
    return `<array>${value.map(encodePlistValue).join("")}</array>`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `<key>${escapeXml(k)}</key>${encodePlistValue(v)}`)
      .join("");
    return `<dict>${entries}</dict>`;
  }
  return "<string></string>";
}

/** Encode an Apple WebInspector RPC message into a 4-byte length-prefixed XML plist frame. */
export function encodeWebInspectorPacket(selector: string, args: Record<string, unknown>): Buffer {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "<key>__selector</key>",
    `<string>${escapeXml(selector)}</string>`,
    "<key>__argument</key>",
    encodePlistValue(args),
    "</dict>",
    "</plist>",
  ].join("");

  const payload = Buffer.from(xml, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * Decode complete 4-byte length-prefixed frames from a streaming byte buffer.
 * Returns decoded UTF-8 XML strings plus any trailing incomplete bytes.
 */
export function decodeWebInspectorFrames(buffer: Buffer): {
  frames: string[];
  remaining: Buffer;
} {
  const frames: string[] = [];
  let offset = 0;

  while (buffer.length - offset >= 4) {
    const len = buffer.readUInt32BE(offset);
    if (buffer.length - offset < 4 + len) break;
    const payload = buffer.subarray(offset + 4, offset + 4 + len);
    frames.push(payload.toString("utf-8"));
    offset += 4 + len;
  }

  return {
    frames,
    remaining: buffer.subarray(offset),
  };
}

/**
 * Extract the `__selector` and key fields (`WIRApplicationIdentifierKey`,
 * `WIRMessageDataKey`, `WIRListingKey`) from a decoded XML plist frame.
 */
export function parseWebInspectorXmlFrame(xml: string): {
  selector: string | null;
  appId?: string;
  messageDataJson?: Record<string, any>;
  pages?: WebInspectorListingPage[];
} {
  const selectorMatch = xml.match(/<key>__selector<\/key>\s*<string>([^<]+)<\/string>/);
  const selector = selectorMatch?.[1] ?? null;

  const appIdMatch = xml.match(
    /<key>WIRApplicationIdentifierKey<\/key>\s*<string>([^<]+)<\/string>/,
  );
  const appId = appIdMatch?.[1];

  let messageDataJson: Record<string, any> | undefined;
  const dataMatch = xml.match(/<key>WIRMessageDataKey<\/key>\s*<data>([\s\S]*?)<\/data>/);
  if (dataMatch?.[1]) {
    try {
      const decoded = Buffer.from(dataMatch[1].replaceAll(/\s+/g, ""), "base64").toString("utf-8");
      messageDataJson = JSON.parse(decoded) as Record<string, any>;
    } catch {
      // malformed JSON inside data block
    }
  }

  let pages: WebInspectorListingPage[] | undefined;
  if (selector === "_rpc_applicationSentListing:" && appId) {
    pages = [];
    const pageIdMatches = [
      ...xml.matchAll(/<key>WIRPageIdentifierKey<\/key>\s*<integer>(\d+)<\/integer>/g),
    ];
    const urlMatches = [...xml.matchAll(/<key>WIRURLKey<\/key>\s*<string>([^<]*)<\/string>/g)];
    const titleMatches = [...xml.matchAll(/<key>WIRTitleKey<\/key>\s*<string>([^<]*)<\/string>/g)];
    for (let i = 0; i < pageIdMatches.length; i++) {
      pages.push({
        appId,
        pageId: Number.parseInt(pageIdMatches[i]![1]!, 10),
        url: urlMatches[i]?.[1],
        title: titleMatches[i]?.[1],
        type: "WIRTypeWebPage",
      });
    }
  }

  return { selector, appId, messageDataJson, pages };
}

/**
 * Discover a running iOS Simulator's `com.apple.webinspector` Unix domain
 * socket path (no external binaries required).
 */
export function findSimulatorWebInspectorSocket(udid?: string): string | null {
  if (process.env["SIMULATOR_WEBINSPECTOR_SOCKET"]) {
    const envSock = process.env["SIMULATOR_WEBINSPECTOR_SOCKET"];
    if (existsSync(envSock)) return envSock;
  }

  // Ask launchctl for CoreSimulator webinspector socket path
  try {
    const out = execSync("launchctl getenv SIMULATOR_WEBINSPECTOR_SOCKET 2>/dev/null || true", {
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    if (out && existsSync(out)) return out;
  } catch {
    // ignore
  }

  // Check CoreSimulator device tmp directory
  if (udid && process.env["HOME"]) {
    const tmpDir = join(
      process.env["HOME"],
      "Library/Developer/CoreSimulator/Devices",
      udid,
      "data/tmp",
    );
    if (existsSync(tmpDir)) {
      try {
        const entry = readdirSync(tmpDir).find((f) => f.includes("webinspector"));
        if (entry) return join(tmpDir, entry);
      } catch {
        // ignore
      }
    }
  }

  return null;
}

export interface AppleWebInspectorClientOptions {
  socketPath: string;
  bundleId?: string;
  timeoutMs?: number;
  /** Injectable socket connector for unit tests */
  connectSocket?: (socketPath: string) => Socket;
}

/**
 * Direct Apple `webinspectord` Unix-socket client implementing the
 * `_rpc_reportIdentifier:` → `_rpc_forwardSocketSetup:` → `_rpc_forwardSocketData:`
 * JSON-RPC flow without `ios_webkit_debug_proxy` or Appium.
 */
export class AppleWebInspectorClient {
  private readonly socketPath: string;
  private readonly bundleId?: string;
  private readonly timeoutMs: number;
  private readonly connectSocket: (path: string) => Socket;

  private readonly connectionId = randomUUID().toUpperCase();
  private readonly senderKey = randomUUID().toUpperCase();
  private socket: Socket | null = null;
  private readBuffer: Buffer = Buffer.alloc(0);
  private connected = false;
  private nextRpcId = 1;
  private pages: WebInspectorListingPage[] = [];
  private activePage: WebInspectorListingPage | null = null;
  private pendingRpc = new Map<
    number,
    {
      resolve: (val: any) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listingWaiters: Array<(pages: WebInspectorListingPage[]) => void> = [];

  constructor(options: AppleWebInspectorClientOptions) {
    this.socketPath = options.socketPath;
    this.bundleId = options.bundleId;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.connectSocket = options.connectSocket ?? ((p) => createConnection(p));
  }

  isConnected(): boolean {
    return this.connected && this.socket !== null && !this.socket.destroyed;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;

    await new Promise<void>((resolve, reject) => {
      const sock = this.connectSocket(this.socketPath);
      this.socket = sock;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        sock.destroy();
        reject(new Error(`Apple webinspectord socket connect timed out (${this.socketPath})`));
      }, this.timeoutMs);

      sock.once("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connected = true;
        // Announce our inspector connection identifier
        sock.write(
          encodeWebInspectorPacket("_rpc_reportIdentifier:", {
            WIRConnectionIdentifierKey: this.connectionId,
          }),
        );
        resolve();
      });

      sock.once("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      sock.on("data", (chunk: Buffer) => {
        this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
        const { frames, remaining } = decodeWebInspectorFrames(this.readBuffer);
        this.readBuffer = remaining;
        for (const frame of frames) {
          this.handleFrame(frame);
        }
      });

      sock.on("close", () => {
        this.connected = false;
        for (const [, p] of this.pendingRpc) {
          clearTimeout(p.timer);
          p.reject(new Error("Apple webinspectord socket closed"));
        }
        this.pendingRpc.clear();
      });
    });
  }

  private handleFrame(xml: string): void {
    const parsed = parseWebInspectorXmlFrame(xml);
    if (parsed.pages && parsed.pages.length > 0) {
      this.pages = parsed.pages;
      while (this.listingWaiters.length > 0) {
        this.listingWaiters.shift()!(this.pages);
      }
      return;
    }

    const msg = parsed.messageDataJson;
    if (msg && typeof msg["id"] === "number") {
      const entry = this.pendingRpc.get(msg["id"]);
      if (!entry) return;
      this.pendingRpc.delete(msg["id"]);
      clearTimeout(entry.timer);
      if (msg["error"]) {
        entry.reject(new Error(msg["error"].message ?? JSON.stringify(msg["error"])));
      } else {
        entry.resolve(msg["result"]);
      }
    }
  }

  async listPages(): Promise<WebInspectorListingPage[]> {
    if (!this.isConnected()) await this.connect();
    if (this.pages.length > 0) return this.pages;

    if (this.bundleId) {
      this.socket!.write(
        encodeWebInspectorPacket("_rpc_forwardGetListing:", {
          WIRConnectionIdentifierKey: this.connectionId,
          WIRApplicationIdentifierKey: this.bundleId,
        }),
      );
    }

    return new Promise<WebInspectorListingPage[]>((resolve) => {
      const timer = setTimeout(() => resolve(this.pages), 1500);
      this.listingWaiters.push((pages) => {
        clearTimeout(timer);
        resolve(pages);
      });
    });
  }

  async ensurePageAttached(): Promise<WebInspectorListingPage> {
    if (this.activePage) return this.activePage;
    const pages = await this.listPages();
    const chosen = pages.find((p) => p.url && p.url !== "about:blank") ?? pages[0];
    if (!chosen) {
      throw new Error(
        `No inspectable WKWebView pages reported by webinspectord (${this.socketPath})`,
      );
    }
    this.activePage = chosen;
    this.socket!.write(
      encodeWebInspectorPacket("_rpc_forwardSocketSetup:", {
        WIRConnectionIdentifierKey: this.connectionId,
        WIRApplicationIdentifierKey: chosen.appId,
        WIRPageIdentifierKey: chosen.pageId,
        WIRSenderKey: this.senderKey,
        WIRAutomaticallyPause: false,
      }),
    );
    return chosen;
  }

  async sendInspectorCommand<T = any>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const page = await this.ensurePageAttached();
    const id = this.nextRpcId++;
    const payload = Buffer.from(JSON.stringify({ id, method, params }), "utf-8");

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`webinspectord command "${method}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pendingRpc.set(id, { resolve, reject, timer });
      this.socket!.write(
        encodeWebInspectorPacket("_rpc_forwardSocketData:", {
          WIRConnectionIdentifierKey: this.connectionId,
          WIRApplicationIdentifierKey: page.appId,
          WIRPageIdentifierKey: page.pageId,
          WIRSenderKey: this.senderKey,
          WIRSocketDataKey: payload,
        }),
      );
    });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.activePage = null;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}
