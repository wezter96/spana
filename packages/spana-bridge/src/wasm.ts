/**
 * Canvas & WebAssembly Semantic Tree helpers for `spana-bridge`.
 *
 * Lets canvas-rendered WASM apps (Rust egui / AccessKit, Slint, Bevy, Godot, Unity,
 * Rive, Flutter Web CanvasKit/Skwasm, Figma-style editors) publish a lightweight logical
 * widget tree so Spana's `{ testID }`, `byRole(...)`, auto-wait, Studio Inspector, and
 * `spana mcp` work identically on `<canvas>` UIs as on HTML DOM elements.
 */

export interface WasmSemanticNode {
  testID?: string;
  id?: string;
  role?: string;
  label?: string;
  text?: string;
  value?: string;
  bounds: { x: number; y: number; width: number; height: number };
  visible?: boolean;
  enabled?: boolean;
  clickable?: boolean;
  focused?: boolean;
  checked?: boolean;
  editable?: boolean;
  attributes?: Record<string, string>;
  /** Optional CSS selector of the host `<canvas>` when `bounds` are canvas-local. */
  canvasSelector?: string;
}

export type WasmSemanticTreeProvider = WasmSemanticNode[] | (() => WasmSemanticNode[]);

export interface RegisterWasmSemanticTreeOptions {
  /** Default CSS selector for the `<canvas>` host (automatically offsets canvas-local bounds to viewport coordinates). */
  canvasSelector?: string;
  /** Optional window object override for unit tests. */
  win?: Record<string, any>;
}

/**
 * Register a logical semantic tree provider on `window.__SPANA_WASM_TREE__`.
 * Spana's Direct CDP, Playwright, and `spana-bridge` query layers automatically
 * read this tree when resolving `{ testID }`, `{ role }`, `{ text }`, and `{ accessibilityLabel }`.
 *
 * Returns an unregister function.
 */
export function registerWasmSemanticTree(
  provider: WasmSemanticTreeProvider,
  options: RegisterWasmSemanticTreeOptions = {},
): () => void {
  const win = options.win ?? (typeof window !== "undefined" ? (window as any) : undefined);
  if (!win) return () => {};

  const wrapped = (): WasmSemanticNode[] => {
    const raw = typeof provider === "function" ? provider() : provider;
    if (!Array.isArray(raw)) return [];
    if (!options.canvasSelector) return raw;
    return raw.map((node) =>
      node.canvasSelector ? node : { ...node, canvasSelector: options.canvasSelector },
    );
  };

  win.__SPANA_WASM_TREE__ = wrapped;
  return () => {
    if (win.__SPANA_WASM_TREE__ === wrapped) {
      delete win.__SPANA_WASM_TREE__;
    }
  };
}

/**
 * Mark a WASM app as ready (or provide a dynamic readiness predicate) so
 * `app.waitForWasmReady()` waits cleanly for custom initialization (e.g. shader compilation,
 * asset loading, or SQLite/DuckDB worker boot).
 */
export function setWasmReady(
  ready: boolean | (() => boolean),
  win: Record<string, any> | undefined = typeof window !== "undefined"
    ? (window as any)
    : undefined,
): void {
  if (!win) return;
  win.__SPANA_WASM_READY__ = ready;
}

/**
 * Automatically enable Flutter Web's hidden accessibility semantics tree
 * (`<flt-semantics-placeholder>`), turning CanvasKit / Skwasm widgets into queryable
 * ARIA elements for Spana selectors without modifying the Flutter app.
 *
 * Returns `true` if the semantics placeholder was found and activated.
 */
export function enableFlutterSemantics(
  doc: any = typeof document !== "undefined" ? document : undefined,
): boolean {
  if (!doc || typeof doc.querySelector !== "function") return false;
  const placeholder =
    doc.querySelector("flt-semantics-placeholder") ??
    doc.querySelector("flt-glass-pane")?.shadowRoot?.querySelector("flt-semantics-placeholder");
  if (!placeholder) return false;
  if (typeof placeholder.click === "function") {
    placeholder.click();
    return true;
  }
  if (typeof placeholder.dispatchEvent === "function") {
    placeholder.dispatchEvent(new Event("click", { bubbles: true }));
    return true;
  }
  return false;
}
