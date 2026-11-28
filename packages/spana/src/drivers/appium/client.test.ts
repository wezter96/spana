import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AppiumClient } from "./client.js";

interface QueuedResponse {
  status?: number;
  body: unknown;
}

interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server;
let baseUrl: string;
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
        headers: req.headers,
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
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
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

describe("Appium client", () => {
  test("creates session with W3C capabilities and stores session caps", async () => {
    queue.push({
      body: {
        value: {
          sessionId: "abc-123",
          capabilities: {
            platformName: "Android",
            "appium:deviceName": "Pixel 6",
          },
        },
      },
    });
    const client = new AppiumClient(`${baseUrl}/wd/hub`);

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

    expect(calls[0]?.path).toBe("/wd/hub/session");
    expect(JSON.parse(calls[0]!.body)).toEqual({
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
    queue.push(
      { body: { value: { sessionId: "s-1", capabilities: {} } } },
      { body: { value: null } },
    );
    const client = new AppiumClient(baseUrl);

    await client.createSession({ platformName: "Android" });
    expect(client.getSessionId()).toBe("s-1");

    await client.deleteSession();
    expect(client.getSessionId()).toBeNull();
    expect(client.getSessionCaps()).toEqual({});

    expect(calls[1]?.path).toBe("/session/s-1");
    expect(calls[1]?.method).toBe("DELETE");
  });

  test("deleteSession is a no-op when no session exists", async () => {
    const client = new AppiumClient(baseUrl);

    await client.deleteSession();
    expect(calls.length).toBe(0);
  });

  test("makes session-scoped requests", async () => {
    queue.push(
      { body: { value: { sessionId: "s-2", capabilities: {} } } },
      { body: { value: "<hierarchy/>" } },
      { body: { value: null } },
    );
    const client = new AppiumClient(baseUrl);

    await client.createSession({ platformName: "Android" });

    const source = await client.request<string>("GET", client.sessionPath("/source"));
    expect(source).toBe("<hierarchy/>");
    expect(calls[1]?.path).toBe("/session/s-2/source");
    expect(calls[1]?.method).toBe("GET");

    await client.request("POST", client.sessionPath("/appium/gestures/click"), {
      offset: { x: 100, y: 200 },
    });
    expect(calls[2]?.path).toBe("/session/s-2/appium/gestures/click");
    expect(JSON.parse(calls[2]!.body)).toEqual({
      offset: { x: 100, y: 200 },
    });
  });

  test("surfaces W3C errors from non-200 responses", async () => {
    queue.push(
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
    );
    const client = new AppiumClient(baseUrl);
    await client.createSession({ platformName: "Android" });

    const error = await captureError(() =>
      client.request("GET", client.sessionPath("/element/123")),
    );
    expect(error.message).toBe("Appium GET /session/s-3/element/123 -> 404: Element not found");
  });

  test("surfaces embedded W3C errors in 200 responses", async () => {
    queue.push(
      { body: { value: { sessionId: "s-4", capabilities: {} } } },
      {
        body: {
          value: {
            error: "invalid element state",
            message: "Cannot click disabled element",
          },
        },
      },
    );
    const client = new AppiumClient(baseUrl);
    await client.createSession({ platformName: "Android" });

    const error = await captureError(() =>
      client.request("POST", client.sessionPath("/appium/gestures/click"), {
        offset: { x: 1, y: 2 },
      }),
    );
    expect(error.message).toBe("Appium error: Cannot click disabled element");
  });

  test("reports parse failures for non-JSON responses", async () => {
    queue.push({ body: "not-json" });
    const client = new AppiumClient(baseUrl);

    const error = await captureError(() => client.createSession({ platformName: "Android" }));
    expect(error.message).toBe("Appium: failed to parse session response: not-json");
  });

  test("fails when session response has no sessionId", async () => {
    queue.push({ body: { value: { capabilities: {} } } });
    const client = new AppiumClient(baseUrl);

    const error = await captureError(() => client.createSession({ platformName: "Android" }));
    expect(error.message).toContain("Appium: no sessionId in session response");
  });

  test("fails when session creation returns non-200", async () => {
    queue.push({
      status: 500,
      body: { value: { message: "Internal server error" } },
    });
    const client = new AppiumClient(baseUrl);

    const error = await captureError(() => client.createSession({ platformName: "Android" }));
    expect(error.message).toBe("Appium: failed to create session: Internal server error");
  });

  test("fails fast when sessionPath is called before session exists", () => {
    const client = new AppiumClient(baseUrl);

    expect(() => client.sessionPath("/source")).toThrow("Appium: no active session");
  });

  test("strips trailing slash from server URL", async () => {
    queue.push({ body: { value: { sessionId: "s-5", capabilities: {} } } });
    const client = new AppiumClient(`${baseUrl}/wd/hub/`);

    await client.createSession({ platformName: "Android" });

    expect(calls[0]?.path).toBe("/wd/hub/session");
  });

  test("sends basic auth when server URL includes credentials", async () => {
    queue.push({ body: { value: { sessionId: "s-auth", capabilities: {} } } });
    const authedUrl = baseUrl.replace("http://", "http://user:p%40ss@") + "/wd/hub";
    const client = new AppiumClient(authedUrl);

    await client.createSession({ platformName: "Android" });

    expect(calls[0]?.path).toBe("/wd/hub/session");
    expect(calls[0]?.headers.authorization).toBe("Basic dXNlcjpwQHNz");
  });

  test("request fails when response is not valid JSON", async () => {
    queue.push({ body: { value: { sessionId: "s-6", capabilities: {} } } }, { body: "garbage" });
    const client = new AppiumClient(baseUrl);
    await client.createSession({ platformName: "Android" });

    const error = await captureError(() => client.request("GET", client.sessionPath("/source")));
    expect(error.message).toBe("Appium: failed to parse response: garbage");
  });
});
