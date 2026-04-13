import { describe, expect, test } from "bun:test";
import { SessionManager } from "./session-manager.js";

const makeSession = (name: string) => ({
  name,
  platform: "web" as const,
  app: {} as any,
  expect: {} as any,
  disconnect: async () => {},
});

describe("SessionManager", () => {
  test("starts with no sessions", () => {
    const manager = new SessionManager();
    expect(manager.all()).toEqual([]);
  });

  test("register adds sessions and all() returns them", () => {
    const manager = new SessionManager();
    const fakeSession = {
      name: "admin",
      platform: "web" as const,
      app: {} as any,
      expect: {} as any,
      disconnect: async () => {},
    };
    manager.register(fakeSession, async () => {});
    expect(manager.all()).toEqual([fakeSession]);
  });

  test("disconnectAll calls cleanup for each session in reverse order", async () => {
    const manager = new SessionManager();
    const order: string[] = [];
    manager.register(makeSession("first"), async () => {
      order.push("first");
    });
    manager.register(makeSession("second"), async () => {
      order.push("second");
    });

    await manager.disconnectAll();
    expect(order).toEqual(["second", "first"]);
    expect(manager.all()).toEqual([]);
  });

  test("disconnectAll continues through errors and warns", async () => {
    const manager = new SessionManager();
    const order: string[] = [];
    manager.register(makeSession("ok"), async () => {
      order.push("ok");
    });
    manager.register(makeSession("failing"), async () => {
      throw new Error("boom");
    });

    // Should not throw
    await manager.disconnectAll();
    // "failing" is second, so cleaned up first (reverse), then "ok"
    expect(order).toEqual(["ok"]);
    expect(manager.all()).toEqual([]);
  });
});
