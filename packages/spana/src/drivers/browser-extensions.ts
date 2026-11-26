import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PromiseApp } from "../api/app.js";

export interface ResolvedBrowserExtension {
  /** Absolute path to the unpacked extension directory. */
  path: string;
  /** Name read from `manifest.json`. */
  name: string;
  /** Version read from `manifest.json`. */
  version: string;
  /** Manifest version (`2` or `3`). */
  manifestVersion: number;
  /** Optional popup HTML path from `action.default_popup` or `browser_action.default_popup`. */
  defaultPopup?: string;
}

/**
 * Validate and resolve unpacked Chromium browser extension paths by reading each folder's
 * `manifest.json`. Throws a clear error if a path is missing or invalid.
 */
export function resolveBrowserExtensions(
  extensionPaths: string[],
  baseDir = process.cwd(),
): ResolvedBrowserExtension[] {
  return extensionPaths.map((rawPath) => {
    const absPath = resolve(baseDir, rawPath);
    if (!existsSync(absPath) || !statSync(absPath).isDirectory()) {
      throw new Error(`Browser extension directory not found: ${absPath}`);
    }
    const manifestPath = join(absPath, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`Browser extension at ${absPath} is missing manifest.json`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const manifestVersion = Number(manifest["manifest_version"] ?? 3);
    const action = (manifest["action"] ?? manifest["browser_action"]) as
      | { default_popup?: string }
      | undefined;
    return {
      path: absPath,
      name: String(manifest["name"] ?? "Unnamed Extension"),
      version: String(manifest["version"] ?? "0.0.0"),
      manifestVersion,
      ...(action?.default_popup ? { defaultPopup: action.default_popup } : {}),
    };
  });
}

/**
 * Merge Chromium extension launch flags (`--disable-extensions-except=...`, `--load-extension=...`)
 * into a Chrome CLI args array, automatically stripping `--disable-extensions` when extensions
 * are present.
 */
export function applyExtensionChromeArgs(
  baseArgs: string[],
  extensions: Array<string | ResolvedBrowserExtension>,
): string[] {
  if (extensions.length === 0) return [...baseArgs];
  const paths = extensions.map((e) => (typeof e === "string" ? resolve(e) : e.path));
  const joined = paths.join(",");
  const filtered = baseArgs.filter(
    (arg) =>
      arg !== "--disable-extensions" &&
      !arg.startsWith("--disable-extensions-except=") &&
      !arg.startsWith("--load-extension="),
  );
  return [...filtered, `--disable-extensions-except=${joined}`, `--load-extension=${joined}`];
}

export interface LoadedExtensionTarget {
  extensionId: string;
  targetId: string;
  type: string;
  url: string;
  title?: string;
}

/**
 * Query a running CDP browser (`Target.getTargets`) for loaded `chrome-extension://` targets
 * (background service workers, popup pages, options pages) and return their extension IDs.
 */
export async function getLoadedExtensions(cdp: {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
}): Promise<LoadedExtensionTarget[]> {
  const res = await cdp.send<{
    targetInfos?: Array<{ targetId?: string; type?: string; url?: string; title?: string }>;
  }>("Target.getTargets");
  const targets = Array.isArray(res?.targetInfos) ? res.targetInfos : [];
  const results: LoadedExtensionTarget[] = [];
  for (const t of targets) {
    const url = String(t.url ?? "");
    const match = url.match(/^chrome-extension:\/\/([a-z0-9]{16,})\//i);
    if (!match?.[1]) continue;
    results.push({
      extensionId: match[1],
      targetId: String(t.targetId ?? ""),
      type: String(t.type ?? "unknown"),
      url,
      ...(t.title ? { title: t.title } : {}),
    });
  }
  return results;
}

export interface OAuthPopupFlowOptions {
  /** Trigger action on the opener page that opens the third-party OAuth / SSO popup tab. */
  trigger: () => Promise<unknown>;
  /** Interactions to run once switched into the OAuth popup tab. */
  inPopup: (app: PromiseApp) => Promise<void>;
  /** Max time in ms to wait for the popup tab to open (default: 10_000). */
  timeoutMs?: number;
  /** Poll interval in ms when watching `app.getTabIds()` (default: 100). */
  pollIntervalMs?: number;
  /** Automatically switch back to the original opener tab after `inPopup` finishes (default: true). */
  returnToOpener?: boolean;
}

/**
 * Ergonomic multi-origin OAuth / SSO popup helper:
 * 1. Snapshots open tabs before calling `trigger()`.
 * 2. Waits for the newly opened popup tab to appear and switches to it.
 * 3. Runs `inPopup(app)` inside the third-party origin popup.
 * 4. Switches cleanly back to the original opener tab once the popup closes or completes.
 */
export async function runOAuthPopupFlow(
  app: PromiseApp,
  options: OAuthPopupFlowOptions,
): Promise<{ popupTabId: string; openerTabIndex: number }> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const returnToOpener = options.returnToOpener !== false;

  const beforeTabs = await app.getTabIds();
  const openerTabIndex = Math.max(0, beforeTabs.length - 1);
  const beforeSet = new Set(beforeTabs);

  await options.trigger();

  const deadline = Date.now() + timeoutMs;
  let popupIndex = -1;
  let popupTabId = "";

  while (Date.now() < deadline) {
    const currentTabs = await app.getTabIds();
    const foundIdx = currentTabs.findIndex((id) => !beforeSet.has(id));
    if (foundIdx >= 0) {
      popupIndex = foundIdx;
      popupTabId = currentTabs[foundIdx]!;
      break;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  if (popupIndex < 0) {
    throw new Error(`Timed out after ${timeoutMs}ms waiting for OAuth popup tab to open.`);
  }

  await app.switchToTab(popupIndex);
  try {
    await options.inPopup(app);
  } finally {
    if (returnToOpener) {
      const remaining = await app.getTabIds().catch(() => []);
      if (remaining.length > 0) {
        const targetIdx = Math.min(openerTabIndex, remaining.length - 1);
        await app.switchToTab(targetIdx).catch(() => {});
      }
    }
  }

  return { popupTabId, openerTabIndex };
}
