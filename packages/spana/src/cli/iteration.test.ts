import { describe, expect, test } from "bun:test";
import { buildLastRunState, extractDurationHints } from "./iteration.js";

describe("iteration duration hints", () => {
  test("persists per-flow durationMs and extracts max duration hints for longest-first scheduling", () => {
    const state = buildLastRunState({
      flowDir: "/repo/flows",
      platforms: ["web", "ios"],
      results: [
        { name: "fast-login", platform: "web", status: "passed", durationMs: 180 },
        { name: "slow-checkout", platform: "web", status: "passed", durationMs: 4200 },
        { name: "slow-checkout", platform: "ios", status: "failed", durationMs: 5100 },
      ],
      sourcePathsByFlowName: new Map([
        ["fast-login", "/repo/flows/login.flow.ts"],
        ["slow-checkout", "/repo/flows/checkout.flow.ts"],
      ]),
    });

    expect(state.flows.map((f) => f.durationMs)).toEqual([180, 4200, 5100]);
    expect(extractDurationHints(state)).toEqual({
      "fast-login": 180,
      "slow-checkout": 5100,
    });
    expect(extractDurationHints(null)).toEqual({});
  });
});
