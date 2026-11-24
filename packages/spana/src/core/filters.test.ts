import { describe, expect, test } from "bun:test";
import {
  applyTestFilters,
  collectGitChanges,
  createOllamaDecisionJudge,
  decisionFilter,
  formatFilterSummary,
  pathRuleFilter,
  type FilterCandidate,
  type FilterContext,
  type GitChanges,
} from "./filters.js";

function makeChanges(overrides: Partial<GitChanges> = {}): GitChanges {
  const files = overrides.files ?? ["src/billing/checkout.ts"];
  return {
    baseRef: "origin/main",
    mergeBase: "abc1234",
    files,
    entries: files.map((path) => ({ path, status: "M" })),
    diff:
      overrides.diff ??
      "diff --git a/src/billing/checkout.ts b/src/billing/checkout.ts\n+const fee = 2;\n",
    diffBytes: overrides.diffBytes ?? 80,
    truncated: overrides.truncated ?? false,
    ...overrides,
  };
}

const CANDIDATES: FilterCandidate[] = [
  {
    id: "flows/billing.flow.ts::checkout#0",
    name: "checkout",
    file: "flows/billing.flow.ts",
    tags: ["billing"],
    source: 'flow("checkout", async ({ app }) => { await app.tap({ testID: "pay" }); });',
  },
  {
    id: "flows/profile.flow.ts::avatar#1",
    name: "avatar",
    file: "flows/profile.flow.ts",
    tags: ["profile"],
    source: 'flow("avatar", async ({ app }) => { await app.tap({ testID: "avatar" }); });',
  },
  {
    id: "flows/smoke.flow.ts::login-smoke#2",
    name: "login-smoke",
    file: "flows/smoke.flow.ts",
    tags: ["smoke"],
    source: 'flow("login-smoke", async ({ app }) => { await app.tap({ testID: "sign-in" }); });',
  },
];

function makeContext(changes: GitChanges): FilterContext {
  return {
    cwd: "/repo",
    changes,
    platforms: ["web"],
  };
}

