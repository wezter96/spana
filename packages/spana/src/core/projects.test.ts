import { describe, expect, it } from "bun:test";
import { flow } from "../api/flow.js";
import {
  filterFlowsForProject,
  resolveProjectExecutionPlan,
  type ProjectConfig,
} from "./projects.js";

describe("named projects DAG & filtering", () => {
  const projects: ProjectConfig[] = [
    { name: "setup", testMatch: ["**/*.setup.ts"], teardown: "cleanup" },
    { name: "cleanup", testMatch: ["**/*.teardown.ts"] },
    {
      name: "chromium",
      browser: "chromium",
      dependencies: ["setup"],
      testIgnore: ["**/*.setup.ts"],
    },
    { name: "firefox", browser: "firefox", dependencies: ["setup"], testIgnore: ["**/*.setup.ts"] },
    { name: "smoke-final", dependencies: ["chromium", "firefox"] },
  ];

  it("resolves projects into topological waves and collects teardown projects", () => {
    const plan = resolveProjectExecutionPlan(projects);
    expect(plan.waves.map((w) => w.map((p) => p.name))).toEqual([
      ["setup"],
      ["chromium", "firefox"],
      ["smoke-final"],
    ]);
    expect(plan.teardowns.map((p) => p.name)).toEqual(["cleanup"]);
  });

  it("expands transitive dependencies when selecting a single --project", () => {
    const plan = resolveProjectExecutionPlan(projects, ["chromium"]);
    expect(plan.waves.map((w) => w.map((p) => p.name))).toEqual([["setup"], ["chromium"]]);
    expect(plan.teardowns.map((p) => p.name)).toEqual(["cleanup"]);
  });

  it("rejects circular dependencies and unknown project names", () => {
    expect(() =>
      resolveProjectExecutionPlan([
        { name: "a", dependencies: ["b"] },
        { name: "b", dependencies: ["a"] },
      ]),
    ).toThrow(/Circular project dependency/);

    expect(() => resolveProjectExecutionPlan(projects, ["nonexistent"])).toThrow(
      /Unknown --project/,
    );
  });

  it("filters flows by testMatch, testIgnore, tags, and grep", () => {
    const f1 = Object.assign(
      flow("login flow", { tags: ["auth"] }, async () => {}),
      {
        sourcePath: "/repo/flows/auth/login.flow.ts",
      },
    );
    const f2 = Object.assign(
      flow("auth setup", { tags: ["setup"] }, async () => {}),
      {
        sourcePath: "/repo/flows/auth/auth.setup.ts",
      },
    );
    const f3 = Object.assign(
      flow("checkout flow", { tags: ["shop"] }, async () => {}),
      {
        sourcePath: "/repo/flows/shop/checkout.flow.ts",
      },
    );

    expect(
      filterFlowsForProject([f1, f2, f3], {
        name: "setup",
        testMatch: ["**/*.setup.ts"],
      }).map((f) => f.name),
    ).toEqual(["auth setup"]);

    expect(
      filterFlowsForProject([f1, f2, f3], {
        name: "app",
        testIgnore: ["**/*.setup.ts"],
        tags: ["auth"],
      }).map((f) => f.name),
    ).toEqual(["login flow"]);
  });
});
