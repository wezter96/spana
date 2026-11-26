import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step, suite, withActiveStepRecorder } from "./suite.js";
import { assertDataSnapshot, matchDataSnapshot } from "./snapshots.js";
import type { StepRecorder } from "../core/step-recorder.js";

describe("suite() grouping, nested step() & structured snapshots", () => {
  it("flattens nested suites, merges tags, and runs beforeAll/beforeEach/afterEach/afterAll hooks", async () => {
    const events: string[] = [];
    const flows = suite("Auth", { tags: ["auth"] }, (s) => {
      s.beforeAll(async () => {
        events.push("beforeAll");
      });
      s.beforeEach(async () => {
        events.push("beforeEach");
      });
      s.afterEach(async () => {
        events.push("afterEach");
      });
      s.afterAll(async () => {
        events.push("afterAll");
      });

      s.flow("logs in", { tags: ["smoke"] }, async () => {
        events.push("flow:login");
      });

      s.suite("MFA", { tags: ["mfa"] }, (nested) => {
        nested.flow("verifies totp", async () => {
          events.push("flow:totp");
        });
      });
    });

    expect(flows.map((f) => f.name)).toEqual(["Auth > logs in", "Auth > MFA > verifies totp"]);
    expect(flows[0]?.config.tags).toEqual(["auth", "smoke"]);
    expect(flows[1]?.config.tags).toEqual(["auth", "mfa"]);

    const stubCtx = {} as never;
    for (const f of flows) {
      await f.fn(stubCtx);
    }
    expect(events).toEqual([
      "beforeAll",
      "beforeEach",
      "flow:login",
      "afterEach",
      "beforeEach",
      "flow:totp",
      "afterEach",
      "afterAll",
    ]);
  });

  it("records named step() calls onto the active StepRecorder", async () => {
    const recorded: string[] = [];
    const mockRecorder: StepRecorder = {
      async runStep(command, action) {
        recorded.push(command);
        return action();
      },
      async runScreenshotStep(_command, action) {
        return action();
      },
      getSteps: () => [],
    };

    const value = await withActiveStepRecorder(mockRecorder, async () => {
      return step("Fill billing form", async () => {
        return step("Enter ZIP", async () => 94107);
      });
    });

    expect(value).toBe(94107);
    expect(recorded).toEqual(["step(Fill billing form)", "step(Enter ZIP)"]);
  });

  it("creates, matches, rejects diffs, and updates structured JSON/text snapshots", () => {
    const dir = mkdtempSync(join(tmpdir(), "spana-snaps-"));
    try {
      const created = matchDataSnapshot({ ok: true, count: 3 }, "cart-summary", {
        snapshotsDir: dir,
      });
      expect(created.created).toBe(true);
      expect(created.matched).toBe(true);

      const matched = assertDataSnapshot({ ok: true, count: 3 }, "cart-summary", {
        snapshotsDir: dir,
      });
      expect(matched.matched).toBe(true);
      expect(matched.created).toBe(false);

      expect(() =>
        assertDataSnapshot({ ok: true, count: 4 }, "cart-summary", { snapshotsDir: dir }),
      ).toThrow(/Snapshot "cart-summary" mismatch/);

      const updated = assertDataSnapshot({ ok: true, count: 4 }, "cart-summary", {
        snapshotsDir: dir,
        updateBaselines: true,
      });
      expect(updated.updated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
