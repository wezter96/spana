import { describe, expect, test } from "bun:test";
import type { FlowDefinition } from "../api/flow.js";
import { applyShard, filterFlows } from "./runner.js";

function makeFlow(name: string, config: FlowDefinition["config"] = {}): FlowDefinition {
  return {
    name,
    config,
    fn: async () => {},
  };
}

describe("filterFlows", () => {
  const flows = [
    makeFlow("login smoke", { tags: ["smoke"], platforms: ["web"] }),
    makeFlow("checkout regression", { tags: ["payments", "regression"], platforms: ["android"] }),
    makeFlow("shared happy path", { tags: ["smoke"] }),
  ];

  test("filters by tags using inclusive matching", () => {
    expect(filterFlows(flows, { tags: ["payments"] }).map((flow) => flow.name)).toEqual([
      "checkout regression",
    ]);
    expect(filterFlows(flows, { tags: ["smoke"] }).map((flow) => flow.name)).toEqual([
      "login smoke",
      "shared happy path",
    ]);
  });

  test("filters by grep case-insensitively", () => {
    expect(filterFlows(flows, { grep: "LOGIN" }).map((flow) => flow.name)).toEqual(["login smoke"]);
  });

  test("keeps unrestricted flows when filtering by platform", () => {
    expect(filterFlows(flows, { platforms: ["web"] }).map((flow) => flow.name)).toEqual([
      "login smoke",
      "shared happy path",
    ]);
    expect(filterFlows(flows, { platforms: ["ios"] }).map((flow) => flow.name)).toEqual([
      "shared happy path",
    ]);
  });

  test("filters by when.platform condition", () => {
    const whenFlows = [
      makeFlow("ios only", { when: { platform: "ios" } }),
      makeFlow("web only", { when: { platform: "web" } }),
      makeFlow("no condition"),
    ];
    expect(filterFlows(whenFlows, { platforms: ["ios"] }).map((f) => f.name)).toEqual([
      "ios only",
      "no condition",
    ]);
    expect(filterFlows(whenFlows, { platforms: ["web"] }).map((f) => f.name)).toEqual([
      "web only",
      "no condition",
    ]);
  });

  test("filters by when.platform array condition", () => {
    const whenFlows = [
      makeFlow("mobile", { when: { platform: ["ios", "android"] } }),
      makeFlow("all platforms"),
    ];
    expect(filterFlows(whenFlows, { platforms: ["web"] }).map((f) => f.name)).toEqual([
      "all platforms",
    ]);
    expect(filterFlows(whenFlows, { platforms: ["ios"] }).map((f) => f.name)).toEqual([
      "mobile",
      "all platforms",
    ]);
  });

  test("filters by when.env condition", () => {
    const envFlows = [
      makeFlow("ci only", { when: { env: "SPANA_TEST_CI_FLAG" } }),
      makeFlow("always"),
    ];
    // env var not set — ci only should be excluded
    delete process.env.SPANA_TEST_CI_FLAG;
    expect(filterFlows(envFlows, {}).map((f) => f.name)).toEqual(["always"]);

    // env var set — both should be included
    process.env.SPANA_TEST_CI_FLAG = "1";
    expect(filterFlows(envFlows, {}).map((f) => f.name)).toEqual(["ci only", "always"]);
    delete process.env.SPANA_TEST_CI_FLAG;
  });
});

describe("applyShard", () => {
  test("splits items into deterministic contiguous shards", () => {
    expect(applyShard(["a", "b", "c", "d", "e"], { current: 1, total: 2 })).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(applyShard(["a", "b", "c", "d", "e"], { current: 2, total: 2 })).toEqual(["d", "e"]);
  });

  test("returns empty shards when there are fewer items than shards", () => {
    expect(applyShard(["only-flow"], { current: 2, total: 2 })).toEqual([]);
    expect(applyShard(["a", "b"], { current: 4, total: 4 })).toEqual([]);
  });
});
