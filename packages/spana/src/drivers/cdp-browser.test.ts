import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { buildDirectChromiumLaunchArgs, makeLightweightCdpDriver } from "./cdp-browser.js";
import type { MinimalWebSocket } from "../channels/cdp-client.js";

function createFakeCdpSocket() {
  const sent: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [];
  const listeners = new Map<string, Set<(event: any) => void>>();
  let readyState = 1;

  const emit = (type: string, event: any) => {
    for (const fn of listeners.get(type) ?? []) {
      fn(event);
    }
  };

  const ws: MinimalWebSocket = {
    get readyState() {
      return readyState;
    },
    send(data: string) {
      const msg = JSON.parse(data) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      sent.push(msg);

      let result: Record<string, unknown> = {};
      if (msg.method === "Runtime.evaluate") {
        const expr = String(msg.params?.expression ?? "");
        if (expr.includes("findAcrossRoots")) {
          result = {
            result: {
              value: [
                {
                  id: "buy-now",
                  tag: "button",
                  text: "Buy Now",
                  rect: { x: 10, y: 20, width: 120, height: 40 },
                  scrollX: 0,
                  scrollY: 0,
                  devicePixelRatio: 1,
                  viewportWidth: 1280,
                  viewportHeight: 720,
                  visible: true,
                  enabled: true,
                  clickable: true,
                },
              ],
            },
          };
        } else {
          result = {
            result: {
              value: JSON.stringify({
                bounds: { x: 0, y: 0, width: 1280, height: 720 },
                children: [],
              }),
            },
          };
        }
      } else if (msg.method === "Page.captureScreenshot") {
        result = { data: Buffer.from("png-bytes").toString("base64") };
      }

      queueMicrotask(() => {
        emit("message", { data: JSON.stringify({ id: msg.id, result }) });
      });
    },
    close() {
      readyState = 3;
      emit("close", {});
    },
    addEventListener(type, listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
      if (type === "open") {
        queueMicrotask(() => listener({}));
      }
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };

  return { ws, sent };
}

describe("makeLightweightCdpDriver", () => {
  test("drives Lightpanda/CDP browser directly without Playwright client overhead", async () => {
    const { ws, sent } = createFakeCdpSocket();
    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: "ws://127.0.0.1:9222/devtools/page/1",
        baseUrl: "http://localhost:3000",
        engineLabel: "lightpanda",
        createWebSocket: () => ws,
      }),
    );

    const info = await Effect.runPromise(driver.getDeviceInfo());
    expect(info.platform).toBe("web");
    expect(info.deviceId).toBe("lightpanda:ws://127.0.0.1:9222/devtools/page/1");

    await Effect.runPromise(driver.launchApp("/checkout"));
    await Effect.runPromise(driver.tapAtCoordinate(70, 40));
    await Effect.runPromise(driver.inputText("hello"));
    const png = await Effect.runPromise(driver.takeScreenshot());
    expect(Buffer.from(png).toString("utf-8")).toBe("png-bytes");

    const matches = await driver.domChannel!.query({ testID: "buy-now" });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.id).toBe("buy-now");

    expect(
      sent.some(
        (m) => m.method === "Page.navigate" && m.params?.url === "http://localhost:3000/checkout",
      ),
    ).toBe(true);
    expect(
      sent.some(
        (m) => m.method === "Input.dispatchMouseEvent" && m.params?.type === "mousePressed",
      ),
    ).toBe(true);
    expect(sent.some((m) => m.method === "Input.insertText" && m.params?.text === "hello")).toBe(
      true,
    );

    await Effect.runPromise(driver.killApp(""));
  });
});

describe("buildDirectChromiumLaunchArgs", () => {
  test("disables OS keychain and background services for throwaway profiles", () => {
    const headlessArgs = buildDirectChromiumLaunchArgs({
      userDataDir: "/tmp/spana-test-profile",
      headless: true,
    });
    expect(headlessArgs).toContain("--headless=new");
    expect(headlessArgs).toContain("--remote-debugging-port=0");
    expect(headlessArgs).toContain("--user-data-dir=/tmp/spana-test-profile");
    expect(headlessArgs).toContain("--use-mock-keychain");
    expect(headlessArgs).toContain("--password-store=basic");
    expect(headlessArgs).toContain("--no-service-autorun");
    expect(headlessArgs).toContain("--disable-component-update");
    expect(headlessArgs).toContain("--disable-breakpad");
    expect(headlessArgs).toContain("--disable-gpu");
    expect(headlessArgs.at(-1)).toBe("about:blank");

    const headedArgs = buildDirectChromiumLaunchArgs({
      userDataDir: "/tmp/spana-test-headed",
      remoteDebuggingPort: 9322,
      headless: false,
      args: ["--window-size=1280,720"],
    });
    expect(headedArgs).not.toContain("--headless=new");
    expect(headedArgs).not.toContain("--disable-gpu");
    expect(headedArgs).toContain("--remote-debugging-port=9322");
    expect(headedArgs).toContain("--use-mock-keychain");
    expect(headedArgs).toContain("--password-store=basic");
    expect(headedArgs).toContain("--window-size=1280,720");
    expect(headedArgs.at(-1)).toBe("about:blank");
  });
});
