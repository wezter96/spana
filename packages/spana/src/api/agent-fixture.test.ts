import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromiseApp } from "./app.js";
import {
  createFlowAgent,
  formatActionsAsFlowCode,
  isSecretValue,
  runExploreSession,
  secret,
  unique,
} from "./agent-fixture.js";
import {
  clearReplayCache,
  formatCacheInspectTable,
  inspectReplayCache,
} from "../cli/cache-command.js";

function makeStubApp(calls: string[]): PromiseApp {
  return {
    tap: async (sel: unknown) => {
      calls.push(`tap:${JSON.stringify(sel)}`);
    },
    inputText: async (text: string) => {
      calls.push(`input:${text}`);
    },
    url: async () => "http://localhost:3000/login",
    evaluate: async () => '{"title":"Login","elements":[]}',
  } as unknown as PromiseApp;
}

describe("first-class agent fixture, secrets, explore & cache CLI", () => {
  it("masks secret() values in toString/JSON and generates unique() slugs", () => {
    const pw = secret("super-secret-password");
    expect(isSecretValue(pw)).toBe(true);
    expect(String(pw)).toBe("***REDACTED***");
    expect(JSON.stringify({ pw })).toBe('{"pw":"***REDACTED***"}');
    expect(pw.reveal()).toBe("super-secret-password");

    const u1 = unique("user", { domain: "example.com" });
    const u2 = unique("user", { domain: "example.com" });
    expect(u1).toMatch(/^user-[a-z0-9]+-[a-f0-9]+@example\.com$/);
    expect(u1).not.toBe(u2);
  });

  it("caches verified agent.act() actions on pass and replays with 0 LLM calls on next run", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "spana-agent-cache-"));
    try {
      const calls1: string[] = [];
      let llmCalls = 0;
      const agent1 = createFlowAgent({
        flowName: "checkout",
        platform: "web",
        app: makeStubApp(calls1),
        cacheDir,
        executor: {
          async act({ app }) {
            llmCalls += 1;
            await app.tap({ testID: "pay-btn" });
            return { actions: [{ kind: "tap", selector: { testID: "pay-btn" } }] };
          },
        },
        askFn: async ({ kind }) =>
          kind === "verify" ? { passed: true, reason: "Order confirmed" } : { total: 42 },
      });

      const outcome1 = await agent1.act("click pay button");
      expect(outcome1.status).toBe("missed");
      expect(llmCalls).toBe(1);

      const v = await agent1.verify("order confirmation is shown");
      expect(v.passed).toBe(true);
      const data = await agent1.extract<{ total: number }>("order total");
      expect(data.total).toBe(42);
      agent1.finalize(true);

      // Inspect & verify cache on disk
      const inspected = inspectReplayCache(cacheDir);
      expect(inspected.entryCount).toBe(1);
      expect(formatCacheInspectTable(inspected)).toContain("click pay button");

      // Second run in strict mode replays deterministically with ZERO LLM calls
      const calls2: string[] = [];
      const agent2 = createFlowAgent({
        flowName: "checkout",
        platform: "web",
        app: makeStubApp(calls2),
        cacheDir,
        cacheMode: "strict",
      });
      const outcome2 = await agent2.act("click pay button");
      expect(outcome2.status).toBe("replayed");
      expect(calls2).toEqual(['tap:{"testID":"pay-btn"}']);

      // Clear cache via CLI helper
      const cleared = clearReplayCache(cacheDir, { match: "checkout" });
      expect(cleared.removedCount).toBe(1);
      expect(inspectReplayCache(cacheDir).entryCount).toBe(0);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("runExploreSession emits runnable TypeScript .flow.ts code", async () => {
    const calls: string[] = [];
    const res = await runExploreSession({
      goal: "Sign in as demo user",
      app: makeStubApp(calls),
      executor: {
        async act({ app }) {
          await app.tap({ testID: "email" });
          await app.inputText("demo@example.com");
          return {
            actions: [
              { kind: "tap", selector: { testID: "email" } },
              { kind: "inputText", text: "demo@example.com" },
            ],
          };
        },
      },
    });
    expect(res.actions).toHaveLength(2);
    expect(res.flowCode).toContain('import { flow } from "spana-test";');
    expect(res.flowCode).toContain('await app.tap({"testID":"email"});');
    expect(formatActionsAsFlowCode("x", res.actions)).toContain(
      'await app.inputText("demo@example.com");',
    );
  });
});
