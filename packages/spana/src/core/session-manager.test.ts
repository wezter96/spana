import { describe, expect, test } from "bun:test";
import { SessionManager } from "./session-manager.js";

describe("SessionManager", () => {
  test("starts with no sessions", () => {
    const manager = new SessionManager();
    expect(manager.all()).toEqual([]);
  });
});
