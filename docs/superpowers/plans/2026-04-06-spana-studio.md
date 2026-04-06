# Spana Studio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local web UI (`spana studio`) with Element Inspector and Test Runner Dashboard, served as embedded static files in the `spana-test` npm package.

**Architecture:** Functional core / imperative shell. Effect services wrap existing spana drivers and session logic. oRPC provides type-safe API with WebSocket for real-time features. React 18 + Tailwind + shadcn/ui frontend built with Vite, embedded in the npm package at build time.

**Tech Stack:** TypeScript, Effect, oRPC (v1.12+), Hono, React 18, Vite, Tailwind CSS, shadcn/ui, TanStack Query, WebSocket

---

## File Map

| Task                       | Create                                                                                                                                                 | Modify                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 1. Studio backend scaffold | `packages/spana/src/studio/context.ts`, `effect-handler.ts`, `api.ts`, `server.ts`                                                                     | `packages/spana/package.json`                                  |
| 2. CLI command             | `packages/spana/src/cli/studio-command.ts`                                                                                                             | `packages/spana/src/cli/index.ts`                              |
| 3. Device router           | `packages/spana/src/studio/routers/devices.ts`                                                                                                         | `packages/spana/src/studio/api.ts`                             |
| 4. Inspector router        | `packages/spana/src/studio/routers/inspector.ts`, `packages/spana/src/studio/core/element-tree.ts`                                                     | `packages/spana/src/studio/api.ts`                             |
| 5. Test runner router      | `packages/spana/src/studio/routers/tests.ts`                                                                                                           | `packages/spana/src/studio/api.ts`                             |
| 6. Frontend scaffold       | `apps/studio/` (package.json, vite.config.ts, index.html, src/)                                                                                        | `turbo.json`, root `package.json`                              |
| 7. oRPC client + layout    | `apps/studio/src/lib/client.ts`, `src/App.tsx`, `src/layouts/`                                                                                         | —                                                              |
| 8. Element Inspector UI    | `apps/studio/src/pages/inspector.tsx`, `src/components/device-screenshot.tsx`, `src/components/element-details.tsx`, `src/components/element-tree.tsx` | —                                                              |
| 9. Test Runner UI          | `apps/studio/src/pages/runner.tsx`, `src/components/flow-list.tsx`, `src/components/run-progress.tsx`, `src/components/failure-details.tsx`            | —                                                              |
| 10. Build pipeline         | `apps/studio/build-embed.ts`                                                                                                                           | `packages/spana/tsup.config.ts`, `packages/spana/package.json` |

All paths relative to `/Users/anton/.superset/projects/spana/`.

---

### Task 1: Studio Backend Scaffold (oRPC + Effect)

Set up the oRPC server with Effect runtime, following far-aida-coach's pattern. No routes yet — just the infrastructure.

**Files:**

- Create: `packages/spana/src/studio/context.ts`
- Create: `packages/spana/src/studio/effect-handler.ts`
- Create: `packages/spana/src/studio/api.ts`
- Create: `packages/spana/src/studio/server.ts`
- Modify: `packages/spana/package.json` (add dependencies)

- [ ] **Step 1: Add oRPC and Hono dependencies**

```bash
cd packages/spana && bun add @orpc/server @orpc/client @orpc/zod hono zod
```

- [ ] **Step 2: Create the Effect-to-oRPC bridge**

```typescript
// packages/spana/src/studio/effect-handler.ts
import { Cause, Effect, Exit, type ManagedRuntime, type Scope } from "effect";
import { ORPCError } from "@orpc/server";

export const runEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R | Scope.Scope>,
  runtime: ManagedRuntime.ManagedRuntime<R, any>,
): Promise<A> =>
  runtime.runPromiseExit(Effect.scoped(effect)).then((exit) => {
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }

    if (Cause.isFailType(exit.cause)) {
      const error = exit.cause.error;
      if (error instanceof ORPCError) {
        throw error;
      }
    }

    if (Cause.isDieType(exit.cause)) {
      const defect = exit.cause.defect;
      if (defect instanceof ORPCError) {
        throw defect;
      }
    }

    throw new ORPCError("INTERNAL_SERVER_ERROR");
  });
```

- [ ] **Step 3: Create the request context**

```typescript
// packages/spana/src/studio/context.ts
import type { ManagedRuntime } from "effect";

export type StudioContext = {
  runtime: ManagedRuntime.ManagedRuntime<any, any>;
};
```

- [ ] **Step 4: Create the oRPC procedure builder**

```typescript
// packages/spana/src/studio/api.ts
import { os } from "@orpc/server";
import type { StudioContext } from "./context.js";

export const o = os.$context<StudioContext>();
export const publicProcedure = o;

export const studioRouter = {};
export type StudioRouter = typeof studioRouter;
```

- [ ] **Step 5: Create the Hono server with static file serving and oRPC handler**

```typescript
// packages/spana/src/studio/server.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ManagedRuntime, Layer } from "effect";
import { studioRouter } from "./api.js";
import type { StudioContext } from "./context.js";
import type { ProvConfig } from "../schemas/config.js";

export interface StudioOptions {
  port: number;
  open: boolean;
  config: ProvConfig;
  staticDir?: string;
}

export async function startStudio(options: StudioOptions) {
  const { port, open, config, staticDir } = options;
  const app = new Hono();

  // Build Effect runtime (empty layer for now, services added in later tasks)
  const StudioLayer = Layer.empty;
  const runtime = ManagedRuntime.make(StudioLayer);

  const rpcHandler = new RPCHandler(studioRouter, {
    interceptors: [
      onError((error) => {
        console.error("[studio]", error);
      }),
    ],
  });

  app.use("/*", cors({ origin: `http://localhost:${port}` }));

  // oRPC handler
  app.use("/rpc/*", async (c) => {
    const context: StudioContext = { runtime };
    const result = await rpcHandler.handle(c.req.raw, {
      prefix: "/rpc",
      context,
    });
    if (result.matched) {
      return c.newResponse(result.response.body, result.response);
    }
    return c.notFound();
  });

  // Serve embedded frontend (static files)
  if (staticDir) {
    app.use("/*", serveStatic({ root: staticDir }));
    // SPA fallback: serve index.html for non-API routes
    app.get("/*", serveStatic({ root: staticDir, path: "index.html" }));
  }

  const server = Bun.serve({ port, fetch: app.fetch });

  console.log(`\n  Spana Studio running at http://localhost:${port}\n`);

  if (open) {
    const { exec } = await import("node:child_process");
    const cmd =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${cmd} http://localhost:${port}`);
  }

  return server;
}
```

- [ ] **Step 6: Verify it compiles**

Run: `cd packages/spana && bun run build`

Expected: Build succeeds with no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/spana/src/studio/ packages/spana/package.json
git commit -m "feat(studio): scaffold oRPC + Effect backend with Hono server"
```

---

### Task 2: CLI Command (`spana studio`)

Add the `studio` command to the CLI entry point.

**Files:**

- Create: `packages/spana/src/cli/studio-command.ts`
- Modify: `packages/spana/src/cli/index.ts`

