import { afterEach, describe, expect, test } from "bun:test";
import { AppiumClient } from "./client.js";

const originalFetch = globalThis.fetch;

interface FetchResponse {
  status?: number;
  body: unknown;
}

function queueFetch(responses: FetchResponse[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  globalThis.fetch = (async (input, init) => {
    const response = responses.shift();
    if (!response) {
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }

    calls.push({ url: String(input), init });

    return new Response(
      typeof response.body === "string" ? response.body : JSON.stringify(response.body),
      {
        status: response.status ?? 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  return calls;
}

async function captureError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
    throw new Error("Expected action to fail");
  } catch (error) {
    return error as Error;
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Appium client", () => {
  test("creates session with W3C capabilities and stores session caps", async () => {
    const calls = queueFetch([
      {
        body: {
          value: {
            sessionId: "abc-123",
            capabilities: {
              platformName: "Android",
              "appium:deviceName": "Pixel 6",
            },
          },
        },
      },
    ]);
    const client = new AppiumClient("http://hub.example.com/wd/hub");

    const sessionId = await client.createSession({
      platformName: "Android",
      "appium:deviceName": "Pixel 6",
      "appium:app": "bs://some-hash",
    });

    expect(sessionId).toBe("abc-123");
    expect(client.getSessionId()).toBe("abc-123");
    expect(client.getSessionCaps()).toEqual({
      platformName: "Android",
      "appium:deviceName": "Pixel 6",
    });

    expect(calls[0]?.url).toBe("http://hub.example.com/wd/hub/session");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      capabilities: {
        alwaysMatch: {
          platformName: "Android",
          "appium:deviceName": "Pixel 6",
          "appium:app": "bs://some-hash",
        },
      },
    });
  });

  test("deletes session and clears state", async () => {
    const calls = queueFetch([
      { body: { value: { sessionId: "s-1", capabilities: {} } } },
      { body: { value: null } }, // DELETE response
    ]);
    const client = new AppiumClient("http://localhost:4723");

    await client.createSession({ platformName: "Android" });
    expect(client.getSessionId()).toBe("s-1");

    await client.deleteSession();
    expect(client.getSessionId()).toBeNull();
    expect(client.getSessionCaps()).toEqual({});

    expect(calls[1]?.url).toBe("http://localhost:4723/session/s-1");
    expect(calls[1]?.init?.method).toBe("DELETE");
  });

  test("deleteSession is a no-op when no session exists", async () => {
    const calls = queueFetch([]);
    const client = new AppiumClient("http://localhost:4723");

    await client.deleteSession(); // should not throw or call fetch
    expect(calls.length).toBe(0);
  });

  test("makes session-scoped requests", async () => {
    const calls = queueFetch([
      { body: { value: { sessionId: "s-2", capabilities: {} } } },
      { body: { value: "<hierarchy/>" } },
      { body: { value: null } },
    ]);
    const client = new AppiumClient("http://localhost:4723");

    await client.createSession({ platformName: "Android" });

    const source = await client.request<string>("GET", client.sessionPath("/source"));
    expect(source).toBe("<hierarchy/>");
    expect(calls[1]?.url).toBe("http://localhost:4723/session/s-2/source");
    expect(calls[1]?.init?.method).toBe("GET");

    await client.request("POST", client.sessionPath("/appium/gestures/click"), {
      offset: { x: 100, y: 200 },
    });
    expect(calls[2]?.url).toBe("http://localhost:4723/session/s-2/appium/gestures/click");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      offset: { x: 100, y: 200 },
    });
  });

  test("surfaces W3C errors from non-200 responses", async () => {
    queueFetch([
      { body: { value: { sessionId: "s-3", capabilities: {} } } },
      {
        status: 404,
        body: {
          value: {
            error: "no such element",
            message: "Element not found",
            stacktrace: "",
          },
        },
      },
    ]);
    const client = new AppiumClient("http://localhost:4723");
    await client.createSession({ platformName: "Android" });

    const error = await captureError(() =>
      client.request("GET", client.sessionPath("/element/123")),
    );
    expect(error.message).toBe("Appium GET /session/s-3/element/123 -> 404: Element not found");
  });

  test("surfaces embedded W3C errors in 200 responses", async () => {
    queueFetch([
      { body: { value: { sessionId: "s-4", capabilities: {} } } },
      {
        body: {
          value: {
            error: "invalid element state",
            message: "Cannot click disabled element",
          },
        },
      },
    ]);
    const client = new AppiumClient("http://localhost:4723");
    await client.createSession({ platformName: "Android" });

    const error = await captureError(() =>
      client.request("POST", client.sessionPath("/appium/gestures/click"), {
        offset: { x: 1, y: 2 },
      }),
    );
    expect(error.message).toBe("Appium error: Cannot click disabled element");
  });

  test("reports parse failures for non-JSON responses", async () => {
    queueFetch([{ body: "not-json" }]);
    const client = new AppiumClient("http://localhost:4723");

    const error = await captureError(() => client.createSession({ platformName: "Android" }));
    expect(error.message).toBe("Appium: failed to parse session response: not-json");
  });

  test("fails when session response has no sessionId", async () => {
    queueFetch([{ body: { value: { capabilities: {} } } }]);
    const client = new AppiumClient("http://localhost:4723");

    const error = await captureError(() => client.createSession({ platformName: "Android" }));
    expect(error.message).toContain("Appium: no sessionId in session response");
  });

  test("fails when session creation returns non-200", async () => {
    queueFetch([
      {
        status: 500,
        body: { value: { message: "Internal server error" } },
      },
    ]);
    const client = new AppiumClient("http://localhost:4723");

    const error = await captureError(() => client.createSession({ platformName: "Android" }));
    expect(error.message).toBe("Appium: failed to create session: Internal server error");
  });

  test("fails fast when sessionPath is called before session exists", () => {
    const client = new AppiumClient("http://localhost:4723");

    expect(() => client.sessionPath("/source")).toThrow("Appium: no active session");
  });

  test("strips trailing slash from server URL", async () => {
    const calls = queueFetch([{ body: { value: { sessionId: "s-5", capabilities: {} } } }]);
    const client = new AppiumClient("http://localhost:4723/wd/hub/");

    await client.createSession({ platformName: "Android" });

    expect(calls[0]?.url).toBe("http://localhost:4723/wd/hub/session");
  });

  test("sends basic auth when server URL includes credentials", async () => {
    const calls = queueFetch([{ body: { value: { sessionId: "s-auth", capabilities: {} } } }]);
    const client = new AppiumClient("https://user:p%40ss@hub-cloud.browserstack.com/wd/hub");

    await client.createSession({ platformName: "Android" });

    expect(calls[0]?.url).toBe("https://hub-cloud.browserstack.com/wd/hub/session");
    expect((calls[0]?.init?.headers as Record<string, string>)?.Authorization).toBe(
      "Basic dXNlcjpwQHNz",
    );
  });

  test("request fails when response is not valid JSON", async () => {
    queueFetch([{ body: { value: { sessionId: "s-6", capabilities: {} } } }, { body: "garbage" }]);
    const client = new AppiumClient("http://localhost:4723");
    await client.createSession({ platformName: "Android" });

    const error = await captureError(() => client.request("GET", client.sessionPath("/source")));
    expect(error.message).toBe("Appium: failed to parse response: garbage");
  });
});
