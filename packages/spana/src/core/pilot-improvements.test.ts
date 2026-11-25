import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  buildDomFillScript,
  buildDomWaitForHiddenScript,
  buildDomWaitForMatchScript,
  buildDomWaitForSelectorScript,
  type DomChannel,
} from "../channels/dom-channel.js";
import { waitForNotVisible } from "../smart/auto-wait.js";
import { createCoordinator } from "../smart/coordinator.js";
import { makeLightweightCdpDriver } from "../drivers/cdp-browser.js";
import type { RawDriverService } from "../drivers/raw-driver.js";
import { applyShard } from "./runner.js";
import { deterministicImpactFilter, type FilterCandidate } from "./filters.js";
import { compareScreenshots } from "./screenshot-compare.js";
import { isNativeAcceleratorActive } from "./native-accel.js";
import { tokenizeXML } from "../drivers/common/xml-tokenizer.js";
import { PNG } from "pngjs";
import {
  createApiClient,
  createApiFixture,
  createFlowWithFixtures,
  definePersona,
  PersonaAuthCache,
} from "../api/fixtures.js";
import type { Element } from "../schemas/element.js";
import type { FlowContext } from "../api/flow.js";
import type { PromiseApp } from "../api/app.js";

function createBaseDriver(domChannel?: DomChannel): RawDriverService {
  return {
    domChannel,
    dumpHierarchy: () =>
      Effect.succeed(
        JSON.stringify({ bounds: { x: 0, y: 0, width: 1280, height: 720 }, children: [] }),
      ),
    tapAtCoordinate: () => Effect.void,
    doubleTapAtCoordinate: () => Effect.void,
    longPressAtCoordinate: () => Effect.void,
    swipe: () => Effect.void,
    inputText: () => Effect.void,
    pressKey: () => Effect.void,
    hideKeyboard: () => Effect.void,
    takeScreenshot: () => Effect.succeed(new Uint8Array([1, 2, 3])),
    getDeviceInfo: () =>
      Effect.succeed({
        platform: "web",
        deviceId: "test",
        name: "Test",
        isEmulator: false,
        screenWidth: 1280,
        screenHeight: 720,
        driverType: "playwright",
      }),
    launchApp: () => Effect.void,
    stopApp: () => Effect.void,
    killApp: () => Effect.void,
    clearAppState: () => Effect.void,
    openLink: () => Effect.void,
    back: () => Effect.void,
    evaluate: () => Effect.void as any,
  };
}

