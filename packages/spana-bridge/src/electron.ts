import {
  initSpanaBridge,
  type SpanaBridgeClientOptions,
  type SpanaBridgeHandle,
} from "./client.js";

export interface ElectronContextBridgeLike {
  exposeInMainWorld(apiKey: string, api: unknown): void;
}

export interface ElectronPreloadBridgeOptions extends SpanaBridgeClientOptions {
  /** Only initialize when enabled (defaults to `process.env.SPANA_BRIDGE === "1"` or explicit `true`). */
  enabled?: boolean;
  /** Optional Electron `contextBridge` to expose read-only status into the main world. */
  contextBridge?: ElectronContextBridgeLike;
  /** Name exposed on `window` via `contextBridge` (default: `"__spanaBridgeMeta"`). */
  exposeKey?: string;
}

/**
 * Electron preload wrapper around `initSpanaBridge`.
 *
 * Call inside your Electron preload script (or when `SPANA_BRIDGE_URL` /
 * `SPANA_BRIDGE_PORT` is passed in the environment by Spana's Electron driver).
 */
export function initElectronSpanaBridge(
  options: ElectronPreloadBridgeOptions = {},
): SpanaBridgeHandle | null {
  const env = typeof process !== "undefined" ? process.env : {};
  const envUrl = env["SPANA_BRIDGE_URL"];
  const envPort = env["SPANA_BRIDGE_PORT"]
    ? Number.parseInt(env["SPANA_BRIDGE_PORT"], 10)
    : undefined;

  const isEnabled =
    options.enabled !== undefined
      ? options.enabled
      : Boolean(env["SPANA_BRIDGE"] === "1" || envUrl || envPort || options.url || options.port);

  if (!isEnabled) {
    return null;
  }

  const handle = initSpanaBridge({
    ...options,
    url: options.url ?? envUrl,
    port: options.port ?? envPort ?? 9333,
    meta: {
      shell: "electron",
      electronVersion:
        typeof process !== "undefined" ? (process.versions as any)?.electron : undefined,
      ...options.meta,
    },
  });

  if (options.contextBridge) {
    try {
      options.contextBridge.exposeInMainWorld(options.exposeKey ?? "__spanaBridgeMeta", {
        url: handle.url,
        isConnected: () => handle.isConnected(),
      });
    } catch {
      // contextIsolation may be disabled; handle is already attached to window.__SPANA_BRIDGE__
    }
  }

  return handle;
}
