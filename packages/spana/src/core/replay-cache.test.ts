import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ReplayCacheStore,
  ReplaySession,
  buildReplayCacheKey,
  type AgentActExecutor,
} from "./replay-cache.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempStore(): ReplayCacheStore {
  const dir = mkdtempSync(join(tmpdir(), "spana-replay-cache-"));
  tempDirs.push(dir);
  return new ReplayCacheStore(dir);
}

describe("Verified Replay Cache (.spana/cache) & --strict-cache", () => {
  test("saves recording only after markVerified(), then replays with zero executor calls", async () => {
    const store = makeTempStore();
    const tapped: unknown[] = [];
    let executorCalls = 0;

    const fakeApp = {
      tap: async (sel: unknown) => {
        tapped.push(sel);
      },
    } as any;

    const executor: AgentActExecutor = {
      async act({ app }) {
        executorCalls++;
        await app.tap({ testID: "upgrade-pro" });
        return { actions: [{ kind: "tap", selector: { testID: "upgrade-pro" } }] };
      },
    };

    // Run 1: miss -> unconfirmed until markVerified()
    const run1 = new ReplaySession({
      flowName: "upgrade to pro",
      platform: "web",
      app: fakeApp,
      store,
      mode: "read-write",
      executor,
    });
    const out1 = await run1.act("upgrade workspace to Pro");
    expect(out1.status).toBe("missed");
    expect(out1.writeStatus).toBe("unconfirmed");

    const key = buildReplayCacheKey("upgrade to pro", "web", "upgrade workspace to Pro");
    expect(store.get(key)).toBeNull(); // not saved before verification!

    expect(run1.markVerified("toBeVisible")).toBe(1);
    expect(store.get(key)?.actions).toHaveLength(1);
    expect(executorCalls).toBe(1);

    // Run 2 (strict CI mode, no executor): replays deterministically with 0 LLM calls
    const run2 = new ReplaySession({
      flowName: "upgrade to pro",
      platform: "web",
      app: fakeApp,
      store,
      mode: "strict",
    });
    const out2 = await run2.act("upgrade workspace to Pro");
    expect(out2.status).toBe("replayed");
    expect(executorCalls).toBe(1);
    expect(tapped).toEqual([{ testID: "upgrade-pro" }, { testID: "upgrade-pro" }]);
  });

  test("strict mode fails deterministically on mismatch; read-write mode self-heals and evicts on failure", async () => {
    const store = makeTempStore();
    const key = buildReplayCacheKey("checkout", "ios", "submit payment");
    store.set({
      schemaVersion: 1,
      key,
      goal: "submit payment",
      flowName: "checkout",
      platform: "ios",
      actions: [{ kind: "tap", selector: { testID: "old-pay-btn" } }],
      recordedAt: new Date().toISOString(),
      verifiedBy: "toBeVisible",
    });

    const failingOldBtnApp = {
      tap: async (sel: any) => {
        if (sel.testID === "old-pay-btn") throw new Error("Element not found: old-pay-btn");
      },
    } as any;

    // Strict mode throws without invoking any LLM
    const strictRun = new ReplaySession({
      flowName: "checkout",
      platform: "ios",
      app: failingOldBtnApp,
      store,
      mode: "strict",
    });
    await expect(strictRun.act("submit payment")).rejects.toThrow("Strict replay cache mismatch");

    // Read-write mode hands off to executor, heals, and updates cache on markVerified()
    const healRun = new ReplaySession({
      flowName: "checkout",
      platform: "ios",
      app: failingOldBtnApp,
      store,
      mode: "read-write",
      executor: {
        async act({ app, handoffReason }) {
          expect(handoffReason).toContain("old-pay-btn");
          await app.tap({ testID: "new-pay-btn" });
          return { actions: [{ kind: "tap", selector: { testID: "new-pay-btn" } }] };
        },
      },
    });
    const healed = await healRun.act("submit payment");
    expect(healed.status).toBe("handed-off");
    healRun.markVerified("toContainText");
    expect(store.get(key)?.actions).toEqual([{ kind: "tap", selector: { testID: "new-pay-btn" } }]);

    // If a subsequent replay fails downstream assertion, markFailed() evicts the stale entry
    const brokenRun = new ReplaySession({
      flowName: "checkout",
      platform: "ios",
      app: failingOldBtnApp,
      store,
      mode: "read-write",
    });
    await brokenRun.act("submit payment");
    expect(brokenRun.markFailed()).toBe(1);
    expect(store.get(key)).toBeNull();
  });
});
