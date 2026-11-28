import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { UiAutomator2Client } from "./client.js";

interface QueuedResponse {
  status?: number;
  body: unknown;
}

interface RecordedRequest {
  method: string;
  path: string;
  body: string;
}

let server: Server;
let port: number;
let queue: QueuedResponse[] = [];
let calls: RecordedRequest[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      calls.push({
        method: req.method ?? "GET",
        path: req.url ?? "/",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const next = queue.shift();
      if (!next) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ value: { message: `Unexpected request: ${req.url}` } }));
        return;
      }
      res.writeHead(next.status ?? 200, { "Content-Type": "application/json" });
      res.end(typeof next.body === "string" ? next.body : JSON.stringify(next.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  queue = [];
  calls = [];
});

async function captureError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
    throw new Error("Expected action to fail");
  } catch (error) {
    return error as Error;
  }
}

describe("UiAutomator2 client", () => {
  test("creates sessions and sends Android-specific action payloads", async () => {
    queue.push(
      { body: { value: { sessionId: "session-1" } } },
      { body: { value: null } },
      { body: { value: null } },
      { body: { value: null } },
    );
    const client = new UiAutomator2Client("127.0.0.1", port);

    const sessionId = await client.createSession("com.example.app");
    await client.sendKeys("Ab");
    await client.pressKeyCode(66);
    await client.deleteSession();

    expect(sessionId).toBe("session-1");
    expect(calls[0]?.path).toBe("/session");
    expect(JSON.parse(calls[0]!.body)).toEqual({
      capabilities: {
        platformName: "Android",
        "appium:appPackage": "com.example.app",
      },
    });
    expect(JSON.parse(calls[1]!.body)).toEqual({
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
    expect(JSON.parse(calls[2]!.body)).toEqual({
      keycode: 66,
    });
    expect(calls[3]?.path).toBe("/session/session-1");
    expect(calls[3]?.method).toBe("DELETE");
  });

  test("sendKeys skips unsupported emoji and sends remaining graphemes", async () => {
    queue.push(
      { body: { value: { sessionId: "session-2" } } },
      { body: { value: null } },
      { body: { value: null } },
    );
    const client = new UiAutomator2Client("127.0.0.1", port);

    await client.createSession("com.example.app");
    await client.sendKeys("A👨‍👩‍👧‍👦e\u0301");

    expect(JSON.parse(calls[1]!.body)).toEqual({
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
    expect(JSON.parse(calls[2]!.body)).toEqual({
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
    queue.push(
      { body: { sessionId: "session-2", value: {} } },
      { body: { value: { error: "invalid element state", message: "bad tap" } } },
      { status: 404, body: { value: { message: "missing keyboard" } } },
    );
    const client = new UiAutomator2Client("127.0.0.1", port);

    await client.createSession("com.example.app");

    const embeddedError = await captureError(() => client.performTap(1, 2));
    const requestError = await captureError(() => client.hideKeyboard());

    expect(embeddedError.message).toBe("UiAutomator2 error: bad tap");
    expect(requestError.message).toBe(
      "UiAutomator2 POST /session/session-2/appium/device/hide_keyboard → 404: missing keyboard",
    );
  });

  test("reports parse failures for non-JSON responses", async () => {
    queue.push({ body: "nope" });
    const client = new UiAutomator2Client("127.0.0.1", port);

    const error = await captureError(() => client.createSession());

    expect(error.message).toBe("UiAutomator2: failed to parse session response: nope");
  });

  test("fails fast when a session-scoped request is made before a session exists", async () => {
    const client = new UiAutomator2Client("127.0.0.1", port);

    const error = await captureError(() => client.getSource());

    expect(error.message).toBe("UiAutomator2: no active session");
  });
});
