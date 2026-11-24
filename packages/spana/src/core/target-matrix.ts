import type { Platform } from "../schemas/selector.js";
import type { ProvConfig } from "../schemas/config.js";

export type TargetShell = "browser" | "capacitor" | "electron" | "electrobun";

export type TargetEngine =
  | "chromium"
  | "webkit"
  | "firefox"
  | "wkwebview"
  | "webview2"
  | "webkitgtk"
  | "android-webview"
  | "cef";

export type TargetChannel = "bridge" | "cdp" | "webkit-inspector" | "native-ax";

export interface TargetDescriptor {
  platform: Platform;
  shell: TargetShell;
  engine: TargetEngine;
  channels: readonly TargetChannel[];
  domChannels: readonly Exclude<TargetChannel, "native-ax">[];
  nativeChannel: "native-ax" | null;
  supportsSystemSheets: boolean;
  notes: string;
}

export type HostOS = "darwin" | "win32" | "linux";

/**
 * Canonical matrix describing how Spana reaches the DOM and native UI on each
 * supported web-first target:
 *   target = shell + engine + channels
 */
export const TARGET_CHANNEL_MATRIX: Record<Platform, TargetDescriptor> = {
  web: {
    platform: "web",
    shell: "browser",
    engine: "chromium",
    channels: ["bridge", "cdp"],
    domChannels: ["bridge", "cdp"],
    nativeChannel: null,
    supportsSystemSheets: false,
    notes: "Playwright (Chromium / WebKit / Firefox) + optional spana-bridge",
  },
  android: {
    platform: "android",
    shell: "capacitor",
    engine: "android-webview",
    channels: ["bridge", "cdp", "native-ax"],
    domChannels: ["bridge", "cdp"],
    nativeChannel: "native-ax",
    supportsSystemSheets: true,
    notes:
      "UiAutomator2 native tree + spana-bridge or adb forward webview_devtools_remote_<pid> CDP (Chrome Custom Tabs via native-ax)",
  },
  ios: {
    platform: "ios",
    shell: "capacitor",
    engine: "wkwebview",
    channels: ["bridge", "webkit-inspector", "native-ax"],
    domChannels: ["bridge", "webkit-inspector"],
    nativeChannel: "native-ax",
    supportsSystemSheets: true,
    notes:
      "Direct WDA native tree + spana-bridge or WebKit Remote Inspector (isInspectable = true, iOS 16.4+; SFSafariViewController via native-ax)",
  },
  electron: {
    platform: "electron",
    shell: "electron",
    engine: "chromium",
    channels: ["bridge", "cdp"],
    domChannels: ["bridge", "cdp"],
    nativeChannel: null,
    supportsSystemSheets: false,
    notes:
      "Playwright _electron.launch() or --remote-debugging-port CDP + optional spana-bridge preload",
  },
  electrobun: {
    platform: "electrobun",
    shell: "electrobun",
    engine: "wkwebview",
    channels: ["bridge", "webkit-inspector", "cdp"],
    domChannels: ["bridge", "webkit-inspector", "cdp"],
    nativeChannel: null,
    supportsSystemSheets: false,
    notes:
      "System webview by default (macOS WKWebView / Windows WebView2 / Linux WebKitGTK) or bundled CEF via chromiumFlags remote-debugging-port + spana-bridge",
  },
};

export function resolveElectrobunEngine(
  renderer: "native" | "cef" = "native",
  hostOs: HostOS = process.platform === "win32"
    ? "win32"
    : process.platform === "linux"
      ? "linux"
      : "darwin",
): { engine: TargetEngine; channels: TargetChannel[] } {
  if (renderer === "cef") {
    return {
      engine: "cef",
      channels: ["bridge", "cdp"],
    };
  }
  switch (hostOs) {
    case "win32":
      return {
        engine: "webview2",
        channels: ["bridge", "cdp"],
      };
    case "linux":
      return {
        engine: "webkitgtk",
        channels: ["bridge", "webkit-inspector"],
      };
    case "darwin":
    default:
      return {
        engine: "wkwebview",
        channels: ["bridge", "webkit-inspector"],
      };
  }
}

export function resolveTargetDescriptor(
  platform: Platform,
  config?: ProvConfig,
  hostOs?: HostOS,
): TargetDescriptor {
  const base = TARGET_CHANNEL_MATRIX[platform];
  if (platform === "web") {
    const browser = config?.execution?.web?.browser ?? "chromium";
    const channels: TargetChannel[] =
      browser === "chromium" ? ["bridge", "cdp"] : ["bridge", "webkit-inspector"];
    return {
      ...base,
      engine: browser,
      channels,
      domChannels: channels as Exclude<TargetChannel, "native-ax">[],
    };
  }
  if (platform === "electrobun") {
    const renderer = config?.apps?.electrobun?.renderer ?? "native";
    const resolved = resolveElectrobunEngine(renderer, hostOs);
    return {
      ...base,
      engine: resolved.engine,
      channels: resolved.channels,
      domChannels: resolved.channels.filter(
        (c): c is Exclude<TargetChannel, "native-ax"> => c !== "native-ax",
      ),
    };
  }
  return base;
}

export function formatTargetMatrixTable(
  platforms: Platform[] = ["web", "android", "ios", "electron", "electrobun"],
  config?: ProvConfig,
  hostOs?: HostOS,
): string {
  const header = ["Platform", "Shell", "Engine", "Channels", "System Sheets"];
  const rows = platforms.map((p) => {
    const d = resolveTargetDescriptor(p, config, hostOs);
    return [
      d.platform,
      d.shell,
      d.engine,
      d.channels.join(", "),
      d.supportsSystemSheets ? "yes (native-ax)" : "no",
    ];
  });

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const pad = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ");

  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [pad(header), sep, ...rows.map(pad)].join("\n");
}
