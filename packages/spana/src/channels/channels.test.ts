import { describe, expect, test } from "bun:test";
import { createCdpDomChannel, selectCdpTarget, type MinimalWebSocket } from "./cdp-client.js";
import {
  createAndroidWebViewCdpChannel,
  parseAndroidWebViewSockets,
  selectAndroidWebViewSocket,
} from "./android-cdp.js";
import {
  createWebKitInspectorChannel,
  parseWebKitTargetListing,
  selectWebKitTarget,
} from "./webkit-inspector.js";
import { createSpanaBridgeChannel } from "./bridge-server.js";

function createFakeRpcSocket(
  responder: (req: {
    id: number;
    method: string;
    params?: Record<string, unknown>;
  }) => Record<string, unknown>,
): MinimalWebSocket & {
  sent: string[];
  event(method: string, params: Record<string, unknown>): void;
} {
  const listeners = new Map<string, Array<(e: any) => void>>();
  const sent: string[] = [];
  const emit = (type: string, event: any = {}) => {
    for (const fn of listeners.get(type) ?? []) fn(event);
  };
  return {
    readyState: 1,
    sent,
    event(method, params) {
      emit("message", { data: JSON.stringify({ method, params }) });
    },
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    send(data: string) {
      sent.push(data);
      const parsed = JSON.parse(data);
      const reply = responder(parsed);
      queueMicrotask(() => emit("message", { data: JSON.stringify({ id: parsed.id, ...reply }) }));
    },
    close() {
      emit("close");
    },
  };
}

describe("WebKit Remote Inspector channel (iOS direct WDA)", () => {
  test("parses target listings and prefers bundleId / non-blank pages", () => {
    const targets = parseWebKitTargetListing([
      {
        id: "page-0",
        url: "about:blank",
        webSocketDebuggerUrl: "ws://127.0.0.1:9221/devtools/page/0",
      },
      {
        id: "page-1",
        title: "Capacitor App",
        url: "capacitor://localhost/login",
        appId: "com.acme.app",
        webSocketDebuggerUrl: "ws://127.0.0.1:9221/devtools/page/1",
      },
    ]);

    expect(targets).toHaveLength(2);
    expect(selectWebKitTarget(targets, "com.acme.app")?.id).toBe("page-1");
    expect(selectWebKitTarget(targets)?.id).toBe("page-1");
  });

  test("evaluates scripts and queries DOM over WebKit Inspector JSON-RPC without Appium", async () => {
    const fakeSocket = createFakeRpcSocket((req) => {
      if (req.method === "Runtime.evaluate") {
        const expr = String(req.params?.["expression"] ?? "");
        if (expr.includes("data-testid")) {
          return {
            result: {
              result: {
                type: "object",
                value: [
                  {
                    id: "sign-in",
                    tag: "button",
                    text: "Sign in",
                    rect: { x: 24, y: 300, width: 342, height: 48 },
                    scrollX: 0,
                    scrollY: 0,
                    devicePixelRatio: 3,
                    viewportWidth: 390,
                    viewportHeight: 844,
                    visible: true,
                    enabled: true,
                    clickable: true,
                  },
                ],
              },
            },
          };
        }
        return { result: { result: { type: "number", value: 42 } } };
      }
      return { result: {} };
    });

    const channel = createWebKitInspectorChannel({
      endpointUrl: "http://127.0.0.1:9221",
      bundleId: "com.acme.app",
      fetchFn: (async () =>
        new Response(
          JSON.stringify([
            {
              id: "wk-1",
              url: "capacitor://localhost/login",
              appId: "com.acme.app",
              webSocketDebuggerUrl: "ws://127.0.0.1:9221/devtools/page/1",
            },
          ]),
          { status: 200 },
        )) as unknown as typeof fetch,
      createWebSocket: () => fakeSocket,
    });

    const value = await channel.evaluate<number>("21 * 2");
    expect(value).toBe(42);

    const matches = await channel.query({ testID: "sign-in" });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.id).toBe("sign-in");
    expect(matches[0]!.rect.y).toBe(300);

    await channel.disconnect();
  });

  test("surfaces WebKit wasThrown exceptions cleanly", async () => {
    const fakeSocket = createFakeRpcSocket(() => ({
      result: {
        wasThrown: true,
        result: { description: "ReferenceError: missingVar is not defined" },
      },
    }));

    const channel = createWebKitInspectorChannel({
      webSocketUrl: "ws://127.0.0.1:9221/devtools/page/1",
      createWebSocket: () => fakeSocket,
    });

    await expect(channel.evaluate("missingVar")).rejects.toThrow("ReferenceError: missingVar");
    await channel.disconnect();
  });
});

