import { describe, test, expect, beforeEach } from "bun:test";
import { defineWorld, getWorldFactory, clearWorldFactory } from "./world.js";
import type { FlowContext } from "../api/flow.js";

const mockFlowCtx: FlowContext = {
  app: {} as any,
  expect: {} as any,
  platform: "web",
  workerIndex: 0,
  parallelIndex: 0,
  sessions: {} as any,
};

beforeEach(() => {
  clearWorldFactory();
});

describe("defineWorld", () => {
  test("creates world with typed state", () => {
    defineWorld({
      create: () => ({ currentUser: "", cart: [] as string[] }),
    });

    const factory = getWorldFactory()!;
    expect(factory).toBeDefined();

    const world = factory.instantiate(mockFlowCtx, new Map());
    expect(world.currentUser).toBe("");
    expect(world.cart).toEqual([]);
  });

  test("state is mutable within a scenario", () => {
    defineWorld({
      create: () => ({ count: 0 }),
    });

    const factory = getWorldFactory()!;
    const world = factory.instantiate(mockFlowCtx, new Map());
    world.count = 5;
    expect(world.count).toBe(5);
  });

  test("each instantiation gets fresh state", () => {
    defineWorld({
      create: () => ({ items: [] as string[] }),
    });

    const factory = getWorldFactory()!;
    const world1 = factory.instantiate(mockFlowCtx, new Map());
    world1.items.push("a");

    const world2 = factory.instantiate(mockFlowCtx, new Map());
    expect(world2.items).toEqual([]);
  });

  test("creates world with methods", () => {
    defineWorld({
      create: () => ({ loggedIn: false }),
      methods: (ctx) => ({
        login() {
          ctx.loggedIn = true;
        },
      }),
    });

    const factory = getWorldFactory()!;
    const world = factory.instantiate(mockFlowCtx, new Map());
    expect(world.loggedIn).toBe(false);
    world.login();
    expect(world.loggedIn).toBe(true);
  });

  test("methods have access to flow context", () => {
    let capturedPlatform: string | undefined;

    defineWorld({
      create: () => ({}),
      methods: (ctx) => ({
        getPlatform() {
          capturedPlatform = ctx.platform;
        },
      }),
    });

    const factory = getWorldFactory()!;
    const world = factory.instantiate(mockFlowCtx, new Map());
    world.getPlatform();
    expect(capturedPlatform).toBe("web");
  });

  test("methods have access to state map", () => {
    let capturedState: Map<string, unknown> | undefined;

    defineWorld({
      create: () => ({}),
      methods: (ctx) => ({
        getState() {
          capturedState = ctx.state;
        },
      }),
    });

    const factory = getWorldFactory()!;
    const state = new Map<string, unknown>([["key", "value"]]);
    const world = factory.instantiate(mockFlowCtx, state);
    world.getState();
    expect(capturedState).toBe(state);
    expect(capturedState!.get("key")).toBe("value");
  });

  test("clearWorldFactory removes the factory", () => {
    defineWorld({ create: () => ({}) });
    expect(getWorldFactory()).toBeDefined();
    clearWorldFactory();
    expect(getWorldFactory()).toBeUndefined();
  });

  test("latest defineWorld wins", () => {
    defineWorld({ create: () => ({ version: 1 }) });
    defineWorld({ create: () => ({ version: 2 }) });

    const factory = getWorldFactory()!;
    const world = factory.instantiate(mockFlowCtx, new Map());
    expect(world.version).toBe(2);
  });
});
