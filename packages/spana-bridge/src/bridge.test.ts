import { describe, expect, test } from "bun:test";
import { initSpanaBridge } from "./client.js";
import { initCapacitorSpanaBridge, resolveCapacitorBridgeHost } from "./capacitor.js";
import { initElectronSpanaBridge } from "./electron.js";

function createFakeEnv() {
  const store = new Map<string, string>();
  const listeners = new Map<string, Array<(e: any) => void>>();
  let resolveFetch: (() => void) | null = null;
  let animating = false;

  const fakeWin: any = {
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 2,
    scrollX: 0,
    scrollY: 0,
    navigator: { userAgent: "FakeBrowser" },
    location: { href: "http://localhost:3000", reload() {} },
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    localStorage: {
      setItem: (k: string, v: string) => store.set(k, v),
      getItem: (k: string) => store.get(k) ?? null,
      clear: () => store.clear(),
    },
    sessionStorage: { setItem() {}, clear() {} },
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      cursor: "auto",
    }),
    fetch: async (url: string) => {
      if (url.includes("/slow")) {
        await new Promise<void>((resolve) => {
          resolveFetch = resolve;
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    addEventListener: (type: string, fn: (e: any) => void) => {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener: (type: string, fn: (e: any) => void) => {
      const list = listeners.get(type) ?? [];
      listeners.set(
        type,
        list.filter((f) => f !== fn),
      );
    },
    emit(type: string, event: any) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };

  const fakeDoc: any = {
    cookie: "",
    documentElement: { clientWidth: 1280, clientHeight: 800 },
    querySelectorAll: () => [],
    getAnimations: () =>
      animating
        ? [{ playState: "running", effect: { getComputedTiming: () => ({ iterations: 1 }) } }]
        : [],
  };

  return {
    fakeWin,
    fakeDoc,
    store,
    finishSlowFetch: () => resolveFetch?.(),
    setAnimating: (v: boolean) => {
      animating = v;
    },
  };
}

describe("spana-bridge client", () => {
  test("idle() waits for in-flight fetch requests and finite animations to finish", async () => {
    const env = createFakeEnv();
    const bridge = initSpanaBridge({
      reconnectDelayMs: 0,
      WebSocketImpl: undefined,
      env: { window: env.fakeWin, document: env.fakeDoc },
    });

    env.setAnimating(true);
    const pendingFetch = env.fakeWin.fetch("https://api.example.com/slow");

    let idleResolved = false;
    const idlePromise = bridge.idle({ timeout: 2000, quietPeriodMs: 10 }).then(() => {
      idleResolved = true;
    });

    await new Promise((r) => setTimeout(r, 40));
    expect(idleResolved).toBe(false);

    env.setAnimating(false);
    env.finishSlowFetch();
    await pendingFetch;
    await idlePromise;
    expect(idleResolved).toBe(true);

    bridge.destroy();
  });

  test("mocks and blocks fetch requests and captures console + JS errors", async () => {
    const env = createFakeEnv();
    const bridge = initSpanaBridge({
      reconnectDelayMs: 0,
      WebSocketImpl: undefined,
      env: { window: env.fakeWin, document: env.fakeDoc },
    });

    bridge.mockNetwork(
      { type: "string", pattern: "/api/profile" },
      { status: 200, json: { id: "u1" } },
    );
    const res = await env.fakeWin.fetch("https://app.example.com/api/profile");
    expect(await res.json()).toEqual({ id: "u1" });

    bridge.blockNetwork({ type: "regexp", source: "analytics\\.example\\.com" });
    await expect(env.fakeWin.fetch("https://analytics.example.com/track")).rejects.toThrow(
      "Blocked by spana-bridge",
    );

    env.fakeWin.console.error("boom", 500);
    env.fakeWin.emit("error", { message: "Uncaught TypeError", error: { name: "TypeError" } });
    expect(bridge.getConsoleLogs()).toEqual([{ type: "error", text: "boom 500" }]);
    expect(bridge.getJSErrors()[0]?.message).toBe("Uncaught TypeError");

    bridge.clearNetworkMocks();
    bridge.destroy();
  });
});

describe("Capacitor & Electron spana-bridge wrappers", () => {
  test("resolves 10.0.2.2 on Android Capacitor and hooks Preferences storage", async () => {
    expect(resolveCapacitorBridgeHost("android")).toBe("10.0.2.2");
    expect(resolveCapacitorBridgeHost("android", "10.0.2.2", true)).toBe("127.0.0.1");
    expect(resolveCapacitorBridgeHost("ios")).toBe("127.0.0.1");
    expect(resolveCapacitorBridgeHost("web")).toBe("127.0.0.1");

    const env = createFakeEnv();
    env.fakeWin.Capacitor = { getPlatform: () => "android" };
    const prefStore = new Map<string, string>();

    const handle = initCapacitorSpanaBridge({
      reconnectDelayMs: 0,
      WebSocketImpl: undefined,
      env: { window: env.fakeWin, document: env.fakeDoc },
      preferences: {
        set: async ({ key, value }) => {
          prefStore.set(key, value);
        },
        clear: async () => {
          prefStore.clear();
        },
      },
    });

    expect(handle).not.toBeNull();
    expect(handle!.url).toBe("ws://10.0.2.2:9333");
    await handle!.setStorage({ capacitorPreferences: { token: "cap-jwt" } });
    expect(prefStore.get("token")).toBe("cap-jwt");
    await handle!.clearStorage({ capacitorPreferences: true });
    expect(prefStore.size).toBe(0);
    handle!.destroy();
  });

  test("Electron preload wrapper exposes read-only bridge metadata via contextBridge", () => {
    const env = createFakeEnv();
    const exposed: Record<string, unknown> = {};

    const disabled = initElectronSpanaBridge({ enabled: false });
    expect(disabled).toBeNull();

    const handle = initElectronSpanaBridge({
      enabled: true,
      port: 9445,
      reconnectDelayMs: 0,
      WebSocketImpl: undefined,
      env: { window: env.fakeWin, document: env.fakeDoc },
      contextBridge: {
        exposeInMainWorld: (key, api) => {
          exposed[key] = api;
        },
      },
    });

    expect(handle).not.toBeNull();
    expect(handle!.url).toBe("ws://127.0.0.1:9445");
    expect((exposed["__spanaBridgeMeta"] as any).url).toBe("ws://127.0.0.1:9445");
    handle!.destroy();
  });

  test("pierces open Shadow DOM and same-origin iframes with accumulated viewport offsets", () => {
    const env = createFakeEnv();
    const shadowButton = {
      tagName: "BUTTON",
      textContent: "Ion Sign In",
      innerText: "Ion Sign In",
      childNodes: [{ nodeType: 3, textContent: "Ion Sign In" }],
      attributes: [{ name: "data-testid", value: "ion-sign-in" }],
      getAttribute: (n: string) => (n === "data-testid" ? "ion-sign-in" : null),
      hasAttribute: () => false,
      getBoundingClientRect: () => ({ x: 16, y: 120, left: 16, top: 120, width: 200, height: 44 }),
    };
    const shadowHost = {
      tagName: "ION-BUTTON",
      shadowRoot: {
        querySelectorAll: (sel: string) =>
          sel === "*" || sel.includes("ion-sign-in") ? [shadowButton] : [],
      },
    };

    const iframeInput = {
      tagName: "INPUT",
      value: "4242",
      childNodes: [],
      attributes: [{ name: "data-testid", value: "card-number" }],
      getAttribute: (n: string) => (n === "data-testid" ? "card-number" : null),
      hasAttribute: () => false,
      getBoundingClientRect: () => ({ x: 10, y: 15, left: 10, top: 15, width: 180, height: 36 }),
    };
    const iframeHost = {
      tagName: "IFRAME",
      getBoundingClientRect: () => ({ x: 20, y: 300, left: 20, top: 300, width: 350, height: 100 }),
      contentDocument: {
        querySelectorAll: (sel: string) =>
          sel === "*" || sel.includes("card-number") ? [iframeInput] : [],
      },
    };

    env.fakeDoc.querySelectorAll = (sel: string) => (sel === "*" ? [shadowHost, iframeHost] : []);

    const bridge = initSpanaBridge({
      reconnectDelayMs: 0,
      WebSocketImpl: undefined,
      env: { window: env.fakeWin, document: env.fakeDoc },
    });

    const shadowMatches = bridge.query({ testID: "ion-sign-in" });
    expect(shadowMatches).toHaveLength(1);
    expect(shadowMatches[0]!.inShadowDom).toBe(true);
    expect(shadowMatches[0]!.rect).toEqual({ x: 16, y: 120, width: 200, height: 44 });

    const iframeMatches = bridge.query({ testID: "card-number" });
    expect(iframeMatches).toHaveLength(1);
    expect(iframeMatches[0]!.inIframe).toBe(true);
    // Accumulated iframe offset: (20+10=30, 300+15=315)
    expect(iframeMatches[0]!.rect).toEqual({ x: 30, y: 315, width: 180, height: 36 });

    bridge.destroy();
  });
});