- [ ] **Step 1: Create the studio command handler**

```typescript
// packages/spana/src/cli/studio-command.ts
import type { ProvConfig } from "../schemas/config.js";

export interface StudioCliOptions {
  port: number;
  open: boolean;
  config: ProvConfig;
}

export async function runStudioCommand(options: StudioCliOptions) {
  const { startStudio } = await import("../studio/server.js");

  const staticDir = new URL("../../studio-dist", import.meta.url).pathname;
  const { existsSync } = await import("node:fs");

  await startStudio({
    port: options.port,
    open: options.open,
    config: options.config,
    staticDir: existsSync(staticDir) ? staticDir : undefined,
  });

  // Keep process alive
  await new Promise(() => {});
}
```

- [ ] **Step 2: Add `studio` to the CLI router**

In `packages/spana/src/cli/index.ts`, add the studio command alongside the existing commands. Find the command routing section (the if/else block that matches `process.argv`) and add:

```typescript
if (command === "studio") {
  const port = Number(getFlag("--port") ?? "4400");
  const noOpen = hasFlag("--no-open");
  const { runStudioCommand } = await import("./studio-command.js");
  await runStudioCommand({ port, open: !noOpen, config });
}
```

Also add to the help text:

```
  studio                  Open Spana Studio in the browser
```

- [ ] **Step 3: Build and test the command**

```bash
cd packages/spana && bun run build
node dist/cli.js studio --no-open &
sleep 2
curl -s http://localhost:4400/rpc -X POST -H 'Content-Type: application/json' -d '{}' | head -c 200
kill %1
```

Expected: Server starts, curl gets a response (even if error — confirms server is running).

- [ ] **Step 4: Commit**

```bash
git add packages/spana/src/cli/studio-command.ts packages/spana/src/cli/index.ts
git commit -m "feat(studio): add 'spana studio' CLI command"
```

---

### Task 3: Devices Router

Expose device discovery via oRPC so the frontend can list and select devices.

**Files:**

- Create: `packages/spana/src/studio/routers/devices.ts`
- Modify: `packages/spana/src/studio/api.ts`

- [ ] **Step 1: Write the devices router**

```typescript
// packages/spana/src/studio/routers/devices.ts
import { z } from "zod";
import { publicProcedure } from "../api.js";
import { discoverDevices } from "../../device/discover.js";
import type { Platform } from "../../schemas/selector.js";

export const devicesRouter = {
  list: publicProcedure
    .input(
      z
        .object({
          platforms: z.array(z.enum(["web", "android", "ios"])).optional(),
        })
        .optional(),
    )
    .handler(async ({ input }) => {
      const platforms: Platform[] = input?.platforms ?? ["web", "android", "ios"];
      const devices = discoverDevices(platforms);
      return devices;
    }),
};
```

- [ ] **Step 2: Register the router**

Update `packages/spana/src/studio/api.ts`:

```typescript
import { os } from "@orpc/server";
import type { StudioContext } from "./context.js";
import { devicesRouter } from "./routers/devices.js";

export const o = os.$context<StudioContext>();
export const publicProcedure = o;

export const studioRouter = {
  devices: devicesRouter,
};
export type StudioRouter = typeof studioRouter;
```

- [ ] **Step 3: Build and verify**

```bash
cd packages/spana && bun run build
```

Expected: Compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add packages/spana/src/studio/routers/devices.ts packages/spana/src/studio/api.ts
git commit -m "feat(studio): add devices router for device discovery"
```

---

### Task 4: Inspector Router + Pure Core

Element inspection: screenshots, hierarchy, and suggested selectors. The pure core handles element tree operations; the router wraps the existing `Session` API.

**Files:**

- Create: `packages/spana/src/studio/core/element-tree.ts`
- Create: `packages/spana/src/studio/core/element-tree.test.ts`
- Create: `packages/spana/src/studio/routers/inspector.ts`
- Modify: `packages/spana/src/studio/api.ts`
- Modify: `packages/spana/src/studio/server.ts`

- [ ] **Step 1: Write the pure element tree functions with tests**

```typescript
// packages/spana/src/studio/core/element-tree.ts
import type { Element } from "../../schemas/element.js";

export interface FlatElement {
  element: Element;
  depth: number;
  path: number[];
}

/** Flatten an Element tree into a list with depth and path info. */
export function flattenTree(root: Element, depth = 0, path: number[] = []): FlatElement[] {
  const result: FlatElement[] = [{ element: root, depth, path }];
  if (root.children) {
    for (let i = 0; i < root.children.length; i++) {
      result.push(...flattenTree(root.children[i], depth + 1, [...path, i]));
    }
  }
  return result;
}

/** Find an element by path indices in the tree. */
export function getElementByPath(root: Element, path: number[]): Element | undefined {
  let current = root;
  for (const index of path) {
    if (!current.children?.[index]) return undefined;
    current = current.children[index];
  }
  return current;
}

/** Find elements whose bounds contain the given point. Returns deepest match first. */
export function elementsAtPoint(root: Element, x: number, y: number): FlatElement[] {
  return flattenTree(root)
    .filter(({ element: el }) => {
      if (!el.bounds) return false;
      const { x: bx, y: by, width, height } = el.bounds;
      return x >= bx && x <= bx + width && y >= by && y <= by + height;
    })
    .reverse(); // deepest first
}

/** Search elements by text, testID, or type (case-insensitive substring). */
export function searchElements(root: Element, query: string): FlatElement[] {
  const q = query.toLowerCase();
  return flattenTree(root).filter(({ element: el }) => {
    return (
      el.text?.toLowerCase().includes(q) ||
      el.testID?.toLowerCase().includes(q) ||
      el.accessibilityLabel?.toLowerCase().includes(q) ||
      el.type?.toLowerCase().includes(q)
    );
  });
}
```

- [ ] **Step 2: Write tests for the pure functions**

```typescript
// packages/spana/src/studio/core/element-tree.test.ts
import { describe, it, expect } from "bun:test";
import { flattenTree, getElementByPath, elementsAtPoint, searchElements } from "./element-tree.js";

const mockTree = {
  type: "View",
  bounds: { x: 0, y: 0, width: 1080, height: 1920 },
  children: [
    {
      type: "ScrollView",
      bounds: { x: 0, y: 0, width: 1080, height: 1920 },
      children: [
        {
          type: "Button",
          testID: "login-btn",
          text: "Sign In",
          bounds: { x: 100, y: 800, width: 200, height: 60 },
        },
        {
          type: "Text",
          text: "Welcome",
          bounds: { x: 100, y: 400, width: 300, height: 40 },
        },
      ],
    },
  ],
};

describe("flattenTree", () => {
  it("returns all elements with depth and path", () => {
    const flat = flattenTree(mockTree);
    expect(flat).toHaveLength(4);
    expect(flat[0].depth).toBe(0);
    expect(flat[0].path).toEqual([]);
    expect(flat[2].depth).toBe(2);
    expect(flat[2].path).toEqual([0, 0]);
    expect(flat[2].element.testID).toBe("login-btn");
  });
});

