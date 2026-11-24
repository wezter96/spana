import {
  initSpanaBridge,
  type SpanaBridgeClientOptions,
  type SpanaBridgeHandle,
} from "./client.js";
import type { BridgeStorageAdapter } from "./protocol.js";

export interface CapacitorPreferencesLike {
  set(options: { key: string; value: string }): Promise<void>;
  clear(): Promise<void>;
}

export interface CapacitorBridgeOptions extends Omit<SpanaBridgeClientOptions, "storageAdapter"> {
  /** Optional `@capacitor/preferences` plugin instance (falls back to `window.Capacitor.Plugins.Preferences`). */
  preferences?: CapacitorPreferencesLike;
  /** Only initialize in test builds. Default: true (caller guards with `if (import.meta.env.MODE === 'test')`). */
  enabled?: boolean;
  /**
   * When true, Android connects to `127.0.0.1` via Spana's automatic
   * `adb reverse tcp:<port> tcp:<port>` tunnel (works on physical USB phones
   * AND emulators). Default: false (uses `10.0.2.2` on Android emulator).
   */
  useAdbReverse?: boolean;
  /** Host for Android emulator reverse/host loopback. Default: `"10.0.2.2"` on Android, `"127.0.0.1"` elsewhere. */
  androidEmulatorHost?: string;
}

/**
 * Resolve the runner host automatically for Capacitor apps:
 * - When `useAdbReverse` is true (physical Android USB devices + emulators), uses `127.0.0.1`
 * - Otherwise Android emulator uses `10.0.2.2` to reach host `127.0.0.1`
 * - iOS simulator and Web reach host `127.0.0.1` directly
 */
export function resolveCapacitorBridgeHost(
  platform?: string,
  androidEmulatorHost = "10.0.2.2",
  useAdbReverse = false,
): string {
  if (useAdbReverse) {
    return "127.0.0.1";
  }
  const detected =
    platform ??
    (typeof window !== "undefined" ? (window as any)?.Capacitor?.getPlatform?.() : undefined);

  if (detected === "android") {
    return androidEmulatorHost;
  }
  return "127.0.0.1";
}

/**
 * Capacitor wrapper around `initSpanaBridge`.
 * Hooks `@capacitor/preferences` into `setStorage()` / `clearStorage()` and
 * automatically selects the right loopback host for iOS Simulator vs Android Emulator.
 */
export function initCapacitorSpanaBridge(
  options: CapacitorBridgeOptions = {},
): SpanaBridgeHandle | null {
  if (options.enabled === false) {
    return null;
  }

  const win = options.env?.window ?? (typeof window !== "undefined" ? window : undefined);
  const capacitorPlatform: string | undefined = win?.Capacitor?.getPlatform?.();
  const host =
    options.host ??
    resolveCapacitorBridgeHost(
      capacitorPlatform,
      options.androidEmulatorHost,
      options.useAdbReverse ?? false,
    );

  const storageAdapter: BridgeStorageAdapter = {
    async setPreferences(entries) {
      const prefs = options.preferences ?? win?.Capacitor?.Plugins?.Preferences;
      if (!prefs?.set) return;
      for (const [key, value] of Object.entries(entries)) {
        await prefs.set({ key, value });
      }
    },
    async clearPreferences() {
      const prefs = options.preferences ?? win?.Capacitor?.Plugins?.Preferences;
      if (!prefs?.clear) return;
      await prefs.clear();
    },
  };

  return initSpanaBridge({
    ...options,
    host,
    storageAdapter,
    meta: {
      shell: "capacitor",
      capacitorPlatform: capacitorPlatform ?? "web",
      ...options.meta,
    },
  });
}
