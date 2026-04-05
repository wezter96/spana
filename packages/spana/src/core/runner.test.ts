import { describe, expect, test } from "bun:test";
import type { FlowDefinition } from "../api/flow.js";
import { filterFlows } from "./runner.js";

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
});