describe("getElementByPath", () => {
  it("finds element by path", () => {
    const el = getElementByPath(mockTree, [0, 0]);
    expect(el?.testID).toBe("login-btn");
  });

  it("returns undefined for invalid path", () => {
    expect(getElementByPath(mockTree, [5, 0])).toBeUndefined();
  });
});

describe("elementsAtPoint", () => {
  it("returns elements at coordinate, deepest first", () => {
    const hits = elementsAtPoint(mockTree, 150, 820);
    expect(hits[0].element.testID).toBe("login-btn");
    expect(hits.length).toBeGreaterThanOrEqual(2); // button + scrollview + view
  });

  it("returns empty for point outside all elements", () => {
    expect(elementsAtPoint(mockTree, 5000, 5000)).toHaveLength(0);
  });
});

describe("searchElements", () => {
  it("finds by testID", () => {
    const results = searchElements(mockTree, "login");
    expect(results).toHaveLength(1);
    expect(results[0].element.testID).toBe("login-btn");
  });

  it("finds by text", () => {
    const results = searchElements(mockTree, "welcome");
    expect(results).toHaveLength(1);
  });

  it("is case-insensitive", () => {
    expect(searchElements(mockTree, "SIGN IN")).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the tests**

```bash
cd packages/spana && bun test src/studio/core/element-tree.test.ts
```

Expected: All tests pass.

- [ ] **Step 4: Write the inspector router**

This wraps the existing `Session` class from `src/agent/session.ts`.

```typescript
// packages/spana/src/studio/routers/inspector.ts
import { z } from "zod";
import { publicProcedure } from "../api.js";
import { Session, type ConnectOptions } from "../../agent/session.js";
import type { Platform } from "../../schemas/selector.js";

// Session cache: one session per platform+device combo
const sessions = new Map<string, Session>();

async function getOrCreateSession(platform: Platform, deviceId?: string): Promise<Session> {
  const key = `${platform}:${deviceId ?? "default"}`;
  const existing = sessions.get(key);
  if (existing) return existing;

  const opts: ConnectOptions = {
    platform,
    device: deviceId,
    headless: platform === "web" ? false : undefined,
  };
  const session = new Session();
  await session.connect(opts);
  sessions.set(key, session);
  return session;
}

export const inspectorRouter = {
  screenshot: publicProcedure
    .input(
      z.object({
        platform: z.enum(["web", "android", "ios"]),
        deviceId: z.string().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const session = await getOrCreateSession(input.platform, input.deviceId);
      const png = await session.screenshot();
      return { image: Buffer.from(png).toString("base64") };
    }),

  hierarchy: publicProcedure
    .input(
      z.object({
        platform: z.enum(["web", "android", "ios"]),
        deviceId: z.string().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const session = await getOrCreateSession(input.platform, input.deviceId);
      return session.hierarchy();
    }),

  selectors: publicProcedure
    .input(
      z.object({
        platform: z.enum(["web", "android", "ios"]),
        deviceId: z.string().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const session = await getOrCreateSession(input.platform, input.deviceId);
      return session.selectors();
    }),

  disconnect: publicProcedure
    .input(
      z.object({
        platform: z.enum(["web", "android", "ios"]),
        deviceId: z.string().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const key = `${input.platform}:${input.deviceId ?? "default"}`;
      const session = sessions.get(key);
      if (session) {
        await session.disconnect();
        sessions.delete(key);
      }
      return { ok: true };
    }),
};
```

- [ ] **Step 5: Register the inspector router**

Update `packages/spana/src/studio/api.ts`:

```typescript
import { os } from "@orpc/server";
import type { StudioContext } from "./context.js";
import { devicesRouter } from "./routers/devices.js";
import { inspectorRouter } from "./routers/inspector.js";

export const o = os.$context<StudioContext>();
export const publicProcedure = o;

export const studioRouter = {
  devices: devicesRouter,
  inspector: inspectorRouter,
};
export type StudioRouter = typeof studioRouter;
```

- [ ] **Step 6: Build and verify**

```bash
cd packages/spana && bun run build
```

Expected: Compiles without errors.

- [ ] **Step 7: Commit**

```bash
git add packages/spana/src/studio/core/ packages/spana/src/studio/routers/inspector.ts packages/spana/src/studio/api.ts
git commit -m "feat(studio): add inspector router with element tree core functions"
```

---

### Task 5: Tests Router

Expose flow discovery, test execution, and results via oRPC. Uses existing test-command internals.

**Files:**

- Create: `packages/spana/src/studio/routers/tests.ts`
- Modify: `packages/spana/src/studio/api.ts`

- [ ] **Step 1: Write the tests router**

```typescript
// packages/spana/src/studio/routers/tests.ts
import { z } from "zod";
import { publicProcedure } from "../api.js";
import { discoverFlows, loadTestSource, filterFlows } from "../../core/runner.js";
import type { FlowDefinition } from "../../api/flow.js";
import type { Platform } from "../../schemas/selector.js";
import type { RunSummary, FlowResult } from "../../report/types.js";

interface ActiveRun {
  id: string;
  status: "running" | "completed";
  results: FlowResult[];
  summary?: RunSummary;
}

const activeRuns = new Map<string, ActiveRun>();

export const testsRouter = {
  listFlows: publicProcedure
    .input(
      z
        .object({
          flowDir: z.string().optional(),
          tags: z.array(z.string()).optional(),
          platforms: z.array(z.enum(["web", "android", "ios"])).optional(),
          grep: z.string().optional(),
        })
        .optional(),
    )
    .handler(async ({ input, context }) => {
      const flowDir = input?.flowDir ?? "./flows";
      const paths = await discoverFlows(flowDir);
      const allFlows: FlowDefinition[] = [];
      for (const p of paths) {
        const loaded = await loadTestSource(p);
        allFlows.push(...loaded);
      }
      const filtered = filterFlows(allFlows, {
        tags: input?.tags,
        grep: input?.grep,
        platforms: input?.platforms,
      });
      return filtered.map((f) => ({
        name: f.name,
        tags: f.config.tags ?? [],
        platforms: f.config.platforms ?? ["web", "android", "ios"],
        path: (f as any)._sourcePath,
      }));
    }),

  run: publicProcedure
    .input(
      z.object({
        flowDir: z.string().optional(),
        platforms: z.array(z.enum(["web", "android", "ios"])),
        tags: z.array(z.string()).optional(),
        grep: z.string().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const runId = crypto.randomUUID();
      const run: ActiveRun = { id: runId, status: "running", results: [] };
      activeRuns.set(runId, run);

      // Import orchestration dynamically to avoid circular deps
      const { executeTestRun } = await import("../../cli/test-command.js");

      // Run in background — results stream into activeRun
      executeTestRun({
        flowDir: input.flowDir ?? "./flows",
        platforms: input.platforms as Platform[],
        tags: input.tags,
        grep: input.grep,
        onFlowResult: (result: FlowResult) => {
          run.results.push(result);
        },
        onComplete: (summary: RunSummary) => {
          run.summary = summary;
          run.status = "completed";
        },
      }).catch((err) => {
        run.status = "completed";
        run.summary = {
          total: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          durationMs: 0,
          results: [],
          platforms: [],
        };
      });

      return { runId };
    }),

  status: publicProcedure.input(z.object({ runId: z.string() })).handler(async ({ input }) => {
    const run = activeRuns.get(input.runId);
    if (!run) return { status: "not_found" as const, results: [] };
    return {
      status: run.status,
      results: run.results,
      summary: run.summary,
    };
  }),

  results: publicProcedure.input(z.object({ runId: z.string() })).handler(async ({ input }) => {
    const run = activeRuns.get(input.runId);
    if (!run?.summary) return null;
    return run.summary;
  }),
};
```

**Note:** The `executeTestRun` function will need a small refactor of `test-command.ts` to expose a callable function with callbacks instead of the current CLI-only entrypoint. This is a modification we handle within this step — extract the core test execution logic into a function that accepts `onFlowResult` and `onComplete` callbacks. The exact shape depends on the current `test-command.ts` internals; the implementer should read that file and extract the orchestration into a reusable function.

- [ ] **Step 2: Register the tests router**

Update `packages/spana/src/studio/api.ts`:

```typescript
import { os } from "@orpc/server";
import type { StudioContext } from "./context.js";
import { devicesRouter } from "./routers/devices.js";
import { inspectorRouter } from "./routers/inspector.js";
import { testsRouter } from "./routers/tests.js";

export const o = os.$context<StudioContext>();
export const publicProcedure = o;

export const studioRouter = {
  devices: devicesRouter,
  inspector: inspectorRouter,
  tests: testsRouter,
};
export type StudioRouter = typeof studioRouter;
```

- [ ] **Step 3: Build and verify**

```bash
cd packages/spana && bun run build
```

Expected: Compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add packages/spana/src/studio/routers/tests.ts packages/spana/src/studio/api.ts
git commit -m "feat(studio): add tests router for flow discovery and execution"
```

---

### Task 6: Frontend Scaffold

Set up the React + Vite + Tailwind + shadcn/ui app in `apps/studio/`.

**Files:**

- Create: `apps/studio/package.json`
- Create: `apps/studio/vite.config.ts`
- Create: `apps/studio/index.html`
- Create: `apps/studio/tsconfig.json`
- Create: `apps/studio/src/main.tsx`
- Create: `apps/studio/src/index.css`
- Modify: root `package.json` (workspaces already include `apps/*`)
- Modify: `turbo.json` (no changes needed — `apps/*` already covered)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@spana/studio",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "check-types": "tsc --noEmit"
  },
  "dependencies": {
    "@orpc/client": "^1.12.2",
    "@orpc/tanstack-query": "^1.12.2",
    "@tanstack/react-query": "^5.75.0",
    "lucide-react": "^0.511.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "sonner": "^2.0.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "tailwindcss": "^4.1.0",
    "typescript": "^5.8.0",
    "vite": "^6.3.0",
    "@vitejs/plugin-react": "^4.4.0"
  }
}
```

- [ ] **Step 2: Create vite.config.ts**

```typescript
// apps/studio/vite.config.ts
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 4401,
    proxy: {
      "/rpc": "http://localhost:4400",
    },
  },
  build: {
    outDir: "dist",
  },
});
```

- [ ] **Step 3: Create index.html**

```html
<!-- apps/studio/index.html -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Spana Studio</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Create index.css with Tailwind**

```css
/* apps/studio/src/index.css */
@import "tailwindcss";
```

- [ ] **Step 6: Create main.tsx entry point**

```tsx
// apps/studio/src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

function App() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
      <h1 className="text-2xl font-bold">Spana Studio</h1>
      <p className="text-zinc-400 mt-2">Element Inspector and Test Runner</p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 7: Install dependencies**

```bash
cd apps/studio && bun install
```

- [ ] **Step 8: Verify dev server starts**

```bash
cd apps/studio && bun run dev &
sleep 3
curl -s http://localhost:4401 | head -c 200
kill %1
```

Expected: HTML response with "Spana Studio" in the output.

- [ ] **Step 9: Commit**

```bash
git add apps/studio/
git commit -m "feat(studio): scaffold React + Vite + Tailwind frontend app"
```

---

### Task 7: oRPC Client + App Layout

Set up the type-safe oRPC client and the main app layout with navigation between Inspector and Runner pages.

**Files:**

- Create: `apps/studio/src/lib/client.ts`
- Create: `apps/studio/src/lib/query.ts`
- Modify: `apps/studio/src/main.tsx`

- [ ] **Step 1: Create the oRPC client**

```typescript
// apps/studio/src/lib/client.ts
import type { StudioRouter } from "../../../packages/spana/src/studio/api.js";
import type { RouterClient } from "@orpc/server";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

const link = new RPCLink({
  url: "/rpc",
});

export const client: RouterClient<StudioRouter> = createORPCClient(link);
export const orpc = createTanstackQueryUtils(client);
```

- [ ] **Step 2: Create query client**

```typescript
// apps/studio/src/lib/query.ts
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 5_000,
    },
  },
});
```

- [ ] **Step 3: Update main.tsx with layout and routing**

```tsx
// apps/studio/src/main.tsx
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/query";
import { Toaster } from "sonner";
import "./index.css";

type Page = "inspector" | "runner";

function App() {
  const [page, setPage] = useState<Page>("inspector");

  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
        {/* Header */}
        <header className="border-b border-zinc-800 px-6 py-3 flex items-center gap-6">
          <h1 className="text-lg font-bold">Spana Studio</h1>
          <nav className="flex gap-1">
            <button
              onClick={() => setPage("inspector")}
              className={`px-3 py-1.5 rounded text-sm ${
                page === "inspector"
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Inspector
            </button>
            <button
              onClick={() => setPage("runner")}
              className={`px-3 py-1.5 rounded text-sm ${
                page === "runner"
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Test Runner
            </button>
          </nav>
        </header>

        {/* Content */}
        <main className="flex-1 p-6">
          {page === "inspector" && <div>Inspector (coming next)</div>}
          {page === "runner" && <div>Test Runner (coming next)</div>}
        </main>
      </div>
      <Toaster theme="dark" />
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 4: Verify it builds**

```bash
cd apps/studio && bun run build
```

Expected: Build succeeds, output in `apps/studio/dist/`.

- [ ] **Step 5: Commit**

```bash
git add apps/studio/src/lib/ apps/studio/src/main.tsx
git commit -m "feat(studio): add oRPC client, query provider, and app layout"
```

---

### Task 8: Element Inspector UI

Build the inspector page with live screenshot, element details panel, and element tree.

**Files:**

- Create: `apps/studio/src/pages/inspector.tsx`
- Create: `apps/studio/src/components/device-screenshot.tsx`
- Create: `apps/studio/src/components/element-details.tsx`
- Create: `apps/studio/src/components/element-tree.tsx`
- Create: `apps/studio/src/components/device-selector.tsx`
- Modify: `apps/studio/src/main.tsx`

- [ ] **Step 1: Create the device selector component**

```tsx
// apps/studio/src/components/device-selector.tsx
import { orpc } from "@/lib/client";

interface DeviceSelectorProps {
  platform: string;
  deviceId?: string;
  onSelect: (platform: string, deviceId?: string) => void;
}

export function DeviceSelector({ platform, deviceId, onSelect }: DeviceSelectorProps) {
  const { data: devices } = orpc.devices.list.useQuery({
    input: {},
    queryKey: ["devices"],
  });

  return (
    <div className="flex items-center gap-3">
      <label className="text-sm text-zinc-400">Device:</label>
      <select
        value={`${platform}:${deviceId ?? "default"}`}
        onChange={(e) => {
          const [p, d] = e.target.value.split(":");
          onSelect(p, d === "default" ? undefined : d);
        }}
        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
      >
        {devices?.map((d) => (
          <option key={`${d.platform}:${d.id}`} value={`${d.platform}:${d.id}`}>
            {d.name} ({d.platform})
          </option>
        ))}
      </select>
    </div>
  );
}
```

- [ ] **Step 2: Create the device screenshot component with click-to-inspect**

```tsx
// apps/studio/src/components/device-screenshot.tsx
import { useRef, useState, useCallback } from "react";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DeviceScreenshotProps {
  imageBase64?: string;
  highlightBounds?: Bounds;
  hoverBounds?: Bounds;
  deviceWidth: number;
  deviceHeight: number;
  onClickPoint?: (x: number, y: number) => void;
  onHoverPoint?: (x: number, y: number) => void;
  onMouseLeave?: () => void;
}

export function DeviceScreenshot({
  imageBase64,
  highlightBounds,
  hoverBounds,
  deviceWidth,
  deviceHeight,
  onClickPoint,
  onHoverPoint,
  onMouseLeave,
}: DeviceScreenshotProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const toDeviceCoords = useCallback(
    (e: React.MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const scaleX = deviceWidth / rect.width;
      const scaleY = deviceHeight / rect.height;
      return {
        x: Math.round((e.clientX - rect.left) * scaleX),
        y: Math.round((e.clientY - rect.top) * scaleY),
      };
    },
    [deviceWidth, deviceHeight],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const coords = toDeviceCoords(e);
      if (coords) onClickPoint?.(coords.x, coords.y);
    },
    [toDeviceCoords, onClickPoint],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const coords = toDeviceCoords(e);
      if (coords) onHoverPoint?.(coords.x, coords.y);
    },
    [toDeviceCoords, onHoverPoint],
  );

  function renderOverlay(bounds: Bounds | undefined, color: string) {
    if (!bounds || !containerRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    const scaleX = rect.width / deviceWidth;
    const scaleY = rect.height / deviceHeight;
    return (
      <div
        className="absolute pointer-events-none border-2"
        style={{
          left: bounds.x * scaleX,
          top: bounds.y * scaleY,
          width: bounds.width * scaleX,
          height: bounds.height * scaleY,
          borderColor: color,
          backgroundColor: `${color}20`,
        }}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative cursor-crosshair select-none"
      onClick={handleClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={onMouseLeave}
    >
      {imageBase64 ? (
        <img
          src={`data:image/png;base64,${imageBase64}`}
          alt="Device screenshot"
          className="w-full h-auto"
          draggable={false}
        />
      ) : (
        <div className="w-full aspect-[9/16] bg-zinc-900 flex items-center justify-center text-zinc-600">
          No screenshot
        </div>
      )}
      {renderOverlay(hoverBounds, "#60a5fa")}
      {renderOverlay(highlightBounds, "#f97316")}
    </div>
  );
}
```

- [ ] **Step 3: Create the element details panel**

```tsx
// apps/studio/src/components/element-details.tsx
import { Copy } from "lucide-react";
import { toast } from "sonner";

interface ElementDetailsProps {
  element?: {
    type?: string;
    testID?: string;
    text?: string;
    accessibilityLabel?: string;
    bounds?: { x: number; y: number; width: number; height: number };
  };
  suggestedSelectors?: Array<{ suggestedSelector: Record<string, string> }>;
}

export function ElementDetails({ element, suggestedSelectors }: ElementDetailsProps) {
  if (!element) {
    return (
      <div className="text-zinc-500 text-sm">Click an element on the screenshot to inspect it.</div>
    );
  }

  function copySelector(selector: Record<string, string>) {
    const text = JSON.stringify(selector, null, 2);
    navigator.clipboard.writeText(text);
    toast.success("Selector copied to clipboard");
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-zinc-300 mb-2">Element Details</h3>
        <dl className="text-sm space-y-1">
          {element.type && (
            <div className="flex gap-2">
              <dt className="text-zinc-500 w-24 shrink-0">type</dt>
              <dd className="text-zinc-200 font-mono">{element.type}</dd>
            </div>
          )}
          {element.testID && (
            <div className="flex gap-2">
              <dt className="text-zinc-500 w-24 shrink-0">testID</dt>
              <dd className="text-zinc-200 font-mono">{element.testID}</dd>
            </div>
          )}
          {element.text && (
            <div className="flex gap-2">
              <dt className="text-zinc-500 w-24 shrink-0">text</dt>
              <dd className="text-zinc-200 font-mono">{element.text}</dd>
            </div>
          )}
          {element.accessibilityLabel && (
            <div className="flex gap-2">
              <dt className="text-zinc-500 w-24 shrink-0">label</dt>
              <dd className="text-zinc-200 font-mono">{element.accessibilityLabel}</dd>
            </div>
          )}
          {element.bounds && (
            <div className="flex gap-2">
              <dt className="text-zinc-500 w-24 shrink-0">bounds</dt>
              <dd className="text-zinc-200 font-mono text-xs">
                {element.bounds.x},{element.bounds.y} {element.bounds.width}x{element.bounds.height}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {suggestedSelectors && suggestedSelectors.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-zinc-300 mb-2">Suggested Selectors</h3>
          <div className="space-y-1">
            {suggestedSelectors.map((s, i) => (
              <button
                key={i}
                onClick={() => copySelector(s.suggestedSelector)}
                className="w-full flex items-center justify-between gap-2 bg-zinc-800 rounded px-3 py-2 text-sm font-mono text-zinc-200 hover:bg-zinc-700 transition-colors"
              >
                <span className="truncate">{JSON.stringify(s.suggestedSelector)}</span>
                <Copy className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create the element tree component**

```tsx
// apps/studio/src/components/element-tree.tsx
import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";

interface Element {
  type?: string;
  testID?: string;
  text?: string;
  accessibilityLabel?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  children?: Element[];
}

interface ElementTreeProps {
  root?: Element;
  selectedPath?: number[];
  onSelect?: (path: number[]) => void;
  searchQuery?: string;
}

function TreeNode({
  element,
  depth,
  path,
  selectedPath,
  onSelect,
  searchQuery,
}: {
  element: Element;
  depth: number;
  path: number[];
  selectedPath?: number[];
  onSelect?: (path: number[]) => void;
  searchQuery?: string;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = element.children && element.children.length > 0;
  const isSelected =
    selectedPath &&
    path.length === selectedPath.length &&
    path.every((v, i) => v === selectedPath[i]);

  const label = [
    element.type ?? "?",
    element.testID && `[testID: ${element.testID}]`,
    element.text && `"${element.text.slice(0, 30)}"`,
  ]
    .filter(Boolean)
    .join(" ");

  const matchesSearch =
    searchQuery &&
    (element.testID?.toLowerCase().includes(searchQuery) ||
      element.text?.toLowerCase().includes(searchQuery) ||
      element.type?.toLowerCase().includes(searchQuery));

  return (
    <div>
      <div
        className={`flex items-center gap-1 px-2 py-0.5 cursor-pointer text-sm font-mono hover:bg-zinc-800 ${
          isSelected
            ? "bg-zinc-800 text-orange-400"
            : matchesSearch
              ? "text-blue-400"
              : "text-zinc-300"
        }`}
        style={{ paddingLeft: depth * 16 + 4 }}
        onClick={() => onSelect?.(path)}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className="w-4 h-4 flex items-center justify-center"
          >
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
        ) : (
          <span className="w-4" />
        )}
        <span className="truncate">{label}</span>
      </div>
      {expanded &&
        hasChildren &&
        element.children!.map((child, i) => (
          <TreeNode
            key={i}
            element={child}
            depth={depth + 1}
            path={[...path, i]}
            selectedPath={selectedPath}
            onSelect={onSelect}
            searchQuery={searchQuery}
          />
        ))}
    </div>
  );
}

export function ElementTree({ root, selectedPath, onSelect, searchQuery }: ElementTreeProps) {
  const [filter, setFilter] = useState("");
  const query = searchQuery ?? filter.toLowerCase();

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b border-zinc-800">
        <input
          type="text"
          placeholder="Search elements..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
        />
      </div>
      <div className="flex-1 overflow-auto">
        {root ? (
          <TreeNode
            element={root}
            depth={0}
            path={[]}
            selectedPath={selectedPath}
            onSelect={onSelect}
            searchQuery={query}
          />
        ) : (
          <div className="p-4 text-sm text-zinc-500">
            Connect to a device to see the element tree.
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create the inspector page that wires everything together**

```tsx
// apps/studio/src/pages/inspector.tsx
import { useState, useCallback } from "react";
import { orpc } from "@/lib/client";
import { DeviceSelector } from "@/components/device-selector";
import { DeviceScreenshot } from "@/components/device-screenshot";
import { ElementDetails } from "@/components/element-details";
import { ElementTree } from "@/components/element-tree";
import {
  elementsAtPoint,
  getElementByPath,
} from "../../../../packages/spana/src/studio/core/element-tree.js";
import { RefreshCw } from "lucide-react";

export function InspectorPage() {
  const [platform, setPlatform] = useState("web");
  const [deviceId, setDeviceId] = useState<string | undefined>();
  const [selectedPath, setSelectedPath] = useState<number[] | undefined>();
  const [hoverBounds, setHoverBounds] = useState<
    { x: number; y: number; width: number; height: number } | undefined
  >();
  const [liveMode, setLiveMode] = useState(false);

  const screenshot = orpc.inspector.screenshot.useQuery({
    input: { platform: platform as "web" | "android" | "ios", deviceId },
    queryKey: ["screenshot", platform, deviceId],
    refetchInterval: liveMode ? 1000 : false,
  });

  const hierarchy = orpc.inspector.hierarchy.useQuery({
    input: { platform: platform as "web" | "android" | "ios", deviceId },
    queryKey: ["hierarchy", platform, deviceId],
    refetchInterval: liveMode ? 2000 : false,
  });

  const selectors = orpc.inspector.selectors.useQuery({
    input: { platform: platform as "web" | "android" | "ios", deviceId },
    queryKey: ["selectors", platform, deviceId],
  });

  const selectedElement =
    selectedPath && hierarchy.data ? getElementByPath(hierarchy.data, selectedPath) : undefined;

  const selectedSelectors =
    selectedElement && selectors.data
      ? selectors.data.filter((s) => {
          if (selectedElement.testID && s.suggestedSelector && "testID" in s.suggestedSelector) {
            return s.suggestedSelector.testID === selectedElement.testID;
          }
          if (selectedElement.text && s.text) {
            return s.text === selectedElement.text;
          }
          return false;
        })
      : [];

  const handleClickPoint = useCallback(
    (x: number, y: number) => {
      if (!hierarchy.data) return;
      const hits = elementsAtPoint(hierarchy.data, x, y);
      if (hits.length > 0) {
        setSelectedPath(hits[0].path);
      }
    },
    [hierarchy.data],
  );

  const handleHoverPoint = useCallback(
    (x: number, y: number) => {
      if (!hierarchy.data) return;
      const hits = elementsAtPoint(hierarchy.data, x, y);
      if (hits.length > 0) {
        setHoverBounds(hits[0].element.bounds);
      } else {
        setHoverBounds(undefined);
      }
    },
    [hierarchy.data],
  );

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Toolbar */}
      <div className="flex items-center gap-4">
        <DeviceSelector
          platform={platform}
          deviceId={deviceId}
          onSelect={(p, d) => {
            setPlatform(p);
            setDeviceId(d);
            setSelectedPath(undefined);
          }}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={liveMode}
            onChange={(e) => setLiveMode(e.target.checked)}
            className="rounded"
          />
          Live
        </label>
        <button
          onClick={() => {
            screenshot.refetch();
            hierarchy.refetch();
            selectors.refetch();
          }}
          className="flex items-center gap-1 px-3 py-1.5 bg-zinc-800 rounded text-sm hover:bg-zinc-700"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {/* Main content */}
      <div className="flex-1 grid grid-cols-2 gap-4 min-h-0">
        {/* Left: Screenshot */}
        <div className="overflow-auto border border-zinc-800 rounded">
          <DeviceScreenshot
            imageBase64={screenshot.data?.image}
            highlightBounds={selectedElement?.bounds}
            hoverBounds={hoverBounds}
            deviceWidth={1080}
            deviceHeight={1920}
            onClickPoint={handleClickPoint}
            onHoverPoint={handleHoverPoint}
            onMouseLeave={() => setHoverBounds(undefined)}
          />
        </div>

        {/* Right: Details */}
        <div className="overflow-auto border border-zinc-800 rounded p-4">
          <ElementDetails element={selectedElement} suggestedSelectors={selectedSelectors} />
        </div>
      </div>

      {/* Bottom: Element tree */}
      <div className="h-64 border border-zinc-800 rounded overflow-hidden">
        <ElementTree
          root={hierarchy.data}
          selectedPath={selectedPath}
          onSelect={(path) => setSelectedPath(path)}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Wire inspector page into main.tsx**

Replace the placeholder in `apps/studio/src/main.tsx`:

```tsx
import { InspectorPage } from "./pages/inspector";

// In the App component, replace:
//   {page === "inspector" && <div>Inspector (coming next)</div>}
// with:
//   {page === "inspector" && <InspectorPage />}
```

- [ ] **Step 7: Verify it builds**

```bash
cd apps/studio && bun run build
```

Expected: Build succeeds. Some type warnings are expected if the import path to the core module needs adjustment — fix any path issues.

- [ ] **Step 8: Commit**

```bash
git add apps/studio/src/pages/inspector.tsx apps/studio/src/components/device-screenshot.tsx apps/studio/src/components/element-details.tsx apps/studio/src/components/element-tree.tsx apps/studio/src/components/device-selector.tsx apps/studio/src/main.tsx
git commit -m "feat(studio): add Element Inspector UI with screenshot, details, and tree"
```

---

### Task 9: Test Runner UI

Build the test runner page with flow list, real-time progress, and failure details.

**Files:**

- Create: `apps/studio/src/pages/runner.tsx`
- Create: `apps/studio/src/components/flow-list.tsx`
- Create: `apps/studio/src/components/run-progress.tsx`
- Create: `apps/studio/src/components/failure-details.tsx`
- Modify: `apps/studio/src/main.tsx`

- [ ] **Step 1: Create the flow list component**

```tsx
// apps/studio/src/components/flow-list.tsx
interface Flow {
  name: string;
  tags: string[];
  platforms: string[];
}

interface FlowListProps {
  flows: Flow[];
  selectedFlows: Set<string>;
  onToggleFlow: (name: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
}

export function FlowList({
  flows,
  selectedFlows,
  onToggleFlow,
  onSelectAll,
  onDeselectAll,
}: FlowListProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 mb-2">
        <button onClick={onSelectAll} className="text-xs text-zinc-400 hover:text-zinc-200">
          Select all
        </button>
        <span className="text-zinc-600">|</span>
        <button onClick={onDeselectAll} className="text-xs text-zinc-400 hover:text-zinc-200">
          Deselect all
        </button>
      </div>
      {flows.map((flow) => (
        <label
          key={flow.name}
          className="flex items-center gap-2 px-2 py-1 rounded hover:bg-zinc-800 cursor-pointer"
        >
          <input
            type="checkbox"
            checked={selectedFlows.has(flow.name)}
            onChange={() => onToggleFlow(flow.name)}
            className="rounded"
          />
          <span className="text-sm">{flow.name}</span>
          {flow.tags.map((tag) => (
            <span key={tag} className="text-xs bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded">
              {tag}
            </span>
          ))}
        </label>
      ))}
      {flows.length === 0 && <div className="text-sm text-zinc-500 px-2">No flows found.</div>}
    </div>
  );
}
```

- [ ] **Step 2: Create the run progress component**

```tsx
// apps/studio/src/components/run-progress.tsx
import { CheckCircle, XCircle, Loader2, Circle } from "lucide-react";

interface FlowResult {
  name: string;
  platform: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: { message: string };
  steps?: Array<{
    command: string;
    status: "passed" | "failed";
    durationMs: number;
    error?: string;
  }>;
}

interface RunProgressProps {
  results: FlowResult[];
  isRunning: boolean;
  onSelectResult?: (result: FlowResult) => void;
  selectedResult?: FlowResult;
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "passed":
      return <CheckCircle className="w-4 h-4 text-green-500" />;
    case "failed":
      return <XCircle className="w-4 h-4 text-red-500" />;
    case "running":
      return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />;
    default:
      return <Circle className="w-4 h-4 text-zinc-600" />;
  }
}

export function RunProgress({
  results,
  isRunning,
  onSelectResult,
  selectedResult,
}: RunProgressProps) {
  if (results.length === 0 && !isRunning) {
    return <div className="text-sm text-zinc-500">Run tests to see results.</div>;
  }

  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;

  return (
    <div className="space-y-2">
      {/* Summary bar */}
      <div className="flex items-center gap-4 text-sm">
        {passed > 0 && <span className="text-green-500">{passed} passed</span>}
        {failed > 0 && <span className="text-red-500">{failed} failed</span>}
        {isRunning && <span className="text-blue-400">Running...</span>}
      </div>

      {/* Results list */}
      <div className="space-y-1">
        {results.map((result, i) => (
          <button
            key={`${result.name}-${result.platform}-${i}`}
            onClick={() => onSelectResult?.(result)}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded text-sm text-left hover:bg-zinc-800 ${
              selectedResult === result ? "bg-zinc-800" : ""
            }`}
          >
            <StatusIcon status={result.status} />
            <span className="flex-1 truncate">{result.name}</span>
            <span className="text-zinc-500">({result.platform})</span>
            <span className="text-zinc-600 text-xs">{(result.durationMs / 1000).toFixed(1)}s</span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create the failure details component**

```tsx
// apps/studio/src/components/failure-details.tsx
import { CheckCircle, XCircle } from "lucide-react";

interface FlowResult {
  name: string;
  platform: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: { message: string; stack?: string };
  steps?: Array<{
    command: string;
    selector?: unknown;
    status: "passed" | "failed";
    durationMs: number;
    error?: string;
  }>;
}

interface FailureDetailsProps {
  result?: FlowResult;
}

export function FailureDetails({ result }: FailureDetailsProps) {
  if (!result) {
    return <div className="text-sm text-zinc-500">Select a result to see details.</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-zinc-300">
          {result.name}
          <span className="text-zinc-500 font-normal ml-2">({result.platform})</span>
        </h3>
        <span
          className={`text-xs ${result.status === "passed" ? "text-green-500" : "text-red-500"}`}
        >
          {result.status} in {(result.durationMs / 1000).toFixed(1)}s
        </span>
      </div>

      {result.error && (
        <div className="bg-red-950/30 border border-red-900/50 rounded p-3">
          <p className="text-sm text-red-400 font-mono">{result.error.message}</p>
        </div>
      )}

      {result.steps && result.steps.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-zinc-400 mb-2">Steps</h4>
          <div className="space-y-1">
            {result.steps.map((step, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                {step.status === "passed" ? (
                  <CheckCircle className="w-3.5 h-3.5 text-green-500 mt-0.5 shrink-0" />
                ) : (
                  <XCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-zinc-300">{step.command}</span>
                  {step.selector && (
                    <span className="text-zinc-500 ml-1 text-xs">
                      {JSON.stringify(step.selector)}
                    </span>
                  )}
                  <span className="text-zinc-600 ml-2 text-xs">
                    {(step.durationMs / 1000).toFixed(1)}s
                  </span>
                  {step.error && <p className="text-red-400 text-xs mt-0.5">{step.error}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create the runner page that wires everything together**

```tsx
// apps/studio/src/pages/runner.tsx
import { useState, useCallback } from "react";
import { orpc } from "@/lib/client";
import { FlowList } from "@/components/flow-list";
import { RunProgress } from "@/components/run-progress";
import { FailureDetails } from "@/components/failure-details";
import { Play, RotateCcw } from "lucide-react";

export function RunnerPage() {
  const [selectedFlows, setSelectedFlows] = useState<Set<string>>(new Set());
  const [platforms, setPlatforms] = useState<Set<string>>(new Set(["web"]));
  const [runId, setRunId] = useState<string | undefined>();
  const [selectedResult, setSelectedResult] = useState<any>(undefined);

  const flowsQuery = orpc.tests.listFlows.useQuery({
    input: {},
    queryKey: ["flows"],
  });

  const statusQuery = orpc.tests.status.useQuery({
    input: { runId: runId! },
    queryKey: ["run-status", runId],
    enabled: !!runId,
    refetchInterval: runId ? 1000 : false,
  });

  const isRunning = statusQuery.data?.status === "running";
  const results = statusQuery.data?.results ?? [];

  const handleRun = useCallback(async () => {
    const result = await orpc.tests.run.call({
      platforms: Array.from(platforms) as ("web" | "android" | "ios")[],
      grep: selectedFlows.size > 0 ? Array.from(selectedFlows).join("|") : undefined,
    });
    setRunId(result.runId);
    setSelectedResult(undefined);
  }, [platforms, selectedFlows]);

  const handleRerunFailed = useCallback(async () => {
    const failedNames = results.filter((r: any) => r.status === "failed").map((r: any) => r.name);
    if (failedNames.length === 0) return;
    const result = await orpc.tests.run.call({
      platforms: Array.from(platforms) as ("web" | "android" | "ios")[],
      grep: failedNames.join("|"),
    });
    setRunId(result.runId);
    setSelectedResult(undefined);
  }, [results, platforms]);

  const flows = flowsQuery.data ?? [];

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Toolbar */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          {["web", "android", "ios"].map((p) => (
            <label key={p} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={platforms.has(p)}
                onChange={(e) => {
                  const next = new Set(platforms);
                  if (e.target.checked) next.add(p);
                  else next.delete(p);
                  setPlatforms(next);
                }}
                className="rounded"
              />
              {p}
            </label>
          ))}
        </div>
        <button
          onClick={handleRun}
          disabled={isRunning || platforms.size === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 rounded text-sm font-medium"
        >
          <Play className="w-3.5 h-3.5" />
          Run
        </button>
        {results.some((r: any) => r.status === "failed") && (
          <button
            onClick={handleRerunFailed}
            disabled={isRunning}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-sm"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Re-run Failed
          </button>
        )}
      </div>

      {/* Main content */}
      <div className="flex-1 grid grid-cols-3 gap-4 min-h-0">
        {/* Left: Flow list */}
        <div className="overflow-auto border border-zinc-800 rounded p-3">
          <h2 className="text-sm font-semibold text-zinc-300 mb-3">Flows</h2>
          <FlowList
            flows={flows}
            selectedFlows={selectedFlows}
            onToggleFlow={(name) => {
              const next = new Set(selectedFlows);
              if (next.has(name)) next.delete(name);
              else next.add(name);
              setSelectedFlows(next);
            }}
            onSelectAll={() => setSelectedFlows(new Set(flows.map((f: any) => f.name)))}
            onDeselectAll={() => setSelectedFlows(new Set())}
          />
        </div>

        {/* Center: Run progress */}
        <div className="overflow-auto border border-zinc-800 rounded p-3">
          <h2 className="text-sm font-semibold text-zinc-300 mb-3">Results</h2>
          <RunProgress
            results={results}
            isRunning={isRunning}
            onSelectResult={setSelectedResult}
            selectedResult={selectedResult}
          />
        </div>

        {/* Right: Details */}
        <div className="overflow-auto border border-zinc-800 rounded p-3">
          <h2 className="text-sm font-semibold text-zinc-300 mb-3">Details</h2>
          <FailureDetails result={selectedResult} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire runner page into main.tsx**

Replace the placeholder in `apps/studio/src/main.tsx`:

```tsx
import { RunnerPage } from "./pages/runner";

// Replace:
//   {page === "runner" && <div>Test Runner (coming next)</div>}
// with:
//   {page === "runner" && <RunnerPage />}
```

- [ ] **Step 6: Verify it builds**

```bash
cd apps/studio && bun run build
```

Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/studio/src/pages/runner.tsx apps/studio/src/components/flow-list.tsx apps/studio/src/components/run-progress.tsx apps/studio/src/components/failure-details.tsx apps/studio/src/main.tsx
git commit -m "feat(studio): add Test Runner UI with flow list, progress, and failure details"
```

---

### Task 10: Build Pipeline (embed frontend in npm package)

Wire up the build so that `apps/studio/` output gets embedded into `packages/spana/` for npm distribution.

**Files:**

- Modify: `packages/spana/tsup.config.ts` (add studio entry)
- Modify: `packages/spana/package.json` (include studio-dist in files)
- Create: `packages/spana/scripts/embed-studio.ts`

- [ ] **Step 1: Create the embed script**

```typescript
// packages/spana/scripts/embed-studio.ts
import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const studioDistSrc = resolve(__dirname, "../../../apps/studio/dist");
const studioDistDest = resolve(__dirname, "../studio-dist");

if (!existsSync(studioDistSrc)) {
  console.log("⚠ apps/studio/dist not found — skipping studio embed. Build apps/studio first.");
  process.exit(0);
}

// Clean and copy
if (existsSync(studioDistDest)) {
  rmSync(studioDistDest, { recursive: true });
}

cpSync(studioDistSrc, studioDistDest, { recursive: true });
console.log("✓ Studio frontend embedded into packages/spana/studio-dist/");
```

- [ ] **Step 2: Add build scripts to packages/spana/package.json**

Add to the `"scripts"` section:

```json
"embed-studio": "bun scripts/embed-studio.ts",
"postbuild": "bun scripts/embed-studio.ts"
```

Add `"studio-dist"` to the `"files"` array:

```json
"files": ["dist", "studio-dist", "LICENSE", "README.md"]
```

- [ ] **Step 3: Add studio-dist to .gitignore**

```bash
echo "packages/spana/studio-dist/" >> .gitignore
```

- [ ] **Step 4: Test the full build pipeline**

```bash
cd /Users/anton/.superset/projects/spana
turbo build
ls packages/spana/studio-dist/
```

Expected: `studio-dist/` contains `index.html`, `assets/`, etc.

- [ ] **Step 5: Test the full flow end-to-end**

```bash
cd packages/spana && bun run build
node dist/cli.js studio --no-open &
sleep 2
curl -s http://localhost:4400 | head -c 200
kill %1
```

Expected: Returns the Studio HTML page.

- [ ] **Step 6: Commit**

```bash
git add packages/spana/scripts/embed-studio.ts packages/spana/package.json packages/spana/tsup.config.ts .gitignore
git commit -m "feat(studio): add build pipeline to embed frontend in npm package"
```

---

## Execution Order

Tasks must be executed in order — each builds on the previous:

1. **Task 1** — Backend scaffold (oRPC + Effect + Hono)
2. **Task 2** — CLI command (`spana studio`)
3. **Task 3** — Devices router
4. **Task 4** — Inspector router + pure core (includes tests)
5. **Task 5** — Tests router
6. **Task 6** — Frontend scaffold (React + Vite + Tailwind)
7. **Task 7** — oRPC client + app layout
8. **Task 8** — Element Inspector UI
9. **Task 9** — Test Runner UI
10. **Task 10** — Build pipeline (embed + distribute)

Tasks 1-5 (backend) and Task 6 (frontend scaffold) could run in parallel if using separate agents with a shared branch. Tasks 7-9 depend on both backend and frontend being in place. Task 10 is the final integration step.