describe("in-page actionability & zero-polling DOM waits", () => {
  test("buildDomWaitForSelectorScript uses light-DOM fast path, TreeWalker, and full actionability", () => {
    const script = buildDomWaitForSelectorScript({ testID: "submit" }, { forAction: true });
    expect(script).toContain("__SPANA_APP_READY__");
    expect(script).toContain("deepElementFromPoint");
    expect(script).toContain("isHitTestClear");
    expect(script).toContain("ensureInViewport");
    expect(script).toContain("requestAnimationFrame");
    expect(script).toContain("__spana_instant_anim");
    expect(script).toContain("createTreeWalker");
    expect(script).toContain("fastTid");

    const fillScript = buildDomFillScript({ testID: "email" }, "alice@example.com");
    expect(fillScript).toContain("HTMLInputElement");
    expect(fillScript).toContain("alice@example.com");
  });

  test("buildDomWaitForHiddenScript and buildDomWaitForMatchScript emit reactive MutationObserver scripts", () => {
    const hiddenScript = buildDomWaitForHiddenScript({ testID: "spinner" }, { timeoutMs: 2000 });
    expect(hiddenScript).toContain("MutationObserver");
    expect(hiddenScript).toContain("isHiddenNow");

    const matchScript = buildDomWaitForMatchScript(
      { testID: "status" },
      { kind: "containsText", expected: "Saved", timeoutMs: 2000 },
    );
    expect(matchScript).toContain("MutationObserver");
    expect(matchScript).toContain("containsText");
    expect(matchScript).toContain("Saved");
  });

  test("waitForNotVisible uses reactive domChannel.waitForHidden without polling backoff", async () => {
    let calls = 0;
    const domChannel: DomChannel = {
      kind: "playwright",
      isConnected: () => true,
      connect: async () => {},
      disconnect: async () => {},
      evaluate: async () => undefined as any,
      query: async () => [],
      waitForHidden: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 12));
        return true;
      },
      tapDom: async () => true,
    };
    const driver = createBaseDriver(domChannel);
    const parse = (raw: string) => JSON.parse(raw) as Element;

    const t0 = Date.now();
    await Effect.runPromise(
      waitForNotVisible(driver, { testID: "loading" }, parse, {
        timeout: 2000,
        pollInterval: 500,
        platform: "web",
      }),
    );
    expect(calls).toBe(1);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  test("coordinator assertText / assertValue / assertAttribute use reactive domChannel.waitForMatch", async () => {
    const seenKinds: string[] = [];
    const domChannel: DomChannel = {
      kind: "cdp",
      isConnected: () => true,
      connect: async () => {},
      disconnect: async () => {},
      evaluate: async () => undefined as any,
      query: async () => [],
      waitForMatch: async (_sel, opts) => {
        seenKinds.push(opts.kind);
        return { matched: true, actual: opts.expected ?? "ok" };
      },
      tapDom: async () => true,
    };
    const driver = createBaseDriver(domChannel);
    const coord = createCoordinator(driver, {
      parse: (raw) => JSON.parse(raw) as Element,
      platform: "web",
    });

    await Effect.runPromise(coord.assertText({ testID: "h1" }, "Welcome"));
    await Effect.runPromise(coord.assertContainsText({ testID: "h1" }, "Wel"));
    await Effect.runPromise(coord.assertMatchesText({ testID: "h1" }, /^Wel/));
    await Effect.runPromise(coord.assertValue({ testID: "email" }, "a@b.co"));
    await Effect.runPromise(coord.assertAttribute({ testID: "btn" }, "data-state", "ready"));
    await Effect.runPromise(coord.assertAccessibilityLabel({ testID: "btn" }, "Save"));

    expect(seenKinds).toEqual([
      "text",
      "containsText",
      "matchesText",
      "value",
      "attribute",
      "accessibilityLabel",
    ]);
  });

  test("coordinator.fill uses atomic 1-RTT domChannel.fillDom on web", async () => {
    const filled: Array<{ sel: unknown; val: string }> = [];
    const domChannel: DomChannel = {
      kind: "cdp",
      isConnected: () => true,
      connect: async () => {},
      disconnect: async () => {},
      evaluate: async () => undefined as any,
      query: async () => [],
      fillDom: async (sel, val) => {
        filled.push({ sel, val });
        return true;
      },
      tapDom: async () => true,
    };
    const driver = createBaseDriver(domChannel);
    const coord = createCoordinator(driver, {
      parse: (raw) => JSON.parse(raw) as Element,
      platform: "web",
    });

    await Effect.runPromise(coord.fill({ testID: "email" }, "hello@spana.dev"));
    expect(filled).toEqual([{ sel: { testID: "email" }, val: "hello@spana.dev" }]);
  });
});

describe("direct CDP driver isolated browser contexts, prefetch & WebAuthn", () => {
  test("creates isolated contexts, swaps pre-warmed context on beginFlow, and supports WebAuthn", async () => {
    const sent: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
    let ctxSeq = 1;
    let targetSeq = 1;
    let sessionSeq = 1;

    const mockWs = {
      readyState: 1,
      listeners: new Map<string, Set<(e: any) => void>>(),
      addEventListener(type: string, fn: (e: any) => void) {
        let s = this.listeners.get(type);
        if (!s) {
          s = new Set();
          this.listeners.set(type, s);
        }
        s.add(fn);
      },
      send(raw: string) {
        const req = JSON.parse(raw) as {
          id: number;
          method: string;
          params: Record<string, unknown>;
          sessionId?: string;
        };
        sent.push({ method: req.method, params: req.params, sessionId: req.sessionId });

        let result: Record<string, unknown> = {};
        if (req.method === "Target.createBrowserContext") {
          result = { browserContextId: `ctx-${ctxSeq++}` };
        } else if (req.method === "Target.createTarget") {
          result = { targetId: `tgt-${targetSeq++}` };
        } else if (req.method === "Target.attachToTarget") {
          result = { sessionId: `sid-${sessionSeq++}` };
        } else if (req.method === "WebAuthn.addVirtualAuthenticator") {
          result = { authenticatorId: "auth-42" };
        } else if (req.method === "WebAuthn.getCredentials") {
          result = {
            credentials: [
              {
                credentialId: "cred-1",
                isResidentCredential: true,
                rpId: "localhost",
                signCount: 1,
              },
            ],
          };
        } else if (req.method === "Runtime.evaluate") {
          result = { result: { type: "number", value: 6 } };
        }

        const msgListeners = this.listeners.get("message");
        queueMicrotask(() => {
          for (const fn of msgListeners ?? []) {
            fn({ data: JSON.stringify({ id: req.id, result }) });
          }
        });
      },
      close() {
        this.readyState = 3;
      },
    };

    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: "ws://127.0.0.1:9350/devtools/browser/abc",
        useBrowserContexts: true,
        freshContextPerFlow: true,
        virtualAuthenticator: true,
        createWebSocket: () => mockWs,
      }),
    );

    // First flow uses initial context (ctx-1 / sid-1) and prefetches ctx-2
    await Effect.runPromise(driver.beginFlow!("flow-1"));
    expect((driver.getRawPage!() as any).sessionId).toBe("sid-1");

    // Multi-arg evaluate
    const sum = await Effect.runPromise(
      driver.evaluate((a: number, b: number, c: number) => a + b + c, 1, 2, 3),
    );
    expect(sum).toBe(6);

    // Virtual authenticator credentials
    const creds = await Effect.runPromise(driver.getVirtualCredentials!());
    expect(creds).toHaveLength(1);
    expect(creds[0]!.credentialId).toBe("cred-1");

    // Second flow swaps to prefetched ctx-2 / sid-2 and disposes ctx-1 in background
    await Effect.runPromise(driver.beginFlow!("flow-2"));
    expect((driver.getRawPage!() as any).sessionId).toBe("sid-2");

    // Multi-tab management & network conditions over direct CDP
    const tab2 = await Effect.runPromise(driver.newTab!("https://example.com"));
    expect(tab2).toMatch(/^tab-/);
    const tabIds = await Effect.runPromise(driver.getTabIds!());
    expect(tabIds).toHaveLength(2);
    await Effect.runPromise(driver.switchToTab!(0));
    await Effect.runPromise(driver.closeTab!());
    expect(await Effect.runPromise(driver.getTabIds!())).toHaveLength(1);
    await Effect.runPromise(driver.setNetworkConditions!({ profile: "3g" }));

    await Effect.runPromise(driver.killApp(""));
    expect(sent.some((m) => m.method === "Target.createBrowserContext")).toBe(true);
    expect(sent.some((m) => m.method === "Target.disposeBrowserContext")).toBe(true);
    expect(sent.some((m) => m.method === "WebAuthn.addVirtualAuthenticator")).toBe(true);
    expect(sent.some((m) => m.method === "Network.emulateNetworkConditions")).toBe(true);
  });
});

