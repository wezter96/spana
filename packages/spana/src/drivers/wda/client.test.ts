import { afterEach, describe, expect, test } from "bun:test";
import { WDAClient } from "./client.js";

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

describe("WDA client", () => {
  test("creates sessions, tracks session state, and decodes screenshots", async () => {
    const calls = queueFetch([
      { body: { sessionId: "session-1", value: {} } },
      { body: { value: Buffer.from([1, 2, 3]).toString("base64") } },
      { body: { value: null } },
    ]);
    const client = new WDAClient("127.0.0.1", 8100);

    const sessionId = await client.createSession("com.example.app", "accept");
    const screenshot = await client.getScreenshot();
    await client.deleteSession();

    expect(sessionId).toBe("session-1");
    expect(client.hasSession()).toBe(false);
    expect(client.sessionID()).toBeNull();
    expect(Array.from(screenshot)).toEqual([1, 2, 3]);

    expect(calls[0]?.url).toBe("http://127.0.0.1:8100/session");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      capabilities: {
        alwaysMatch: {
          shouldWaitForQuiescence: false,
          waitForIdleTimeout: 0,
          shouldUseTestManagerForVisibilityDetection: false,
          bundleId: "com.example.app",
          defaultAlertAction: "accept",
        },
      },
    });
    expect(calls[1]?.url).toBe("http://127.0.0.1:8100/session/session-1/screenshot");
    expect(calls[2]?.url).toBe("http://127.0.0.1:8100/session/session-1");
    expect(calls[2]?.init?.method).toBe("DELETE");
  });

  test("surfaces embedded WDA errors and non-OK request failures", async () => {
    queueFetch([
      { body: { value: { sessionId: "session-2" } } },
      { body: { value: { error: "stale element", message: "bad source" } } },
      { status: 500, body: { value: { message: "tap exploded" } } },
    ]);
    const client = new WDAClient("localhost", 8100);

    await client.createSession("com.example.app");

    const embeddedError = await captureError(() => client.getSource());
    const requestError = await captureError(() => client.tap(10, 20));

    expect(embeddedError.message).toBe("WDA error: bad source");
    expect(requestError.message).toBe("WDA POST /session/session-2/wda/tap → 500: tap exploded");
  });

  test("reports parse failures for non-JSON responses", async () => {
    queueFetch([{ body: "not-json" }]);
    const client = new WDAClient("localhost", 8100);

    const error = await captureError(() => client.getStatus());

    expect(error.message).toBe("WDA: failed to parse response: not-json");
  });

  test("fails fast when a session-scoped request is made before a session exists", async () => {
    const client = new WDAClient("localhost", 8100);

    const error = await captureError(() => client.getSource());

    expect(error.message).toBe("WDA: no active session");
  });
});