describe("Android WebView CDP channel", () => {
  test("parses /proc/net/unix webview_devtools_remote_<pid> sockets and picks matching PID", () => {
    const procNetUnix = [
      "Num       RefCount Protocol Flags    Type St Inode Path",
      "00000000: 00000002 00000000 00010000 0001 01 12345 @webview_devtools_remote_4321",
      "00000000: 00000002 00000000 00010000 0001 01 12346 @webview_devtools_remote_9876",
      "00000000: 00000002 00000000 00010000 0001 01 12347 @chrome_devtools_remote",
    ].join("\n");

    const sockets = parseAndroidWebViewSockets(procNetUnix);
    expect(sockets).toEqual([
      { socketName: "webview_devtools_remote_4321", pid: 4321 },
      { socketName: "webview_devtools_remote_9876", pid: 9876 },
      { socketName: "chrome_devtools_remote", pid: undefined },
    ]);

    expect(selectAndroidWebViewSocket(sockets, [9876])?.socketName).toBe(
      "webview_devtools_remote_9876",
    );
  });

  test("forwards abstract socket via adb, connects CDP, evaluates JS, and cleans up forward", async () => {
    const adbCalls: string[] = [];
    const fakeSocket = createFakeRpcSocket(() => ({
      result: { result: { type: "string", value: "https://app.example.com/home" } },
    }));

    const channel = createAndroidWebViewCdpChannel({
      serial: "emulator-5554",
      packageName: "com.acme.capacitor",
      localPort: 9444,
      runAdb: (args) => {
        adbCalls.push(args);
        if (args.includes("/proc/net/unix")) {
          return "0000: 0002 0000 0001 0001 01 99 @webview_devtools_remote_7777\n";
        }
        if (args.includes("pidof")) {
          return "7777\n";
        }
        return "";
      },
      fetchFn: (async () =>
        new Response(
          JSON.stringify([
            {
              id: "android-wv-1",
              type: "page",
              title: "Acme",
              url: "https://localhost/",
              webSocketDebuggerUrl: "ws://127.0.0.1:9444/devtools/page/1",
            },
          ]),
          { status: 200 },
        )) as unknown as typeof fetch,
      createWebSocket: () => fakeSocket,
    });

    const url = await channel.evaluate<string>("window.location.href");
    expect(url).toBe("https://app.example.com/home");
    expect(adbCalls).toContain(
      "-s emulator-5554 forward tcp:9444 localabstract:webview_devtools_remote_7777",
    );

    await channel.mockNetwork("**/api/orders", { status: 201, json: { order: 42 } });
    await channel.blockNetwork(/tracking/);
    fakeSocket.event("Fetch.requestPaused", {
      requestId: "mock",
      request: { url: "https://app.test/v1/api/orders" },
    });
    fakeSocket.event("Fetch.requestPaused", {
      requestId: "block",
      request: { url: "https://app.test/tracking" },
    });
    fakeSocket.event("Fetch.requestPaused", {
      requestId: "continue",
      request: { url: "https://app.test/assets" },
    });
    await channel.clearNetworkMocks();
    const requests = fakeSocket.sent.map((raw) => JSON.parse(raw));
    expect(requests.find((request) => request.method === "Fetch.fulfillRequest")?.params).toEqual({
      requestId: "mock",
      responseCode: 201,
      responseHeaders: [{ name: "content-type", value: "application/json" }],
      body: Buffer.from('{"order":42}').toString("base64"),
    });
    expect(
      requests.find((request) => request.method === "Fetch.failRequest")?.params.requestId,
    ).toBe("block");
    expect(
      requests.find((request) => request.method === "Fetch.continueRequest")?.params.requestId,
    ).toBe("continue");
    expect(requests.filter((request) => request.method === "Fetch.enable")).toHaveLength(1);
    expect(requests.at(-1)?.method).toBe("Fetch.disable");

    await channel.disconnect();
    expect(adbCalls).toContain("-s emulator-5554 forward --remove tcp:9444");
  });

  test("selectCdpTarget skips devtools:// pages", () => {
    const chosen = selectCdpTarget([
      {
        id: "dt",
        type: "page",
        url: "devtools://devtools/bundled/inspector.html",
        webSocketDebuggerUrl: "ws://a",
      },
      { id: "app", type: "page", url: "http://localhost:5173", webSocketDebuggerUrl: "ws://b" },
    ]);
    expect(chosen?.id).toBe("app");
  });
});

