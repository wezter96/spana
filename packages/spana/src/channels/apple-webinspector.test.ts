import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import {
  AppleWebInspectorClient,
  decodeWebInspectorFrames,
  encodeWebInspectorPacket,
  parseWebInspectorXmlFrame,
} from "./apple-webinspector.js";

describe("Apple webinspectord zero-dependency protocol", () => {
  test("encodes and decodes chunked 4-byte length-prefixed XML plist frames", () => {
    const p1 = encodeWebInspectorPacket("_rpc_reportIdentifier:", {
      WIRConnectionIdentifierKey: "CONN-1",
    });
    const p2 = encodeWebInspectorPacket("_rpc_forwardGetListing:", {
      WIRConnectionIdentifierKey: "CONN-1",
      WIRApplicationIdentifierKey: "com.acme.app",
    });

    // Split across arbitrary chunk boundaries to verify streaming reassembly
    const combined = Buffer.concat([p1, p2]);
    const partA = combined.subarray(0, p1.length + 10);
    const partB = combined.subarray(p1.length + 10);

    const first = decodeWebInspectorFrames(partA);
    expect(first.frames).toHaveLength(1);
    expect(parseWebInspectorXmlFrame(first.frames[0]!).selector).toBe("_rpc_reportIdentifier:");

    const second = decodeWebInspectorFrames(Buffer.concat([first.remaining, partB]));
    expect(second.frames).toHaveLength(1);
    expect(second.remaining.length).toBe(0);
    const parsed2 = parseWebInspectorXmlFrame(second.frames[0]!);
    expect(parsed2.selector).toBe("_rpc_forwardGetListing:");
    expect(parsed2.appId).toBe("com.acme.app");
  });

  test("completes handshake, page listing, socket setup, and Runtime.evaluate over Unix socket", async () => {
    const written: string[] = [];

    class FakeUnixSocket extends EventEmitter {
      destroyed = false;
      write(data: Buffer) {
        const { frames } = decodeWebInspectorFrames(data);
        for (const frame of frames) {
          written.push(frame);
          const parsed = parseWebInspectorXmlFrame(frame);
          if (parsed.selector === "_rpc_forwardGetListing:") {
            const listing = encodeWebInspectorPacket("_rpc_applicationSentListing:", {
              WIRApplicationIdentifierKey: "com.acme.app",
              WIRListingKey: {
                "1": {
                  WIRPageIdentifierKey: 1,
                  WIRURLKey: "capacitor://localhost/login",
                  WIRTitleKey: "Acme Login",
                },
              },
            });
            queueMicrotask(() => this.emit("data", listing));
          } else if (parsed.selector === "_rpc_forwardSocketData:") {
            const rawMatch = frame.match(/<key>WIRSocketDataKey<\/key>\s*<data>([\s\S]*?)<\/data>/);
            const inner = JSON.parse(Buffer.from(rawMatch![1]!, "base64").toString("utf-8"));
            const reply = encodeWebInspectorPacket("_rpc_applicationSentData:", {
              WIRApplicationIdentifierKey: "com.acme.app",
              WIRMessageDataKey: Buffer.from(
                JSON.stringify({
                  id: inner.id,
                  result: { result: { type: "number", value: 99 } },
                }),
              ),
            });
            queueMicrotask(() => this.emit("data", reply));
          }
        }
        return true;
      }
      destroy() {
        this.destroyed = true;
        this.emit("close");
      }
    }

    const client = new AppleWebInspectorClient({
      socketPath: "/tmp/fake-webinspector.sock",
      bundleId: "com.acme.app",
      connectSocket: () => {
        const sock = new FakeUnixSocket();
        queueMicrotask(() => sock.emit("connect"));
        return sock as unknown as Socket;
      },
    });

    await client.connect();
    const res = await client.sendInspectorCommand<{ result: { value: number } }>(
      "Runtime.evaluate",
      { expression: "90 + 9", returnByValue: true },
    );

    expect(res.result.value).toBe(99);
    expect(written.some((f) => f.includes("_rpc_reportIdentifier:"))).toBe(true);
    expect(written.some((f) => f.includes("_rpc_forwardSocketSetup:"))).toBe(true);
    await client.disconnect();
  });
});
