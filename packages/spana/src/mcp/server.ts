import { createInterface } from "node:readline";
import type { ExtendedSelector, Platform } from "../schemas/selector.js";
import type { ConnectOptions, Session } from "../agent/session.js";

/** MCP Tool definition advertised by `tools/list`. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpContentBlock {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface SpanaMcpServerOptions {
  /** Custom session connector (defaults to `connect()` from `agent/session.js`). */
  connectFn?: (opts: ConnectOptions) => Promise<Session>;
  /** Custom flow runner for `spana_run_flow` (defaults to `runTestCommand`). */
  runFlowFn?: (opts: { flowPath: string; platform?: Platform }) => Promise<boolean>;
}

/** Format a Spana selector into clean TypeScript code for verified `.flow.ts` generation. */
export function formatSelectorCode(selector: ExtendedSelector): string {
  if (typeof selector === "string") {
    return JSON.stringify(selector);
  }
  const sel = selector as Record<string, unknown>;
  if (sel.systemUI === true) {
    const rest = { ...sel };
    delete rest.systemUI;
    return `systemUI(${JSON.stringify(rest)})`;
  }
  return JSON.stringify(selector);
}

/** Generate a complete `.flow.ts` file from recorded verified MCP actions. */
export function buildFlowFileFromLines(flowName: string, lines: string[]): string {
  const usesSystemUI = lines.some((l) => l.includes("systemUI("));
  const imports = usesSystemUI
    ? 'import { flow, systemUI } from "spana-test";'
    : 'import { flow } from "spana-test";';
  const body =
    lines.length > 0 ? lines.map((l) => `  ${l}`).join("\n") : "  // Add verified steps here";
  return `${imports}\n\nexport default flow(${JSON.stringify(flowName)}, async ({ app, expect }) => {\n${body}\n});\n`;
}

export const SPANA_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "spana_session_start",
    description:
      "Connect Spana to a live target (web, android, ios, electron, electrobun) and begin recording verified .flow.ts lines.",
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          enum: ["web", "android", "ios", "electron", "electrobun"],
        },
        baseUrl: { type: "string" },
        packageName: { type: "string" },
        bundleId: { type: "string" },
        device: { type: "string" },
        headless: { type: "boolean" },
        cdpUrl: { type: "string" },
      },
      required: ["platform"],
    },
  },
  {
    name: "spana_session_stop",
    description:
      "Disconnect the active Spana session and return the generated .flow.ts file containing every verified step.",
    inputSchema: {
      type: "object",
      properties: {
        flowName: { type: "string" },
      },
    },
  },
  {
    name: "spana_observe",
    description:
      "Inspect the current screen: returns actionable elements with suggested { testID } / systemUI() selectors plus recent console logs and JS errors.",
    inputSchema: {
      type: "object",
      properties: {
        maxElements: { type: "number" },
      },
    },
  },
  {
    name: "spana_tap",
    description:
      "Tap an element via Spana's dual-channel resolver and return the verified `.flow.ts` line.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "object" },
      },
      required: ["selector"],
    },
  },
  {
    name: "spana_input_text",
    description: "Type text into the focused element and return the verified `.flow.ts` line.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    },
  },
  {
    name: "spana_assert_visible",
    description:
      "Verify that an element matching selector is currently visible on screen and return the verified `expect(...)` line.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "object" },
      },
      required: ["selector"],
    },
  },
  {
    name: "spana_open_link",
    description: "Navigate the active target to a URL or deep link and record the verified line.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
    },
  },
  {
    name: "spana_screenshot",
    description: "Capture a live PNG screenshot of the current screen for visual verification.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "spana_diagnostics",
    description:
      "Argent-inspired live runtime diagnostics: returns captured console logs, JS errors, element count, and platform metadata.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "spana_export_flow",
    description:
      "Export all verified actions from the current session as a runnable TypeScript `.flow.ts` file without disconnecting.",
    inputSchema: {
      type: "object",
      properties: {
        flowName: { type: "string" },
      },
    },
  },
  {
    name: "spana_run_flow",
    description:
      "Run an existing `.flow.ts` test file via Spana and return pass/fail status for rapid agent fix-and-verify loops.",
    inputSchema: {
      type: "object",
      properties: {
        flowPath: { type: "string" },
        platform: {
          type: "string",
          enum: ["web", "android", "ios", "electron", "electrobun"],
        },
      },
      required: ["flowPath"],
    },
  },
];

