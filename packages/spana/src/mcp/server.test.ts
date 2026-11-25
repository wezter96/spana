import { describe, expect, test } from "bun:test";
import { SpanaMcpServer, buildFlowFileFromLines } from "./server.js";
import type { Session } from "../agent/session.js";

function createStubSession(): { session: Session; events: string[] } {
  const events: string[] = [];
  const session = {
    platform: "ios",
    selectors: async () => [
      {
        suggestedSelector: { testID: "sign-in" },
        id: "sign-in",
        text: "Sign In",
        bounds: { x: 10, y: 20, width: 100, height: 40 },
      },
      {
        suggestedSelector: { testID: "profile-id" },
        id: "profile-id",
        text: "user_42",
        bounds: { x: 10, y: 80, width: 100, height: 24 },
      },
    ],
    tap: async (sel: unknown) => {
      events.push(`tap:${JSON.stringify(sel)}`);
    },
    inputText: async (text: string) => {
      events.push(`input:${text}`);
    },
    openLink: async (url: string) => {
      events.push(`open:${url}`);
    },
    screenshot: async () => new Uint8Array([137, 80, 78, 71]),
    getConsoleLogs: async () => [{ type: "error", text: "500 /api/checkout", timestamp: 1 }],
    getJSErrors: async () => [{ message: "TypeError: undefined", timestamp: 2 }],
    disconnect: async () => {
      events.push("disconnect");
    },
  } as unknown as Session;

  return { session, events };
}

describe("Spana stdio MCP server (spana mcp)", () => {
  test("handles initialize, tools/list, live actions, diagnostics, and exports verified .flow.ts", async () => {
    const stub = createStubSession();
    const server = new SpanaMcpServer({
      connectFn: async () => stub.session,
      runFlowFn: async ({ flowPath }) => flowPath.includes("login"),
    });

    const init = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect((init!.result as any).serverInfo.name).toBe("spana-mcp");

    const list = await server.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((list!.result as any).tools.length).toBeGreaterThanOrEqual(10);

    // Start session
    const started = await server.callTool("spana_session_start", { platform: "ios" });
    expect(started.isError).toBeUndefined();

    // Observe screen + inline console/JS error diagnostics
    const obs = await server.callTool("spana_observe", {});
    const obsData = JSON.parse(obs.content[0]!.text!);
    expect(obsData.elementCount).toBe(2);
    expect(obsData.recentConsoleLogs).toHaveLength(1);
    expect(obsData.jsErrors).toHaveLength(1);

    // Tap DOM element & native systemUI sheet
    const tap1 = await server.callTool("spana_tap", { selector: { testID: "sign-in" } });
    expect(JSON.parse(tap1.content[0]!.text!).codeLine).toBe(
      'await app.tap({"testID":"sign-in"});',
    );

    const tap2 = await server.callTool("spana_tap", {
      selector: { text: "Continue", systemUI: true },
    });
    expect(JSON.parse(tap2.content[0]!.text!).codeLine).toBe(
      'await app.tap(systemUI({"text":"Continue"}));',
    );

    // Assert visible
    const assertOk = await server.callTool("spana_assert_visible", {
      selector: { testID: "profile-id" },
    });
    expect(assertOk.isError).toBeUndefined();

    // Assert missing returns actionable error with availableTestIDs
    const assertMiss = await server.callTool("spana_assert_visible", {
      selector: { testID: "missing-el" },
    });
    expect(assertMiss.isError).toBe(true);
    expect(JSON.parse(assertMiss.content[0]!.text!).availableTestIDs).toContain("profile-id");

    // Screenshot returns base64 image block
    const shot = await server.callTool("spana_screenshot", {});
    expect(shot.content[0]!.type).toBe("image");
    expect(shot.content[0]!.mimeType).toBe("image/png");

    // Diagnostics snapshot
    const diag = await server.callTool("spana_diagnostics", {});
    const diagData = JSON.parse(diag.content[0]!.text!);
    expect(diagData.testIDCount).toBe(2);
    expect(diagData.jsErrorCount).toBe(1);

    // Run flow helper
    const runRes = await server.callTool("spana_run_flow", {
      flowPath: "flows/login.flow.ts",
      platform: "web",
    });
    expect(JSON.parse(runRes.content[0]!.text!).passed).toBe(true);

    // Stop session & verify exported TypeScript flow imports systemUI automatically
    const stopped = await server.callTool("spana_session_stop", { flowName: "SSO Sign-In" });
    const stopData = JSON.parse(stopped.content[0]!.text!);
    expect(stopData.stepCount).toBe(3);
    expect(stopData.code).toContain('import { flow, systemUI } from "spana";');
    expect(stopData.code).toContain('await app.tap(systemUI({"text":"Continue"}));');
    expect(stopData.code).toContain('await expect({"testID":"profile-id"}).toBeVisible();');
    expect(stub.events).toContain("disconnect");
  });

  test("buildFlowFileFromLines omits systemUI import when unused", () => {
    const code = buildFlowFileFromLines("simple", ['await app.tap({"testID":"go"});']);
    expect(code).toContain('import { flow } from "spana";');
  });
});
