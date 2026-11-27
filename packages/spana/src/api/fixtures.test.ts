import { describe, expect, test } from "bun:test";
import { createFlowWithFixtures, defineSetup, extractDestructuredParamNames } from "./fixtures.js";
import type { FlowContext } from "./flow.js";

function makeFakeContext(log: string[]): FlowContext {
  const app = {
    clearStorage: async () => {
      log.push("app.clearStorage");
    },
    setStorage: async (entries: unknown) => {
      log.push(`app.setStorage:${JSON.stringify(entries)}`);
    },
    resetFast: async () => {
      log.push("app.resetFast");
    },
    openLink: async (url: string) => {
      log.push(`app.openLink:${url}`);
    },
    loadAuthState: async (path: string) => {
      log.push(`app.loadAuthState:${path}`);
    },
    evaluate: async () => undefined,
  } as any;

  return {
    app,
    expect: (() => ({})) as any,
    platform: "ios",
    workerIndex: 0,
    parallelIndex: 0,
    sessions: {} as any,
    skip: (() => {
      throw new Error("skip");
    }) as any,
  };
}

async function sampleDestructuredFn({
  app,
  project: p,
  task = "default",
  ...rest
}: {
  app: unknown;
  project: string;
  task?: string;
}) {
  void app;
  void p;
  void task;
  void rest;
}

describe("Composable lazy fixtures & named setups", () => {
  test("extractDestructuredParamNames parses aliases, defaults, and ignores rest params", () => {
    expect(extractDestructuredParamNames(sampleDestructuredFn)).toEqual(["app", "project", "task"]);
  });

  test("only initializes destructured fixtures, chains dependencies, and tears down in LIFO order even on throw", async () => {
    const events: string[] = [];

    const adminSetup = defineSetup("admin", {
      storage: { localStorage: { auth_token: "admin-jwt" } },
      navigateTo: "/dashboard",
    });

    const appFlow = createFlowWithFixtures<
      { autoReset: void; project: string; task: string; unusedExpensive: string },
      "admin"
    >({
      setups: { admin: adminSetup },
      fixtures: {
        autoReset: {
          auto: true,
          setup: async (_ctx, use) => {
            events.push("auto:setup");
            await use(undefined);
            events.push("auto:teardown");
          },
        },
        project: async (_ctx, use) => {
          events.push("project:setup");
          await use("proj-1");
          events.push("project:teardown");
        },
        task: async ({ project }, use) => {
          events.push(`task:setup(${project})`);
          await use(`${project}/task-9`);
          events.push("task:teardown");
        },
        unusedExpensive: async (_ctx, use) => {
          events.push("unused:setup");
          await use("never");
          events.push("unused:teardown");
        },
      },
    });

    const def = appFlow("creates task", { session: "admin" }, async ({ task }) => {
      events.push(`flow:run(${task})`);
      throw new Error("boom");
    });

    await expect(def.fn(makeFakeContext(events))).rejects.toThrow("boom");

    expect(events).toEqual([
      "app.clearStorage",
      'app.setStorage:{"localStorage":{"auth_token":"admin-jwt"}}',
      "app.openLink:/dashboard",
      "auto:setup",
      "project:setup",
      "task:setup(proj-1)",
      "flow:run(proj-1/task-9)",
      "task:teardown",
      "project:teardown",
      "auto:teardown",
    ]);
  });

  test("detects circular fixture dependencies", async () => {
    const cyclicFlow = createFlowWithFixtures<{ a: string; b: string }>({
      fixtures: {
        a: async ({ b }, use) => {
          await use(`a:${b}`);
        },
        b: async ({ a }, use) => {
          await use(`b:${a}`);
        },
      },
    });

    const def = cyclicFlow("cycle", async ({ a }) => {
      void a;
    });

    await expect(def.fn(makeFakeContext([]))).rejects.toThrow("Circular fixture dependency");
  });
});
