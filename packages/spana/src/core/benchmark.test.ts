import { describe, expect, test } from "bun:test";
import { formatSignInBenchmarkTable, runAllTargetsSignInBenchmark } from "./benchmark.js";

describe("Sign-in journey benchmark across all 5 targets", () => {
  test("runs UI sign-in vs bridge sign-in across web, android, ios, electron, electrobun", async () => {
    const rows = await runAllTargetsSignInBenchmark(
      ["web", "android", "ios", "electron", "electrobun"],
      0.05,
    );

    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.nativeDumpsBridge).toBe(0);
      expect(row.uiSignInMs).toBeGreaterThanOrEqual(row.bridgeSignInMs);
    }

    const table = formatSignInBenchmarkTable(rows);
    expect(table).toContain("web");
    expect(table).toContain("android");
    expect(table).toContain("ios");
    expect(table).toContain("electron");
    expect(table).toContain("electrobun");
  });
});
