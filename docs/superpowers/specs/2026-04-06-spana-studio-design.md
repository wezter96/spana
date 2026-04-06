# Spana Studio — Design Spec

> A local web UI for interactive element inspection and test management, launched via `spana studio`.

## 1. Overview

Spana Studio is a browser-based development tool that ships embedded in the `spana-test` npm package. It provides:

- **Element Inspector** — live device screenshots with tap-to-inspect, element tree browsing, and selector suggestions
- **Test Runner Dashboard** — flow discovery, real-time test execution, failure inspection, and selective re-runs

Future features (architecture supports, not built in Phase 2):

- Flow authoring with recording mode
- Live device mirror with touch passthrough
- AI assistant for flow generation

## 2. Architecture

### Functional Core / Imperative Shell

Following the pattern established in far-aida-coach:

| Question                                                  | Layer                      |
| --------------------------------------------------------- | -------------------------- |
| Business rule, selector matching, element tree traversal? | **Core** (pure function)   |
| Needs device connection, screenshots, HTTP to companion?  | **Shell** (Effect Service) |
| Can test without mocking anything?                        | It belongs in **Core**     |

### Monorepo Structure

```
apps/studio/                    — React frontend (Vite + React 18 + Tailwind + shadcn/ui)
  src/
    pages/
      inspector.tsx             — Element Inspector page
      runner.tsx                — Test Runner Dashboard page
    components/
      device-screenshot.tsx     — Live screenshot with element overlays
      element-details.tsx       — Selected element info + selectors
      element-tree.tsx          — Collapsible hierarchy tree
      flow-list.tsx             — Flow browser with filters
      run-progress.tsx          — Real-time step results
      failure-details.tsx       — Error + screenshot + hierarchy viewer
    hooks/
      use-screenshot-stream.ts  — WebSocket screenshot polling
      use-test-stream.ts        — WebSocket test progress
    lib/
      client.ts                 — oRPC client (type-safe, from router type)

packages/spana/
  src/studio/
    core/                       — Pure functions (no Effect, no I/O)
      element-tree.ts           — tree traversal, filtering, search
      selector-suggest.ts       — rank/suggest best selector for element
      result-formatter.ts       — transform test results for display

    services/                   — Effect Services (imperative shell)
      DeviceManager.ts          — discover devices, manage connections
      ScreenCapture.ts          — screenshot polling/streaming
      TestRunner.ts             — orchestrate test execution
      HierarchyInspector.ts     — fetch + parse element hierarchies

    api/                        — oRPC router (thin layer over services)
      context.ts                — request context + ManagedRuntime
      effect-handler.ts         — Effect -> oRPC error bridge
      routers/
        devices.ts              — list, connect, switch devices
        inspector.ts            — hierarchy, selectors, screenshots
        tests.ts                — run, results, re-run
        studio.ts               — compose all routers

    server.ts                   — Effect HTTP server, serves static + API

  src/cli/studio.ts             — CLI command: `spana studio`
  studio-dist/                  — Built frontend (copied at build time, included in npm)
```

### Tech Stack

- **Frontend:** React 18, Tailwind CSS, shadcn/ui, Vite
- **API:** oRPC with WebSocket adapter for real-time features
- **Backend:** Effect services via ManagedRuntime
- **Type Safety:** oRPC provides end-to-end types between frontend and backend

### Runtime Wiring

```typescript
// packages/spana/src/studio/server.ts
const StudioLayer = Layer.mergeAll(
  DeviceManager.Default,
  ScreenCapture.Default,
  TestRunner.Default,
  HierarchyInspector.Default,
).pipe(Layer.provide(RawDriverLive));

const runtime = ManagedRuntime.make(StudioLayer);
```

### oRPC Pattern

Following far-aida-coach's `runEffect` bridge:

```typescript
// packages/spana/src/studio/api/effect-handler.ts
export const runEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R | Scope.Scope>,
  runtime: ManagedRuntime.ManagedRuntime<R, any>,
): Promise<A> =>
  runtime.runPromiseExit(Effect.scoped(effect)).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    if (Cause.isFailType(exit.cause) && exit.cause.error instanceof ORPCError) {
      throw exit.cause.error;
    }
    throw new ORPCError("INTERNAL_SERVER_ERROR");
  });
```

### Build & Distribution

