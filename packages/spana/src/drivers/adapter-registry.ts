import type { RawDriverService } from "./raw-driver.js";
import type { DomChannel } from "../channels/dom-channel.js";
import type { Element } from "../schemas/element.js";
import type { ProvConfig } from "../schemas/config.js";

/**
 * Context passed to a `DriverAdapter.create()` factory when instantiating a target driver.
 * Custom browser engines and target platforms receive the user's config, resolved app target,
 * and optional pre-connected DOM transport channel.
 */
export interface DriverAdapterContext<TOptions = Record<string, unknown>> {
  platform: string;
  engine?: string;
  appId: string;
  config: ProvConfig;
  domChannel?: DomChannel;
  options?: TOptions;
  resolvePath: (relativePath: string) => string;
}

/**
 * Runtime handle returned by a `DriverAdapter`.
 * Any browser or target platform only needs to implement `RawDriverService` (plus optional
 * hierarchy parser and cleanup hook) to plug into Spana's auto-wait, assertions, parallel
 * runner, reporters, artifacts, and MCP server.
 */
export interface DriverAdapterHandle {
  driver: RawDriverService;
  parseHierarchy?: (raw: string) => Element;
  cleanup: () => Promise<void>;
  metadata?: Record<string, unknown>;
}

/**
 * Pluggable Driver Adapter contract.
 * Register a custom browser (e.g. WebDriver BiDi, Servo, Ladybird, custom Chromium wrapper)
 * or a new target platform (e.g. macOS, Windows, tvOS, Roku, embedded device) without
 * modifying Spana core.
 */
export interface DriverAdapter<TOptions = Record<string, unknown>> {
  /** Unique adapter identifier (e.g. `"bidi"`, `"servo"`, `"macos-ax"`, `"roku"`). */
  readonly name: string;
  /** Target platforms this adapter handles (e.g. `["web"]`, `["macos"]`, `["android", "ios"]`). */
  readonly platforms: readonly string[];
  /** Optional engine names this adapter matches (e.g. `["bidi"]`, `["cdp"]`, `["playwright"]`). */
  readonly engines?: readonly string[];
  /** Optional human-readable description shown in diagnostics and tooling. */
  readonly description?: string;
  /** Instantiate the driver and return its lifecycle handle. */
  create(ctx: DriverAdapterContext<TOptions>): Promise<DriverAdapterHandle>;
}

/**
 * Pluggable DOM Transport Adapter contract.
 * Swap or add low-level DOM transports (CDP, WebKit Remote Inspector, WebDriver BiDi,
 * Spana Bridge WebSocket, custom IPC) independently of the outer `RawDriverService`.
 */
export interface DomTransportContext<TOptions = Record<string, unknown>> {
  endpointUrl?: string;
  platform: string;
  config: ProvConfig;
  options?: TOptions;
}

export interface DomTransportAdapter<TOptions = Record<string, unknown>> {
  /** Unique transport identifier (e.g. `"cdp"`, `"webkit-inspector"`, `"bidi"`, `"spana-bridge"`). */
  readonly name: string;
  /** Transport kind tag exposed on `DomChannel.kind`. */
  readonly kind: string;
  /** Optional description. */
  readonly description?: string;
  /** Create and return a `DomChannel` instance. */
  create(ctx: DomTransportContext<TOptions>): Promise<DomChannel>;
}

const driverAdapters = new Map<string, DriverAdapter<any>>();
const domTransports = new Map<string, DomTransportAdapter<any>>();

/** Type-safe identity helper for authoring a custom `DriverAdapter`. */
export function defineDriverAdapter<TOptions = Record<string, unknown>>(
  adapter: DriverAdapter<TOptions>,
): DriverAdapter<TOptions> {
  return adapter;
}

/** Type-safe identity helper for authoring a custom `DomTransportAdapter`. */
export function defineDomTransport<TOptions = Record<string, unknown>>(
  adapter: DomTransportAdapter<TOptions>,
): DomTransportAdapter<TOptions> {
  return adapter;
}

/**
 * Register a pluggable `DriverAdapter` (overwrites any existing adapter with the same `name`).
 * Custom adapters registered for a `(platform, engine)` pair take precedence over built-in defaults.
 */
export function registerDriverAdapter<TOptions = Record<string, unknown>>(
  adapter: DriverAdapter<TOptions>,
): () => void {
  driverAdapters.set(adapter.name, adapter);
  return () => {
    if (driverAdapters.get(adapter.name) === adapter) {
      driverAdapters.delete(adapter.name);
    }
  };
}

/** Remove a registered `DriverAdapter` by name. Returns `true` if removed. */
export function unregisterDriverAdapter(name: string): boolean {
  return driverAdapters.delete(name);
}

/** List all currently registered `DriverAdapter`s. */
export function listDriverAdapters(): DriverAdapter[] {
  return Array.from(driverAdapters.values());
}

/**
 * Resolve a registered `DriverAdapter` by exact name, `(platform, engine)` match,
 * or platform-level match (last-registered wins so user overrides cleanly replace defaults).
 */
export function resolveDriverAdapter(platform: string, engine?: string): DriverAdapter | undefined {
  if (engine && driverAdapters.has(engine)) {
    const byName = driverAdapters.get(engine)!;
    if (byName.platforms.includes(platform) || byName.platforms.includes("*")) {
      return byName;
    }
  }
  const all = Array.from(driverAdapters.values()).toReversed();
  if (engine) {
    const exactEngine = all.find(
      (a) =>
        (a.platforms.includes(platform) || a.platforms.includes("*")) &&
        a.engines?.includes(engine),
    );
    if (exactEngine) return exactEngine;
  }
  return all.find(
    (a) =>
      (a.platforms.includes(platform) || a.platforms.includes("*")) &&
      (!a.engines ||
        a.engines.length === 0 ||
        (engine !== undefined && a.engines.includes(engine))),
  );
}

/** Register a pluggable `DomTransportAdapter`. Returns an unregister function. */
export function registerDomTransport<TOptions = Record<string, unknown>>(
  adapter: DomTransportAdapter<TOptions>,
): () => void {
  domTransports.set(adapter.name, adapter);
  return () => {
    if (domTransports.get(adapter.name) === adapter) {
      domTransports.delete(adapter.name);
    }
  };
}

/** Remove a registered `DomTransportAdapter` by name. */
export function unregisterDomTransport(name: string): boolean {
  return domTransports.delete(name);
}

/** List all currently registered `DomTransportAdapter`s. */
export function listDomTransports(): DomTransportAdapter[] {
  return Array.from(domTransports.values());
}

/** Resolve a registered `DomTransportAdapter` by name or transport `kind`. */
export function resolveDomTransport(nameOrKind: string): DomTransportAdapter | undefined {
  const direct = domTransports.get(nameOrKind);
  if (direct) return direct;
  return Array.from(domTransports.values())
    .toReversed()
    .find((t) => t.kind === nameOrKind);
}
