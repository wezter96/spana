import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeElectronDriver } from "./electron.js";
import { makeElectrobunDriver, resolveElectrobunLaunchPlan } from "./electrobun.js";
import type { DomChannel } from "../channels/dom-channel.js";
import { resolveTargetDescriptor, formatTargetMatrixTable } from "../core/target-matrix.js";

function createFakePage() {
  const events: Array<[string, ...unknown[]]> = [];
  const listeners = new Map<string, Array<(...a: any[]) => void>>();
  const page: any = {
    on: (ev: string, fn: (...a: any[]) => void) => {
      const list = listeners.get(ev) ?? [];
      list.push(fn);
      listeners.set(ev, list);
    },
    viewportSize: () => ({ width: 1280, height: 800 }),
    evaluate: async (script: any) => {
      events.push(["evaluate", typeof script === "string" ? script.slice(0, 30) : "fn"]);
      if (typeof script === "string" && script.includes("getBoundingClientRect")) {
        return {
          tag: "body",
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          visible: true,
          enabled: true,
          clickable: false,
          children: [],
        };
      }
      return "ok";
    },
    mouse: {
      click: async (x: number, y: number) => events.push(["click", x, y]),
      dblclick: async (x: number, y: number) => events.push(["dblclick", x, y]),
      move: async () => {},
      down: async () => {},
      up: async () => {},
      wheel: async () => {},
    },
    keyboard: {
      insertText: async (text: string) => events.push(["insertText", text]),
      press: async (key: string) => events.push(["press", key]),
    },
    screenshot: async () => Buffer.from([137, 80, 78, 71]),
    goto: async (url: string) => events.push(["goto", url]),
    reload: async () => events.push(["reload"]),
    goBack: async () => events.push(["goBack"]),
  };
  return { page, events };
}

describe("Electron target driver", () => {
  test("launches via Playwright _electron.launch and performs actions + resetFast", async () => {
    const { page, events } = createFakePage();
    let closed = false;
    let launchOpts: any;

    const driver = await Effect.runPromise(
      makeElectronDriver({
        entry: "./dist/main.js",
        cdpPort: 9229,
        launchElectron: (async (opts: any) => {
          launchOpts = opts;
          return {
            firstWindow: async () => page,
            context: () => ({
              clearCookies: async () => {
                events.push(["clearCookies"]);
              },
              route: async () => {},
              unroute: async () => {},
            }),
            close: async () => {
              closed = true;
            },
          } as any;
        }) as any,
      }),
    );

    expect(launchOpts.args).toContain("./dist/main.js");
    expect(launchOpts.args).toContain("--remote-debugging-port=9229");

    const info = await Effect.runPromise(driver.getDeviceInfo());
    expect(info.platform).toBe("electron");
    expect(info.driverType).toBe("electron");

    await Effect.runPromise(driver.tapAtCoordinate(100, 200));
    await Effect.runPromise(driver.inputText("hello"));
    await Effect.runPromise(driver.resetFast!());
    await Effect.runPromise(driver.killApp(""));

    expect(events).toContainEqual(["click", 100, 200]);
    expect(events).toContainEqual(["insertText", "hello"]);
    expect(events).toContainEqual(["clearCookies"]);
    expect(events).toContainEqual(["reload"]);
    expect(closed).toBe(true);
  });

  test("attaches to existing Electron app over CDP when cdpUrl is provided", async () => {
    const { page } = createFakePage();
    let attachedUrl = "";
    let closed = false;

    const driver = await Effect.runPromise(
      makeElectronDriver({
        cdpUrl: "http://127.0.0.1:9222",
        connectOverCDP: (async (url: string) => {
          attachedUrl = url;
          return {
            contexts: () => [{ pages: () => [page], clearCookies: async () => {} }],
            close: async () => {
              closed = true;
            },
          } as any;
        }) as any,
      }),
    );

    expect(attachedUrl).toBe("http://127.0.0.1:9222");
    const shot = await Effect.runPromise(driver.takeScreenshot());
    expect(Array.from(shot)).toEqual([137, 80, 78, 71]);
    await Effect.runPromise(driver.killApp(""));
    expect(closed).toBe(true);
  });
});