describe("CI Filters API (--changed-since)", () => {
  test("decisionFilter skips only flows under 20% threshold and respects alwaysRunTags", async () => {
    const filter = decisionFilter({
      alwaysRunTags: ["smoke"],
      judge: async ({ candidate }) => {
        if (candidate.name === "checkout") {
          return { probability: 0.85, usage: { calls: 1, tokens: 900, costUsd: 0.0003 } };
        }
        return { probability: 0.05, usage: { calls: 1, tokens: 800, costUsd: 0.0002 } };
      },
    });

    const res = await applyTestFilters(
      CANDIDATES,
      CANDIDATES,
      [filter],
      makeContext(makeChanges()),
    );
    expect(res.kept.map((c) => c.name)).toEqual(["checkout", "login-smoke"]);
    expect(res.excluded).toHaveLength(1);
    expect(res.excluded[0]!.candidate.name).toBe("avatar");
    expect(res.excluded[0]!.reason).toContain("5%");

    const lines = formatFilterSummary(res.reports);
    expect(lines[0]).toContain("decision kept 2 of 3 flows, left out 1");
    expect(lines[0]).toContain("1.7k tokens");
    expect(lines[0]).toContain("$0.0005");
  });

  test("decisionFilter fails open on lockfile/config changes, large diffs, changed test files, and judge errors", async () => {
    let judgeCalls = 0;
    const filter = decisionFilter({
      runAllOnPaths: ["infra/"],
      judge: async () => {
        judgeCalls++;
        return { probability: 0.01 };
      },
    });

    // Lockfile change -> runs all without calling judge
    const lockRes = await applyTestFilters(
      CANDIDATES,
      CANDIDATES,
      [filter],
      makeContext(makeChanges({ files: ["bun.lock", "src/billing/checkout.ts"] })),
    );
    expect(lockRes.kept).toHaveLength(3);
    expect(judgeCalls).toBe(0);

    // infra/ global path -> runs all
    const infraRes = await applyTestFilters(
      CANDIDATES,
      CANDIDATES,
      [filter],
      makeContext(makeChanges({ files: ["infra/terraform/main.tf"] })),
    );
    expect(infraRes.kept).toHaveLength(3);
    expect(judgeCalls).toBe(0);

    // Diff > 60 kB -> fails open
    const hugeRes = await applyTestFilters(
      CANDIDATES,
      CANDIDATES,
      [filter],
      makeContext(makeChanges({ truncated: true, diffBytes: 90_000 })),
    );
    expect(hugeRes.kept).toHaveLength(3);
    expect(judgeCalls).toBe(0);

    // Changed test file always runs even if judge returns 0.01
    const changedFlowRes = await applyTestFilters(
      CANDIDATES,
      CANDIDATES,
      [filter],
      makeContext(makeChanges({ files: ["flows/profile.flow.ts"] })),
    );
    expect(changedFlowRes.kept.map((c) => c.name)).toEqual(["avatar"]);

    // Judge error fails open
    const throwingFilter = decisionFilter({
      judge: async () => {
        throw new Error("gateway 503");
      },
    });
    const errRes = await applyTestFilters(
      CANDIDATES,
      CANDIDATES,
      [throwingFilter],
      makeContext(makeChanges()),
    );
    expect(errRes.kept).toHaveLength(3);
  });

  test("pathRuleFilter deterministically filters tagged flows and fails open on unmatched flows", async () => {
    const filter = pathRuleFilter({
      alwaysRunTags: ["smoke"],
      rules: [
        { matchFlow: { tag: "billing" }, watchPaths: ["src/billing/"] },
        { matchFlow: { tag: "profile" }, watchPaths: ["src/profile/"] },
      ],
    });

    const res = await applyTestFilters(
      CANDIDATES,
      CANDIDATES,
      [filter],
      makeContext(makeChanges()),
    );
    expect(res.kept.map((c) => c.name)).toEqual(["checkout", "login-smoke"]);
    expect(res.excluded.map((e) => e.candidate.name)).toEqual(["avatar"]);
  });

  test("collectGitChanges parses merge-base, renames, and truncates oversized diffs", () => {
    const changes = collectGitChanges("origin/main", "/repo", 20, (args) => {
      if (args[0] === "merge-base") return "deadbeef\n";
      if (args[1] === "--name-status") return "M\tsrc/a.ts\nR100\tsrc/old.ts\tsrc/new.ts\n";
      return "x".repeat(50);
    });

    expect(changes.mergeBase).toBe("deadbeef");
    expect(changes.files).toEqual(["src/a.ts", "src/new.ts"]);
    expect(changes.truncated).toBe(true);
    expect(changes.diffBytes).toBe(50);
    expect(changes.diff.length).toBe(20);
  });

  test("createOllamaDecisionJudge batches all flows in 1 call and fails open on missing keys", async () => {
    const judge = createOllamaDecisionJudge({
      model: "qwen2.5:1.5b",
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            response: JSON.stringify({ "0": 0.92, "1": 0.04 }),
            prompt_eval_count: 350,
            eval_count: 25,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch,
    });

    const filter = decisionFilter({ alwaysRunTags: ["smoke"], batchJudge: judge });
    const res = await applyTestFilters(
      CANDIDATES,
      CANDIDATES,
      [filter],
      makeContext(makeChanges()),
    );
    expect(res.kept.map((c) => c.name)).toEqual(["checkout", "login-smoke"]);
    expect(res.excluded.map((e) => e.candidate.name)).toEqual(["avatar"]);
    expect(res.reports[0]!.usage).toEqual({ calls: 1, tokens: 375, costUsd: 0 });
  });

  test("probabilityFromTopLogprobs computes exact normalized YES/(YES+NO) probability", async () => {
    const { probabilityFromTopLogprobs, createLogprobDecisionJudge } = await import("./filters.js");

    // log(0.9) ≈ -0.10536, log(0.1) ≈ -2.30258 -> ~0.90
    const high = probabilityFromTopLogprobs([
      { token: "YES", logprob: Math.log(0.9) },
      { token: "NO", logprob: Math.log(0.1) },
    ]);
    expect(high).toBeCloseTo(0.9, 3);

    const low = probabilityFromTopLogprobs([
      { token: " no", logprob: Math.log(0.95) },
      { token: " yes", logprob: Math.log(0.05) },
    ]);
    expect(low).toBeCloseTo(0.05, 3);

    const promptsSeen: string[] = [];
    const judge = createLogprobDecisionJudge({
      provider: "openai",
      model: "typesafe-ai/jev",
      baseUrl: "http://127.0.0.1:8000",
      fetchFn: (async (_url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const prompt = String(body.messages?.[0]?.content ?? "");
        promptsSeen.push(prompt);
        const isCheckout = prompt.includes("Flow name: checkout");
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: isCheckout ? "YES" : "NO" },
                logprobs: {
                  content: [
                    {
                      token: isCheckout ? "YES" : "NO",
                      top_logprobs: isCheckout
                        ? [
                            { token: "YES", logprob: Math.log(0.94) },
                            { token: "NO", logprob: Math.log(0.06) },
                          ]
                        : [
                            { token: "NO", logprob: Math.log(0.96) },
                            { token: "YES", logprob: Math.log(0.04) },
                          ],
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 119, completion_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });

    const filter = decisionFilter({ alwaysRunTags: ["smoke"], judge });
    const res = await applyTestFilters(
      CANDIDATES,
      CANDIDATES,
      [filter],
      makeContext(makeChanges()),
    );
    expect(res.kept.map((c) => c.name)).toEqual(["checkout", "login-smoke"]);
    expect(res.excluded.map((e) => e.candidate.name)).toEqual(["avatar"]);
    // Shared diff prefix comes FIRST in both prompts for KV-cache reuse
    expect(promptsSeen).toHaveLength(2);
    const prefix0 = promptsSeen[0]!.split("Flow file:")[0];
    const prefix1 = promptsSeen[1]!.split("Flow file:")[0];
    expect(prefix0).toBe(prefix1);
    expect(prefix0).toContain("Changed files:");
  });
});