describe("SpanaBridgeChannel real RFC 6455 WebSocket server round-trip", () => {
  test("runs query, evaluate, setStorage/clearStorage, idle, and console capture over real WebSocket", async () => {
    const server = createSpanaBridgeChannel({ host: "127.0.0.1", port: 0, connectTimeoutMs: 3000 });
    const started = await server.start();

    const store = new Map<string, string>();
    const prefs = new Map<string, string>();
    let clicked = false;
    const logs = [{ type: "warn", text: "bridge-warning" }];

    // Connect a real WebSocket client speaking the spana-bridge JSON-RPC protocol
    const ws = new WebSocket(started.url);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "hello", meta: { shell: "capacitor", platform: "ios" } }));
    });
    ws.addEventListener("message", (event) => {
      const req = JSON.parse(String(event.data));
      let result: unknown;
      switch (req.method) {
        case "query":
          result =
            req.params?.selector?.testID === "sign-in"
              ? [
                  {
                    id: "sign-in",
                    tag: "button",
                    text: "Sign in",
                    rect: { x: 16, y: 200, width: 358, height: 48 },
                    scrollX: 0,
                    scrollY: 0,
                    devicePixelRatio: 3,
                    viewportWidth: 390,
                    viewportHeight: 844,
                    visible: true,
                    enabled: true,
                    clickable: true,
                  },
                ]
              : [];
          break;
        case "tap":
          clicked = true;
          result = true;
          break;
        case "evaluate": {
          const fn = new Function(`return (${req.params.script})`)();
          result = fn(...(req.params.args ?? []));
          break;
        }
        case "setStorage":
          for (const [k, v] of Object.entries(req.params?.localStorage ?? {})) {
            store.set(k, String(v));
          }
          for (const [k, v] of Object.entries(req.params?.capacitorPreferences ?? {})) {
            prefs.set(k, String(v));
          }
          result = true;
          break;
        case "clearStorage":
          store.clear();
          prefs.clear();
          result = true;
          break;
        case "getConsoleLogs":
          result = logs;
          break;
        case "idle":
          result = true;
          break;
      }
      ws.send(JSON.stringify({ id: req.id, result }));
    });

    await server.waitForClient(3000);

    const matches = await server.query({ testID: "sign-in" });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.id).toBe("sign-in");
    expect(matches[0]!.rect).toEqual({ x: 16, y: 200, width: 358, height: 48 });

    const tapped = await server.tapDom({ testID: "sign-in" });
    expect(tapped).toBe(true);
    expect(clicked).toBe(true);

    const sum = await server.evaluate((a: number, b: number) => a + b, 19, 23);
    expect(sum).toBe(42);

    await server.setStorage({
      localStorage: { auth_token: "jwt-123" },
      capacitorPreferences: { user_id: "u-9" },
    });
    expect(store.get("auth_token")).toBe("jwt-123");
    expect(prefs.get("user_id")).toBe("u-9");

    const receivedLogs = await server.getConsoleLogs();
    expect(receivedLogs.some((l) => l.type === "warn" && l.text.includes("bridge-warning"))).toBe(
      true,
    );

    await server.waitForIdle({ timeout: 500, quietPeriodMs: 10 });

    await server.clearStorage({ localStorage: true, capacitorPreferences: true });
    expect(store.size).toBe(0);
    expect(prefs.size).toBe(0);

    ws.close();
    await server.disconnect();
  });

  test("CdpDomChannel wraps evaluate errors in rejected promises", async () => {
    const fakeSocket = createFakeRpcSocket(() => ({
      result: { exceptionDetails: { text: "Uncaught SyntaxError" } },
    }));
    const cdp = createCdpDomChannel({
      endpointUrl: "http://127.0.0.1:9222",
      webSocketUrl: "ws://127.0.0.1:9222/page/1",
      createWebSocket: () => fakeSocket,
    });
    await expect(cdp.evaluate("{{bad")).rejects.toThrow("Uncaught SyntaxError");
    await cdp.disconnect();
  });
});