describe("Electrobun target driver & engine flag verification", () => {
  test("resolves exact engine flags per OS and renderer (CEF, WebView2, WKWebView, WebKitGTK)", () => {
    const cefPlan = resolveElectrobunLaunchPlan({ renderer: "cef", cdpPort: 9330 }, "darwin");
    expect(cefPlan.engine).toBe("cef");
    expect(cefPlan.env["ELECTROBUN_CDP_PORT"]).toBe("9330");
    expect(cefPlan.args).toContain("--remote-debugging-port=9330");
    expect(cefPlan.cdpUrl).toBe("http://127.0.0.1:9330");

    const winPlan = resolveElectrobunLaunchPlan({ renderer: "native", cdpPort: 9225 }, "win32");
    expect(winPlan.engine).toBe("webview2");
    expect(winPlan.env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"]).toContain(
      "--remote-debugging-port=9225",
    );
    expect(winPlan.cdpUrl).toBe("http://127.0.0.1:9225");

    const macPlan = resolveElectrobunLaunchPlan(
      { renderer: "native", webkitInspectorPort: 9221 },
      "darwin",
    );
    expect(macPlan.engine).toBe("wkwebview");
    expect(macPlan.preferredChannels).toEqual(["bridge", "webkit-inspector"]);

    const linuxPlan = resolveElectrobunLaunchPlan(
      { renderer: "native", webkitInspectorPort: 9224 },
      "linux",
    );
    expect(linuxPlan.engine).toBe("webkitgtk");
    expect(linuxPlan.env["WEBKIT_INSPECTOR_SERVER"]).toBe("127.0.0.1:9224");
  });

  test("runs Electrobun driver through spana-bridge DOM channel", async () => {
    let cleared = false;
    let reloaded = false;
    const bridgeStub: DomChannel = {
      kind: "bridge",
      isConnected: () => true,
      connect: async () => {},
      disconnect: async () => {},
      evaluate: async (script: any) => {
        if (typeof script === "string" && script.includes("innerWidth")) {
          return { width: 1024, height: 768 } as any;
        }
        return "electrobun-ok" as any;
      },
      query: async () => [],
      tapDom: async () => true,
      clearStorage: async () => {
        cleared = true;
      },
      reload: async () => {
        reloaded = true;
      },
    };

    const driver = await Effect.runPromise(
      makeElectrobunDriver({
        renderer: "native",
        hostOs: "darwin",
        domChannel: bridgeStub,
        attachOnly: true,
      }),
    );

    const info = await Effect.runPromise(driver.getDeviceInfo());
    expect(info.platform).toBe("electrobun");
    expect(info.driverType).toBe("electrobun");
    expect(info.screenWidth).toBe(1024);

    const res = await Effect.runPromise(driver.evaluate("1 + 1"));
    expect(res).toBe("electrobun-ok");

    await Effect.runPromise(driver.resetFast!());
    expect(cleared).toBe(true);
    expect(reloaded).toBe(true);
  });

  test("target channel matrix publishes all 5 platforms accurately", () => {
    expect(resolveTargetDescriptor("ios").channels).toEqual([
      "bridge",
      "webkit-inspector",
      "native-ax",
    ]);
    expect(resolveTargetDescriptor("android").channels).toEqual(["bridge", "cdp", "native-ax"]);
    expect(resolveTargetDescriptor("electron").channels).toEqual(["bridge", "cdp"]);
    expect(
      resolveTargetDescriptor("electrobun", { apps: { electrobun: { renderer: "cef" } } }).engine,
    ).toBe("cef");

    const table = formatTargetMatrixTable();
    expect(table).toContain("web");
    expect(table).toContain("android");
    expect(table).toContain("ios");
    expect(table).toContain("electron");
    expect(table).toContain("electrobun");
  });
});