1. `apps/studio/` builds via Vite into static files
2. Turbo build pipeline copies output to `packages/spana/studio-dist/`
3. `spana studio` command serves `studio-dist/` as static files + oRPC API
4. Published to npm as part of `spana-test` package — `npx spana-test studio` works

## 3. CLI Command

```
spana studio [options]

Options:
  --port <number>     Server port (default: 4400)
  --no-open           Don't auto-open browser
  --config <path>     Path to spana config file
  --platform <p,...>  Filter to specific platforms
```

**Behavior:**

1. Load spana config
2. Auto-detect connected devices (reuses `spana devices` logic)
3. Start Effect HTTP server with ManagedRuntime
4. Serve static frontend + oRPC API
5. Open browser to `http://localhost:4400`
6. Print URL to terminal for manual access

## 4. Feature: Element Inspector

### UI Layout

```
+-----------------------------------------------------+
|  Device: [Pixel 7 v]  Platform: android   Live: [on] |
+----------------------+------------------------------+
|                      |  Element Details              |
|                      |                               |
|   Live Screenshot    |  testID: "login-btn"          |
|   (clickable)        |  text: "Sign In"              |
|                      |  type: android.widget.Button  |
|                      |  bounds: {0,840,1080,960}     |
|                      |                               |
|                      |  Suggested Selectors:          |
|                      |  { testID: "login-btn" }  [copy]
|                      |  { text: "Sign In" }      [copy]
+----------------------+------------------------------+
|  Element Tree (collapsible, searchable)              |
|  > View                                              |
|    > ScrollView                                      |
|      > Button [testID: login-btn]  <-- highlighted   |
|        Text: "Sign In"                               |
+-----------------------------------------------------+
```

### Interaction

1. **Hover** over screenshot — highlight element bounds with overlay rectangle
2. **Click** element — right panel shows details + suggested selectors
3. **Copy** selector — copies `{ testID: "login-btn" }` to clipboard for use in `.flow.ts`
4. **Element tree** syncs with screenshot selection (bidirectional)
5. **Search** in tree to find elements by text, testID, or type
6. **Device switcher** — dropdown to switch between connected devices

### Screenshot Streaming

- **Hybrid mode:** on-demand by default, toggle to live polling
- Live mode polls at ~1 screenshot/second via WebSocket
- Each screenshot includes element bounds data for overlay rendering

### API (oRPC)

```typescript
const inspectorRouter = {
  // Returns PNG screenshot as base64
  screenshot: publicProcedure
    .handler(async ({ context }) => { ... }),

  // Returns parsed element tree
  hierarchy: publicProcedure
    .handler(async ({ context }) => { ... }),

  // Returns flat list with suggested selectors (priority-ranked)
  selectors: publicProcedure
    .handler(async ({ context }) => { ... }),

  // WebSocket: stream screenshots at interval
  screenshotStream: publicProcedure
    .handler(async ({ context }) => { ... }),
};
```

### Reused Internals

| Studio feature      | Existing spana code                                   |
| ------------------- | ----------------------------------------------------- |
| Screenshot          | `RawDriverService.takeScreenshot()` on all drivers    |
| Element tree        | `RawDriverService.dumpHierarchy()` + platform parsers |
| Suggested selectors | `Session.selectors()` in `src/agent/session.ts`       |
| Device discovery    | `src/device/` (ADB, simctl)                           |
| Element matching    | `src/smart/element-matcher.ts`                        |

## 5. Feature: Test Runner Dashboard

### UI Layout

```
+-----------------------------------------------------+
|  Flows    [Run All]  [Filter by tag v]  [Search]     |
+----------------------+------------------------------+
|  Flow List           |  Run Results                  |
|                      |                               |
|  ok home             |  home (android)          1.2s |
|  ok tabs-explore     |  +- ok app.openLink()   0.3s |
|  x  login-flow       |  +- ok expect(visible)  0.1s |
|  .. settings         |  +- x  app.tap(...)     0.8s |
|  o  profile          |  |  Element not found:        |
|                      |  |  { testID: "save-btn" }    |
|                      |  |  within 5000ms              |
|                      |  |                             |
|                      |  |  [Screenshot] [Hierarchy]   |
|                      |  +- skipped remaining          |
|                      |                               |
|  Platforms:          |  [Re-run] [Re-run Failed]      |
|  [web] [android] [ios]                               |
+----------------------+------------------------------+
|  2 passed | 1 failed | 1 running | 1 pending         |
+-----------------------------------------------------+
```