describe("API setup client & per-persona auth cache", () => {
  test("createApiClient executes HTTP calls and runs onCleanup hooks in strict LIFO order", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const api = createApiClient({
      baseUrl: "http://localhost:3000/api",
      headers: { authorization: "Bearer secret" },
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return new Response(JSON.stringify({ id: "item-1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    const res = await api.post<{ id: string }>("/items", { name: "Alpha" });
    expect(res.status).toBe(201);
    expect(res.data.id).toBe("item-1");
    expect(calls[0]!.url).toBe("http://localhost:3000/api/items");

    const order: string[] = [];
    api.onCleanup(async () => {
      order.push("first-registered");
    });
    api.onCleanup(async () => {
      order.push("second-registered");
    });
    await api.cleanup();
    expect(order).toEqual(["second-registered", "first-registered"]);
  });

  test("createApiFixture cleans up even if the flow throws", async () => {
    const cleaned: string[] = [];
    const flowWithApi = createFlowWithFixtures({
      fixtures: {
        api: createApiFixture({
          baseUrl: "http://localhost:3000/api",
          fetchFn: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
        }),
      },
    });

    const f = flowWithApi("failing flow", async ({ api }) => {
      api.onCleanup(() => {
        cleaned.push("rolled-back");
      });
      throw new Error("boom");
    });

    await expect(
      f.fn({
        app: {} as PromiseApp,
        expect: {} as any,
        platform: "web",
      } as FlowContext),
    ).rejects.toThrow("boom");
    expect(cleaned).toEqual(["rolled-back"]);
  });

  test("PersonaAuthCache signs in once across concurrent calls and restores cached state", async () => {
    let signInCount = 0;
    const restoredStorage: unknown[] = [];

    const admin = definePersona("admin", {
      signIn: async () => {
        signInCount += 1;
        await new Promise((r) => setTimeout(r, 10));
        return { storage: { localStorage: { token: "jwt-123" } } };
      },
    });

    const cache = new PersonaAuthCache();
    const makeCtx = (): FlowContext =>
      ({
        platform: "web",
        expect: {} as any,
        app: {
          setStorage: async (entries: unknown) => {
            restoredStorage.push(entries);
          },
          openLink: async () => {},
        } as unknown as PromiseApp,
      }) as FlowContext;

    await Promise.all([cache.authenticate(admin, makeCtx()), cache.authenticate(admin, makeCtx())]);
    expect(signInCount).toBe(1);

    await cache.authenticate(admin, makeCtx());
    expect(signInCount).toBe(1);
    expect(restoredStorage).toHaveLength(1);
    expect(restoredStorage[0]).toEqual({ localStorage: { token: "jwt-123" } });
  });
});

describe("LPT balanced sharding & deterministic zero-AI impact filter", () => {
  test("applyShard uses LPT bin-packing when durationHintsMs are provided", () => {
    const flows = [
      { name: "slow-a" },
      { name: "med-b" },
      { name: "med-c" },
      { name: "fast-d" },
      { name: "fast-e" },
      { name: "fast-f" },
    ];
    const hints = {
      "slow-a": 10000,
      "med-b": 5000,
      "med-c": 4000,
      "fast-d": 3000,
      "fast-e": 2000,
      "fast-f": 1000,
    };

    const s1 = applyShard(
      flows,
      { current: 1, total: 2 },
      { durationHintsMs: hints, getName: (f) => f.name },
    );
    const s2 = applyShard(
      flows,
      { current: 2, total: 2 },
      { durationHintsMs: hints, getName: (f) => f.name },
    );

    const sum = (arr: typeof flows) =>
      arr.reduce((acc, f) => acc + hints[f.name as keyof typeof hints], 0);
    // Total is 25000ms -> balanced shards should be 13000ms vs 12000ms (vs naive 19000 vs 6000!)
    expect(Math.abs(sum(s1) - sum(s2))).toBeLessThanOrEqual(2000);
    expect(s1.length + s2.length).toBe(flows.length);
  });

  test("deterministicImpactFilter traces transitive static imports with 0 AI calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "spana-impact-"));
    try {
      mkdirSync(join(root, "src/checkout"), { recursive: true });
      mkdirSync(join(root, "src/profile"), { recursive: true });
      mkdirSync(join(root, "flows"), { recursive: true });

      writeFileSync(join(root, "src/checkout/pricing.ts"), "export const tax = 0.25;\n");
      writeFileSync(
        join(root, "src/checkout/cart.ts"),
        'import { tax } from "./pricing.js";\nexport const total = 1 + tax;\n',
      );
      writeFileSync(join(root, "src/profile/avatar.ts"), "export const avatar = 'ok';\n");
      writeFileSync(
        join(root, "flows/checkout.flow.ts"),
        'import { total } from "../src/checkout/cart.js";\nexport default total;\n',
      );
      writeFileSync(
        join(root, "flows/profile.flow.ts"),
        'import { avatar } from "../src/profile/avatar.js";\nexport default avatar;\n',
      );

      const candidates: FilterCandidate[] = [
        { id: "checkout", name: "checkout", file: "flows/checkout.flow.ts", tags: ["checkout"] },
        { id: "profile", name: "profile", file: "flows/profile.flow.ts", tags: ["profile"] },
      ];

      const filter = deterministicImpactFilter();
      const out = await filter.filter(candidates, {
        cwd: root,
        platforms: ["web"],
        changes: {
          baseRef: "main",
          files: ["src/checkout/pricing.ts"],
          entries: [{ path: "src/checkout/pricing.ts", status: "M" }],
          diff: "",
          diffBytes: 0,
          truncated: false,
        },
      });

      expect(out.exclude["checkout"]).toBeUndefined();
      expect(out.exclude["profile"]).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Rust native accelerator (visual regression PNG diff & quick-xml tokenizer)", () => {
  function makeSolidPng(width: number, height: number, r: number, g: number, b: number): Buffer {
    const png = new PNG({ width, height });
    for (let i = 0; i < width * height * 4; i += 4) {
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
    return PNG.sync.write(png);
  }

  test("loads Rust native library when built and performs fast PNG diff + XML tokenization", () => {
    expect(typeof isNativeAcceleratorActive()).toBe("boolean");

    const red = makeSolidPng(64, 64, 220, 40, 40);
    const blue = makeSolidPng(64, 64, 40, 80, 220);

    const same = compareScreenshots(red, red);
    expect(same.match).toBe(true);
    expect(same.diffPixelCount).toBe(0);

    const diff = compareScreenshots(red, blue, { threshold: 0.2, maxDiffPixelRatio: 0.01 });
    expect(diff.match).toBe(false);
    expect(diff.diffPixelCount).toBe(64 * 64);
    expect(diff.diffPixelRatio).toBeCloseTo(1, 2);
    expect(diff.diffImage).toBeDefined();
    expect(diff.diffImage!.byteLength).toBeGreaterThan(50);

    const xml = `<?xml version="1.0"?><hierarchy><android.widget.FrameLayout bounds="[0,0][1080,2400]" enabled="true"><android.widget.Button text="Continue" resource-id="btn-ok" enabled="true" /></android.widget.FrameLayout></hierarchy>`;
    const nodes = tokenizeXML(xml, "hierarchy");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.tagName).toBe("android.widget.FrameLayout");
    expect(nodes[0]!.children).toHaveLength(1);
    expect(nodes[0]!.children[0]!.attrs["resource-id"]).toBe("btn-ok");
  });
});