/**
 * Model-free MCP (Model Context Protocol) server for Spana.
 *
 * Lets coding agents (Claude Code, Codex, Cursor, Antigravity) drive live
 * web, iOS, Android, Electron, and Electrobun sessions, inspect unified
 * DOM/native + console/error diagnostics, and receive verified `.flow.ts` lines.
 */
export class SpanaMcpServer {
  private session: Session | null = null;
  private recordedLines: string[] = [];
  private readonly connectFn: (opts: ConnectOptions) => Promise<Session>;
  private readonly runFlowFn: (opts: { flowPath: string; platform?: Platform }) => Promise<boolean>;

  constructor(options: SpanaMcpServerOptions = {}) {
    this.connectFn =
      options.connectFn ??
      (async (opts) => {
        const { connect } = await import("../agent/session.js");
        return connect(opts);
      });
    this.runFlowFn =
      options.runFlowFn ??
      (async ({ flowPath, platform }) => {
        const { runTestCommand } = await import("../cli/test-command.js");
        return runTestCommand({
          flowPath,
          platforms: platform ? [platform] : [],
          quiet: true,
        });
      });
  }

  private requireSession(): Session {
    if (!this.session) {
      throw new Error(
        "No active Spana MCP session. Call `spana_session_start` first with a target platform.",
      );
    }
    return this.session;
  }

  async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;

    // Notifications (no id) get no JSON-RPC response
    if (req.method === "notifications/initialized" || req.id === undefined) {
      return null;
    }

