import { describe, expect, test } from "bun:test";
import { runWithRecoveredSession } from "./inspector.js";

describe("runWithRecoveredSession", () => {
  test("returns the first successful result without resetting the session", async () => {
    let resets = 0;

    const result = await runWithRecoveredSession(
      async () => "ok",
      async () => {
        resets += 1;
      },
    );

    expect(result).toBe("ok");
    expect(resets).toBe(0);
  });

  test("retries once after a stale-session failure", async () => {
    let resets = 0;
    let attempts = 0;

    const result = await runWithRecoveredSession(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("stale session");
        }
        return "recovered";
      },
      async () => {
        resets += 1;
      },
    );

    expect(result).toBe("recovered");
    expect(resets).toBe(1);
  });

  test("resets again and rethrows when the retry also fails", async () => {
    let resets = 0;

    await expect(
      runWithRecoveredSession(
        async () => {
          throw new Error("still broken");
        },
        async () => {
          resets += 1;
        },
      ),
    ).rejects.toThrow("still broken");

    expect(resets).toBe(2);
  });
});