### Features

1. **Flow discovery** — lists `.flow.ts` files from config's `flowDir` with metadata (name, tags, platforms)
2. **Real-time progress** — WebSocket pushes step-by-step results as tests execute
3. **Failure details** — error message with selector info, screenshot + hierarchy at point of failure
4. **Re-run controls** — run all, run specific flow, re-run only failures
5. **Platform filter** — select which platforms to run on
6. **Tag filter** — filter flows by tags
7. **Status bar** — aggregate pass/fail/running/pending counts

### API (oRPC)

```typescript
const testsRouter = {
  // Discover flows and return metadata
  listFlows: publicProcedure
    .handler(async ({ context }) => { ... }),

  // Start a test run, returns run ID
  run: publicProcedure
    .input(z.object({
      flowPaths: z.array(z.string()).optional(),
      platforms: z.array(z.enum(["web", "android", "ios"])).optional(),
      tags: z.array(z.string()).optional(),
    }))
    .handler(async ({ context }) => { ... }),

  // WebSocket: stream real-time step results for a run
  subscribe: publicProcedure
    .input(z.object({ runId: z.string() }))
    .handler(async ({ context }) => { ... }),

  // Get completed run results
  results: publicProcedure
    .input(z.object({ runId: z.string() }))
    .handler(async ({ context }) => { ... }),

  // Serve screenshot/hierarchy artifact for a specific step
  artifact: publicProcedure
    .input(z.object({ runId: z.string(), stepIndex: z.number(), type: z.enum(["screenshot", "hierarchy"]) }))
    .handler(async ({ context }) => { ... }),
};
```

### Reused Internals

| Studio feature         | Existing spana code                                   |
| ---------------------- | ----------------------------------------------------- |
| Flow discovery         | `test-command.ts` flow loading + filtering            |
| Tag/platform filtering | Existing `--tag`, `--platform`, `--grep` logic        |
| Test execution         | `orchestrator.ts` / `parallel.ts`                     |
| Results data shape     | JSON reporter output format                           |
| Failure artifacts      | Artifacts system (screenshots + hierarchy on failure) |

## 6. Future Features (architecture supports)

### Flow Authoring

- Code editor panel with TypeScript syntax highlighting
- "Record" mode: tap on screenshot in inspector, generates flow code line by line
- Save/edit `.flow.ts` files from the UI
- **Extension point:** add `flows.save` / `flows.create` to oRPC router, add editor component

### Live Device Mirror

- Higher framerate screenshot streaming for real-time mirror
- Touch passthrough: tap/swipe in browser triggers driver actions on device
- **Extension point:** increase poll rate on existing WebSocket, add `inspector.tap` / `inspector.swipe` endpoints wrapping existing driver methods

### AI Assistant

- Natural language to flow code generation
- Uses element tree + selectors as LLM context
- **Extension point:** add `ai` router, feed `hierarchy` + `selectors` output as prompt context

## 7. Updated Phase 2 Roadmap

| Item                                 | Status   |
| ------------------------------------ | -------- |
| HTML reporter                        | Done     |
| Config discovery                     | Done     |
| Spana Studio — Element Inspector     | To build |
| Spana Studio — Test Runner Dashboard | To build |
| `spana init` scaffolding             | To build |
| Pre-flight flow validation           | To build |

Watch mode replaced by Studio's test runner dashboard (more useful for e2e than blind file-watching).

Conditional flow execution moved to Phase 3 (runtime feature, not DX).

## 8. Testing Strategy

### Core Functions (pure, no mocking)

```typescript
import { describe, it, expect } from "bun:test";
import { findElement, buildOverlayBounds } from "./core/element-tree";

describe("element-tree", () => {
  it("finds element by testID in tree", () => {
    const tree = mockElementTree();
    const result = findElement(tree, { testID: "login-btn" });
    expect(result?.testID).toBe("login-btn");
  });
});
```

### Effect Services (@effect/vitest with Layer.mock)

```typescript
import { it } from "@effect/vitest";

it.scoped("DeviceManager discovers connected devices", () =>
  Effect.gen(function* () {
    const manager = yield* DeviceManager;
    const devices = yield* manager.listDevices();
    expect(devices.length).toBeGreaterThan(0);
  }).pipe(Effect.provide(DeviceManager.Default)),
);
```

### Frontend (vitest + React Testing Library)

Standard component tests for UI interactions, with mocked oRPC client responses.
