import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WDAClient } from "./client.js";

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

describe("WDA client", () => {
  test("creates sessions, tracks session state, and decodes screenshots", async () => {
    queue.push(
      { body: { sessionId: "session-1", value: {} } },
      { body: { value: Buffer.from([1, 2, 3]).toString("base64") } },
      { body: { value: null } },
    );
    const client = new WDAClient("127.0.0.1", port);

    const sessionId = await client.createSession("com.example.app", "accept");
    const screenshot = await client.getScreenshot();
    await client.deleteSession();

    expect(sessionId).toBe("session-1");
    expect(client.hasSession()).toBe(false);
    expect(client.sessionID()).toBeNull();
    expect(Array.from(screenshot)).toEqual([1, 2, 3]);

    expect(calls[0]?.path).toBe("/session");
    expect(JSON.parse(calls[0]!.body)).toEqual({
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
    expect(calls[1]?.path).toBe("/session/session-1/screenshot");
    expect(calls[2]?.path).toBe("/session/session-1");
    expect(calls[2]?.method).toBe("DELETE");
  });

  test("sendKeys preserves grapheme clusters for combined Unicode input", async () => {
    queue.push({ body: { sessionId: "session-3", value: {} } }, { body: { value: null } });
    const client = new WDAClient("127.0.0.1", port);

    await client.createSession("com.example.app");
    await client.sendKeys("Hi👨‍👩‍👧‍👦e\u0301");

    expect(JSON.parse(calls[1]!.body)).toEqual({
      value: ["H", "i", "👨‍👩‍👧‍👦", "e\u0301"],
      frequency: 25,
    });
  });

  test("surfaces embedded WDA errors and non-OK request failures", async () => {
    queue.push(
      { body: { value: { sessionId: "session-2" } } },
      { body: { value: { error: "stale element", message: "bad source" } } },
      { status: 500, body: { value: { message: "tap exploded" } } },
    );
    const client = new WDAClient("127.0.0.1", port);

    await client.createSession("com.example.app");

    const embeddedError = await captureError(() => client.getSource());
    const requestError = await captureError(() => client.tap(10, 20));

    expect(embeddedError.message).toBe("WDA error: bad source");
    expect(requestError.message).toBe("WDA POST /session/session-2/wda/tap → 500: tap exploded");
  });

  test("reports parse failures for non-JSON responses", async () => {
    queue.push({ body: "not-json" });
    const client = new WDAClient("127.0.0.1", port);

    const error = await captureError(() => client.getStatus());

    expect(error.message).toBe("WDA: failed to parse response: not-json");
  });

  test("fails fast when a session-scoped request is made before a session exists", async () => {
    const client = new WDAClient("127.0.0.1", port);

    const error = await captureError(() => client.getSource());

    expect(error.message).toBe("WDA: no active session");
  });
});