    try {
      switch (req.method) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "spana-mcp", version: "1.0.0" },
            },
          };

        case "ping":
          return { jsonrpc: "2.0", id, result: {} };

        case "tools/list":
          return {
            jsonrpc: "2.0",
            id,
            result: { tools: SPANA_MCP_TOOLS },
          };

        case "tools/call": {
          const name = String(req.params?.["name"] ?? "");
          const args = (req.params?.["arguments"] ?? {}) as Record<string, unknown>;
          const toolResult = await this.callTool(name, args);
          return { jsonrpc: "2.0", id, result: toolResult };
        }

        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${req.method}` },
          };
      }
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    try {
      switch (name) {
        case "spana_session_start": {
          if (this.session) {
            await this.session.disconnect().catch(() => undefined);
            this.session = null;
          }
          const platform = args["platform"] as Platform;
          this.session = await this.connectFn({
            platform,
            baseUrl: args["baseUrl"] as string | undefined,
            packageName: args["packageName"] as string | undefined,
            bundleId: args["bundleId"] as string | undefined,
            device: args["device"] as string | undefined,
            headless: (args["headless"] as boolean | undefined) ?? true,
            cdpUrl: args["cdpUrl"] as string | undefined,
          });
          this.recordedLines = [];
          return this.jsonResult({ connected: true, platform });
        }

        case "spana_session_stop": {
          const flowName = (args["flowName"] as string | undefined) ?? "recorded flow";
          const code = buildFlowFileFromLines(flowName, this.recordedLines);
          if (this.session) {
            await this.session.disconnect().catch(() => undefined);
            this.session = null;
          }
          return this.jsonResult({
            disconnected: true,
            stepCount: this.recordedLines.length,
            code,
          });
        }

        case "spana_observe": {
          const session = this.requireSession();
          const maxElements = (args["maxElements"] as number | undefined) ?? 60;
          const elements = (await session.selectors()).slice(0, maxElements);
          const consoleLogs = await session.getConsoleLogs().catch(() => []);
          const jsErrors = await session.getJSErrors().catch(() => []);
          return this.jsonResult({
            platform: session.platform,
            elementCount: elements.length,
            elements,
            recentConsoleLogs: consoleLogs.slice(-15),
            jsErrors: jsErrors.slice(-10),
          });
        }

        case "spana_tap": {
          const session = this.requireSession();
          const selector = args["selector"] as ExtendedSelector;
          await session.tap(selector);
          const codeLine = `await app.tap(${formatSelectorCode(selector)});`;
          this.recordedLines.push(codeLine);
          return this.jsonResult({ ok: true, codeLine });
        }

        case "spana_input_text": {
          const session = this.requireSession();
          const text = String(args["text"] ?? "");
          await session.inputText(text);
          const codeLine = `await app.inputText(${JSON.stringify(text)});`;
          this.recordedLines.push(codeLine);
          return this.jsonResult({ ok: true, codeLine });
        }

        case "spana_assert_visible": {
          const session = this.requireSession();
          const selector = args["selector"] as ExtendedSelector;
          const elements = await session.selectors();
          const sel = selector as Record<string, unknown>;
          const matched = elements.some((el) => {
            if (typeof sel["testID"] === "string") return el.id === sel["testID"];
            if (typeof sel["text"] === "string") return el.text?.includes(sel["text"]);
            if (typeof sel["accessibilityLabel"] === "string") {
              return el.accessibilityLabel === sel["accessibilityLabel"];
            }
            return false;
          });
          if (!matched) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: false,
                    message: `Element not visible: ${formatSelectorCode(selector)}`,
                    availableTestIDs: elements
                      .map((e) => e.id)
                      .filter(Boolean)
                      .slice(0, 20),
                  }),
                },
              ],
            };
          }
          const codeLine = `await expect(${formatSelectorCode(selector)}).toBeVisible();`;
          this.recordedLines.push(codeLine);
          return this.jsonResult({ ok: true, codeLine });
        }

        case "spana_open_link": {
          const session = this.requireSession();
          const url = String(args["url"] ?? "");
          await session.openLink(url);
          const codeLine = `await app.openLink(${JSON.stringify(url)});`;
          this.recordedLines.push(codeLine);
          return this.jsonResult({ ok: true, codeLine });
        }

        case "spana_screenshot": {
          const session = this.requireSession();
          const png = await session.screenshot();
          return {
            content: [
              {
                type: "image",
                data: Buffer.from(png).toString("base64"),
                mimeType: "image/png",
              },
            ],
          };
        }

        case "spana_diagnostics": {
          const session = this.requireSession();
          const [elements, consoleLogs, jsErrors] = await Promise.all([
            session.selectors().catch(() => []),
            session.getConsoleLogs().catch(() => []),
            session.getJSErrors().catch(() => []),
          ]);
          return this.jsonResult({
            platform: session.platform,
            actionableElements: elements.length,
            testIDCount: elements.filter((e) => Boolean(e.id)).length,
            consoleLogCount: consoleLogs.length,
            consoleLogs: consoleLogs.slice(-25),
            jsErrorCount: jsErrors.length,
            jsErrors: jsErrors.slice(-15),
          });
        }

        case "spana_export_flow": {
          const flowName = (args["flowName"] as string | undefined) ?? "recorded flow";
          return this.jsonResult({
            flowName,
            stepCount: this.recordedLines.length,
            code: buildFlowFileFromLines(flowName, this.recordedLines),
          });
        }

        case "spana_run_flow": {
          const flowPath = String(args["flowPath"] ?? "");
          const platform = args["platform"] as Platform | undefined;
          const passed = await this.runFlowFn({ flowPath, platform });
          return this.jsonResult({ flowPath, platform: platform ?? "default", passed });
        }

        default:
          return {
            isError: true,
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
          };
      }
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    }
  }

  private jsonResult(payload: unknown): McpToolResult {
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    };
  }

  /** Run the server over newline-delimited JSON-RPC stdio until stdin closes. */
  async runStdio(): Promise<void> {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const req = JSON.parse(trimmed) as JsonRpcRequest;
        const res = await this.handleRequest(req);
        if (res) {
          process.stdout.write(`${JSON.stringify(res)}\n`);
        }
      } catch (err) {
        const parseErr: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: err instanceof Error ? err.message : "Parse error",
          },
        };
        process.stdout.write(`${JSON.stringify(parseErr)}\n`);
      }
    }
    if (this.session) {
      await this.session.disconnect().catch(() => undefined);
      this.session = null;
    }
  }
}
