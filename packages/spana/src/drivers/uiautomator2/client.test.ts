import { afterEach, describe, expect, test } from "bun:test";
import { UiAutomator2Client } from "./client.js";

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

describe("UiAutomator2 client", () => {
  test("creates sessions and sends Android-specific action payloads", async () => {
    const calls = queueFetch([
      { body: { value: { sessionId: "session-1" } } },
      { body: { value: null } },
      { body: { value: null } },
      { body: { value: null } },
    ]);
    const client = new UiAutomator2Client("127.0.0.1", 4723);

    const sessionId = await client.createSession("com.example.app");
    await client.sendKeys("Ab");
    await client.pressKeyCode(66);
    await client.deleteSession();

    expect(sessionId).toBe("session-1");
    expect(calls[0]?.url).toBe("http://127.0.0.1:4723/session");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      capabilities: {
        platformName: "Android",
        "appium:appPackage": "com.example.app",
      },
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: [
            { type: "keyDown", value: "A" },
            { type: "keyUp", value: "A" },
            { type: "keyDown", value: "b" },
            { type: "keyUp", value: "b" },
          ],
        },
      ],
    });
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      keycode: 66,
    });
    expect(calls[3]?.url).toBe("http://127.0.0.1:4723/session/session-1");
    expect(calls[3]?.init?.method).toBe("DELETE");
  });

  test("sendKeys skips unsupported emoji and sends remaining graphemes", async () => {
    const calls = queueFetch([
      { body: { value: { sessionId: "session-2" } } },
      { body: { value: null } }, // "A" batch
      { body: { value: null } }, // "e\u0301" batch
    ]);
    const client = new UiAutomator2Client("127.0.0.1", 4723);

    await client.createSession("com.example.app");
    await client.sendKeys("A👨‍👩‍👧‍👦e\u0301");

    // "A" sent as first batch (before the emoji)
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: [
            { type: "keyDown", value: "A" },
            { type: "keyUp", value: "A" },
          ],
        },
      ],
    });
    // "e\u0301" sent as second batch (after emoji is skipped)
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: [
            { type: "keyDown", value: "e\u0301" },
            { type: "keyUp", value: "e\u0301" },
          ],
        },
      ],
    });
  });

  test("surfaces embedded UiAutomator2 errors and non-OK request failures", async () => {
    queueFetch([
      { body: { sessionId: "session-2", value: {} } },
      { body: { value: { error: "invalid element state", message: "bad tap" } } },
      { status: 404, body: { value: { message: "missing keyboard" } } },
    ]);
    const client = new UiAutomator2Client("localhost", 4723);

    await client.createSession("com.example.app");

    const embeddedError = await captureError(() => client.performTap(1, 2));
    const requestError = await captureError(() => client.hideKeyboard());

    expect(embeddedError.message).toBe("UiAutomator2 error: bad tap");
    expect(requestError.message).toBe(
      "UiAutomator2 POST /session/session-2/appium/device/hide_keyboard → 404: missing keyboard",
    );
  });

  test("reports parse failures for non-JSON responses", async () => {
    queueFetch([{ body: "nope" }]);
    const client = new UiAutomator2Client("localhost", 4723);

    const error = await captureError(() => client.createSession());

    expect(error.message).toBe("UiAutomator2: failed to parse session response: nope");
  });

  test("fails fast when a session-scoped request is made before a session exists", async () => {
    const client = new UiAutomator2Client("localhost", 4723);

    const error = await captureError(() => client.getSource());

    expect(error.message).toBe("UiAutomator2: no active session");
  });
});
