# Studio Record-to-Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Recorder page to Studio that captures device interactions and generates `.flow.ts` files.

**Architecture:** New `recordingRouter` RPC router manages recording sessions. Inspector-driven recording captures actions via existing `Session` class. A template-based `flow-generator.ts` transforms recorded actions into TypeScript flow code. New React page with action timeline and live code preview.

**Tech Stack:** Hono/oRPC (backend), React/TanStack Query (frontend), existing Session + inspector infrastructure

---

### Task 1: Recording Session Types and State

**Files:**

- Create: `packages/spana/src/studio/recording-session.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/spana/src/studio/recording-session.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { createRecordingSessionStore, type RecordedAction } from "./recording-session.js";

describe("RecordingSessionStore", () => {
  it("creates a session and returns its id", () => {
    const store = createRecordingSessionStore();
    const session = store.start("web");
    expect(session.id).toBeDefined();
    expect(session.platform).toBe("web");
    expect(session.status).toBe("recording");
    expect(session.actions).toEqual([]);
  });

  it("adds an action to a session", () => {
    const store = createRecordingSessionStore();
    const session = store.start("android", "emulator-5554");
    const action: RecordedAction = {
      type: "tap",
      selector: { testID: "login-btn" },
      selectorAlternatives: [{ text: "Login" }],
      params: {},
      timestamp: Date.now(),
    };
    const actionId = store.addAction(session.id, action);
    expect(actionId).toBeDefined();
    const updated = store.get(session.id);
    expect(updated!.actions).toHaveLength(1);
    expect(updated!.actions[0]!.id).toBe(actionId);
  });

  it("deletes an action from a session", () => {
    const store = createRecordingSessionStore();
    const session = store.start("web");
    const actionId = store.addAction(session.id, {
      type: "tap",
      selector: { text: "Submit" },
      selectorAlternatives: [],
      params: {},
      timestamp: Date.now(),
    });
    store.deleteAction(session.id, actionId);
    expect(store.get(session.id)!.actions).toHaveLength(0);
  });

  it("reorders actions", () => {
    const store = createRecordingSessionStore();
    const session = store.start("web");
    const id1 = store.addAction(session.id, {
      type: "tap",
      selector: { text: "A" },
      selectorAlternatives: [],
      params: {},
      timestamp: 1,
    });
    const id2 = store.addAction(session.id, {
      type: "tap",
      selector: { text: "B" },
      selectorAlternatives: [],
      params: {},
      timestamp: 2,
    });
    store.reorderActions(session.id, [id2, id1]);
    const updated = store.get(session.id)!;
    expect(updated.actions[0]!.id).toBe(id2);
    expect(updated.actions[1]!.id).toBe(id1);
  });

  it("updates a selector on an action", () => {
    const store = createRecordingSessionStore();
    const session = store.start("web");
    const actionId = store.addAction(session.id, {
      type: "tap",
      selector: { text: "Login" },
      selectorAlternatives: [{ testID: "login-btn" }],
      params: {},
      timestamp: Date.now(),
    });
    store.updateSelector(session.id, actionId, { testID: "login-btn" });
    expect(store.get(session.id)!.actions[0]!.selector).toEqual({
      testID: "login-btn",
    });
  });

  it("stops a session", () => {
    const store = createRecordingSessionStore();
    const session = store.start("web");
    store.stop(session.id);
    expect(store.get(session.id)!.status).toBe("stopped");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/spana && bun test src/studio/recording-session.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `packages/spana/src/studio/recording-session.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type { Selector } from "../schemas/selector.js";
import type { Platform } from "../schemas/selector.js";

export interface RecordedAction {
  id: string;
  type:
    | "tap"
    | "doubleTap"
    | "longPress"
    | "inputText"
    | "scroll"
    | "swipe"
    | "pressKey"
    | "back"
    | "expect.toBeVisible"
    | "expect.toHaveText";
  selector?: Selector;
  selectorAlternatives: Selector[];
  params: Record<string, unknown>;
  timestamp: number;
  screenshotPath?: string;
}

export interface RecordingSession {
  id: string;
  platform: Platform;
  deviceId?: string;
  status: "recording" | "stopped";
  actions: (RecordedAction & { id: string })[];
  startedAt: number;
}

export interface RecordingSessionStore {
  start(platform: Platform, deviceId?: string): RecordingSession;
  get(sessionId: string): RecordingSession | undefined;
  stop(sessionId: string): void;
  addAction(sessionId: string, action: RecordedAction): string;
  deleteAction(sessionId: string, actionId: string): void;
  reorderActions(sessionId: string, actionIds: string[]): void;
  updateSelector(sessionId: string, actionId: string, selector: Selector): void;
}

export function createRecordingSessionStore(): RecordingSessionStore {
  const sessions = new Map<string, RecordingSession>();

  return {
    start(platform, deviceId) {
      const session: RecordingSession = {
        id: randomUUID(),
        platform,
        deviceId,
        status: "recording",
        actions: [],
        startedAt: Date.now(),
      };
      sessions.set(session.id, session);
      return session;
    },

    get(sessionId) {
      return sessions.get(sessionId);
    },

    stop(sessionId) {
      const session = sessions.get(sessionId);
      if (session) session.status = "stopped";
    },

    addAction(sessionId, action) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      const id = randomUUID();
      session.actions.push({ ...action, id });
      return id;
    },

    deleteAction(sessionId, actionId) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      session.actions = session.actions.filter((a) => a.id !== actionId);
    },

    reorderActions(sessionId, actionIds) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      const byId = new Map(session.actions.map((a) => [a.id, a]));
      session.actions = actionIds
        .map((id) => byId.get(id))
        .filter((a): a is RecordedAction & { id: string } => a !== undefined);
    },

    updateSelector(sessionId, actionId, selector) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      const action = session.actions.find((a) => a.id === actionId);
      if (action) action.selector = selector;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/spana && bun test src/studio/recording-session.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/spana/src/studio/recording-session.ts packages/spana/src/studio/recording-session.test.ts
git commit -m "feat(studio): add recording session state management"
```

---

### Task 2: Flow Code Generator

**Files:**

- Create: `packages/spana/src/core/flow-generator.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/spana/src/core/flow-generator.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { generateFlowCode } from "./flow-generator.js";
import type { RecordedAction } from "../studio/recording-session.js";

function action(
  overrides: Partial<RecordedAction> & Pick<RecordedAction, "type">,
): RecordedAction & { id: string } {
  return {
    id: "test",
    selectorAlternatives: [],
    params: {},
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("generateFlowCode", () => {
  it("generates a simple tap flow", () => {
    const code = generateFlowCode("Login test", [
      action({ type: "tap", selector: { testID: "login-btn" } }),
    ]);
    expect(code).toContain('import { flow } from "spana-test"');
    expect(code).toContain('"Login test"');
    expect(code).toContain('await app.tap({ testID: "login-btn" })');
  });

  it("generates inputText with text param", () => {
    const code = generateFlowCode("Input test", [
      action({
        type: "inputText",
        selector: { testID: "email" },
        params: { text: "user@test.com" },
      }),
    ]);
    expect(code).toContain('await app.inputText("user@test.com")');
  });

  it("generates scroll with direction param", () => {
    const code = generateFlowCode("Scroll test", [
      action({ type: "scroll", params: { direction: "down" } }),
    ]);
    expect(code).toContain('await app.scroll("down")');
  });

  it("generates expect assertions", () => {
    const code = generateFlowCode("Assert test", [
      action({
        type: "expect.toBeVisible",
        selector: { text: "Welcome" },
      }),
    ]);
    expect(code).toContain('await expect({ text: "Welcome" }).toBeVisible()');
  });

  it("generates expect.toHaveText with expected param", () => {
    const code = generateFlowCode("Text assert", [
      action({
        type: "expect.toHaveText",
        selector: { testID: "title" },
        params: { expected: "Dashboard" },
      }),
    ]);
    expect(code).toContain('await expect({ testID: "title" }).toHaveText("Dashboard")');
  });

  it("generates back without selector", () => {
    const code = generateFlowCode("Back test", [action({ type: "back" })]);
    expect(code).toContain("await app.back()");
  });

  it("generates pressKey with key param", () => {
    const code = generateFlowCode("Key test", [
      action({ type: "pressKey", params: { key: "Enter" } }),
    ]);
    expect(code).toContain('await app.pressKey("Enter")');
  });

  it("generates swipe with direction param", () => {
    const code = generateFlowCode("Swipe test", [
      action({ type: "swipe", params: { direction: "left" } }),
    ]);
    expect(code).toContain('await app.swipe("left")');
  });

  it("handles accessibilityLabel selectors", () => {
    const code = generateFlowCode("A11y test", [
      action({
        type: "tap",
        selector: { accessibilityLabel: "Close dialog" },
      }),
    ]);
    expect(code).toContain('await app.tap({ accessibilityLabel: "Close dialog" })');
  });

  it("generates a multi-step flow in order", () => {
    const code = generateFlowCode("Multi step", [
      action({ type: "tap", selector: { testID: "email" } }),
      action({
        type: "inputText",
        selector: { testID: "email" },
        params: { text: "a@b.com" },
      }),
      action({ type: "tap", selector: { testID: "submit" } }),
      action({
        type: "expect.toBeVisible",
        selector: { testID: "dashboard" },
      }),
    ]);
    const lines = code.split("\n");
    const tapIdx = lines.findIndex((l) => l.includes("app.tap"));
    const inputIdx = lines.findIndex((l) => l.includes("app.inputText"));
    const submitIdx = lines.findIndex((l) => l.includes('app.tap({ testID: "submit" })'));
    const expectIdx = lines.findIndex((l) => l.includes("expect("));
    expect(tapIdx).toBeLessThan(inputIdx);
    expect(inputIdx).toBeLessThan(submitIdx);
    expect(submitIdx).toBeLessThan(expectIdx);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/spana && bun test src/core/flow-generator.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `packages/spana/src/core/flow-generator.ts`:

```typescript
import type { Selector } from "../schemas/selector.js";
import type { RecordedAction } from "../studio/recording-session.js";

function formatSelector(selector: Selector): string {
  if (typeof selector === "string") return `"${selector}"`;
  if ("testID" in selector) return `{ testID: "${selector.testID}" }`;
  if ("text" in selector) return `{ text: "${selector.text}" }`;
  if ("accessibilityLabel" in selector)
    return `{ accessibilityLabel: "${selector.accessibilityLabel}" }`;
  if ("point" in selector) return `{ point: { x: ${selector.point.x}, y: ${selector.point.y} } }`;
  return "{}";
}

function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function actionToCode(action: RecordedAction): string {
  const sel = action.selector ? formatSelector(action.selector) : undefined;

  switch (action.type) {
    case "tap":
      return sel ? `await app.tap(${sel});` : "await app.tap();";
    case "doubleTap":
      return sel ? `await app.doubleTap(${sel});` : "await app.doubleTap();";
    case "longPress":
      return sel ? `await app.longPress(${sel});` : "await app.longPress();";
    case "inputText": {
      const text = escapeString(String(action.params.text ?? ""));
      return `await app.inputText("${text}");`;
    }
    case "scroll": {
      const dir = String(action.params.direction ?? "down");
      return `await app.scroll("${dir}");`;
    }
    case "swipe": {
      const dir = String(action.params.direction ?? "up");
      return `await app.swipe("${dir}");`;
    }
    case "pressKey": {
      const key = escapeString(String(action.params.key ?? "Enter"));
      return `await app.pressKey("${key}");`;
    }
    case "back":
      return "await app.back();";
    case "expect.toBeVisible":
      return sel ? `await expect(${sel}).toBeVisible();` : "await expect().toBeVisible();";
    case "expect.toHaveText": {
      const expected = escapeString(String(action.params.expected ?? ""));
      return sel
        ? `await expect(${sel}).toHaveText("${expected}");`
        : `await expect().toHaveText("${expected}");`;
    }
    default:
      return `// Unknown action: ${action.type}`;
  }
}

export function generateFlowCode(flowName: string, actions: RecordedAction[]): string {
  const escapedName = escapeString(flowName);
  const body = actions.map((a) => `  ${actionToCode(a)}`).join("\n");

  return `import { flow } from "spana-test";

export default flow("${escapedName}", async ({ app, expect }) => {
${body}
});
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/spana && bun test src/core/flow-generator.test.ts`
Expected: All 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/spana/src/core/flow-generator.ts packages/spana/src/core/flow-generator.test.ts
git commit -m "feat: add flow code generator for recorded actions"
```

---

### Task 3: Recording RPC Router

**Files:**

- Create: `packages/spana/src/studio/routers/recording.ts`
- Modify: `packages/spana/src/studio/api.ts`

- [ ] **Step 1: Write the recording router**

Create `packages/spana/src/studio/routers/recording.ts`:

```typescript
import { z } from "zod";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { publicProcedure } from "../procedures.js";
import { createRecordingSessionStore, type RecordingSessionStore } from "../recording-session.js";
import { generateFlowCode } from "../../core/flow-generator.js";
import { getOrCreateSession } from "./inspector.js";

const platformEnum = z.enum(["web", "android", "ios"]);

const selectorSchema = z.union([
  z.string(),
  z.object({ testID: z.string() }),
  z.object({ text: z.string() }),
  z.object({ accessibilityLabel: z.string() }),
  z.object({ point: z.object({ x: z.number(), y: z.number() }) }),
]);

const actionTypeEnum = z.enum([
  "tap",
  "doubleTap",
  "longPress",
  "inputText",
  "scroll",
  "swipe",
  "pressKey",
  "back",
  "expect.toBeVisible",
  "expect.toHaveText",
]);

const store: RecordingSessionStore = createRecordingSessionStore();

export const recordingRouter = {
  start: publicProcedure
    .input(
      z.object({
        platform: platformEnum,
        deviceId: z.string().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const session = store.start(input.platform, input.deviceId);
      return { sessionId: session.id };
    }),

  stop: publicProcedure.input(z.object({ sessionId: z.string() })).handler(async ({ input }) => {
    store.stop(input.sessionId);
  }),

  addAction: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        action: z.object({
          type: actionTypeEnum,
          selector: selectorSchema.optional(),
          selectorAlternatives: z.array(selectorSchema).default([]),
          params: z.record(z.unknown()).default({}),
          timestamp: z.number(),
          screenshotPath: z.string().optional(),
        }),
      }),
    )
    .handler(async ({ input }) => {
      const actionId = store.addAction(input.sessionId, input.action);
      return { actionId };
    }),

  deleteAction: publicProcedure
    .input(z.object({ sessionId: z.string(), actionId: z.string() }))
    .handler(async ({ input }) => {
      store.deleteAction(input.sessionId, input.actionId);
    }),

  reorderActions: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        actionIds: z.array(z.string()),
      }),
    )
    .handler(async ({ input }) => {
      store.reorderActions(input.sessionId, input.actionIds);
    }),

  updateSelector: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        actionId: z.string(),
        selector: selectorSchema,
      }),
    )
    .handler(async ({ input }) => {
      store.updateSelector(input.sessionId, input.actionId, input.selector);
    }),

  getSession: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async ({ input }) => {
      const session = store.get(input.sessionId);
      if (!session) throw new Error(`Session ${input.sessionId} not found`);
      return session;
    }),

  generateCode: publicProcedure
    .input(z.object({ sessionId: z.string(), flowName: z.string() }))
    .handler(async ({ input }) => {
      const session = store.get(input.sessionId);
      if (!session) throw new Error(`Session ${input.sessionId} not found`);
      return { code: generateFlowCode(input.flowName, session.actions) };
    }),

  save: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        flowName: z.string(),
        flowDir: z.string().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const session = store.get(input.sessionId);
      if (!session) throw new Error(`Session ${input.sessionId} not found`);

      const code = generateFlowCode(input.flowName, session.actions);
      const safeName = input.flowName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const flowDir = input.flowDir ?? context?.config?.flowDir ?? "flows";
      const filePath = resolve(flowDir, `${safeName}.flow.ts`);

      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, code, "utf-8");

      return { filePath, code };
    }),

  executeAction: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        platform: platformEnum,
        deviceId: z.string().optional(),
        actionType: actionTypeEnum,
        selector: selectorSchema.optional(),
        params: z.record(z.unknown()).default({}),
      }),
    )
    .handler(async ({ input, context }) => {
      const session = getOrCreateSession(input.platform, context.config, input.deviceId);

      const sel = input.selector;

      switch (input.actionType) {
        case "tap":
          if (sel) await session.tap(sel);
          break;
        case "doubleTap":
          if (sel) await session.doubleTap(sel);
          break;
        case "longPress":
          if (sel) await session.longPress(sel);
          break;
        case "inputText":
          await session.inputText(String(input.params.text ?? ""));
          break;
        case "scroll":
          await session.scroll(
            (input.params.direction as "up" | "down" | "left" | "right") ?? "down",
          );
          break;
        case "swipe":
          await session.swipe((input.params.direction as "up" | "down" | "left" | "right") ?? "up");
          break;
        case "pressKey":
          await session.pressKey(String(input.params.key ?? "Enter"));
          break;
        case "back":
          await session.back();
          break;
        default:
          break;
      }

      // Capture selectors for the tapped element if a selector was used
      let selectorAlternatives: unknown[] = [];
      if (sel) {
        try {
          const selectors = await session.selectors();
          const matching = selectors.filter(
            (s: any) =>
              (sel && "testID" in sel && s.testID === (sel as any).testID) ||
              (sel && "text" in sel && s.text === (sel as any).text),
          );
          selectorAlternatives = matching.flatMap((s: any) => s.suggestedSelectors ?? []);
        } catch {
          // Selector lookup is best-effort
        }
      }

      return { selectorAlternatives };
    }),
};
```

- [ ] **Step 2: Register the router in api.ts**

Modify `packages/spana/src/studio/api.ts` — add the recording router:

```typescript
import { devicesRouter } from "./routers/devices.js";
import { inspectorRouter } from "./routers/inspector.js";
import { testsRouter } from "./routers/tests.js";
import { recordingRouter } from "./routers/recording.js";

export { o, publicProcedure } from "./procedures.js";

export const studioRouter = {
  devices: devicesRouter,
  inspector: inspectorRouter,
  tests: testsRouter,
  recording: recordingRouter,
};
export type StudioRouter = typeof studioRouter;
```

- [ ] **Step 3: Verify the build compiles**

Run: `cd packages/spana && bun build src/studio/api.ts --no-bundle --outdir /tmp/check-build 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add packages/spana/src/studio/routers/recording.ts packages/spana/src/studio/api.ts
git commit -m "feat(studio): add recording RPC router with session management"
```

---

### Task 4: Recorder Page — Basic Layout and Navigation

**Files:**

- Create: `apps/studio/src/pages/recorder.tsx`
- Modify: `apps/studio/src/main.tsx`

- [ ] **Step 1: Create the Recorder page skeleton**

Create `apps/studio/src/pages/recorder.tsx`:

```tsx
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { client, orpc } from "../lib/client";

type RecordingState = "idle" | "recording" | "stopped";

interface RecordedActionEntry {
  id: string;
  type: string;
  selector?: unknown;
  selectorAlternatives: unknown[];
  params: Record<string, unknown>;
  timestamp: number;
}

export function RecorderPage() {
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [platform, setPlatform] = useState<"web" | "android" | "ios">("web");
  const [actions, setActions] = useState<RecordedActionEntry[]>([]);
  const [flowName, setFlowName] = useState("");
  const [generatedCode, setGeneratedCode] = useState("");

  const startMutation = useMutation({
    mutationFn: () => client.recording.start({ platform }),
    onSuccess: (data) => {
      setSessionId(data.sessionId);
      setRecordingState("recording");
      setActions([]);
      setGeneratedCode("");
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => {
      if (!sessionId) throw new Error("No session");
      return client.recording.stop({ sessionId });
    },
    onSuccess: () => setRecordingState("stopped"),
  });

  const generateMutation = useMutation({
    mutationFn: () => {
      if (!sessionId) throw new Error("No session");
      return client.recording.generateCode({
        sessionId,
        flowName: flowName || "Recorded flow",
      });
    },
    onSuccess: (data) => setGeneratedCode(data.code),
  });

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!sessionId) throw new Error("No session");
      return client.recording.save({
        sessionId,
        flowName: flowName || "Recorded flow",
      });
    },
  });

  const deleteActionMutation = useMutation({
    mutationFn: (actionId: string) => {
      if (!sessionId) throw new Error("No session");
      return client.recording.deleteAction({ sessionId, actionId });
    },
    onSuccess: (_, actionId) => {
      setActions((prev) => prev.filter((a) => a.id !== actionId));
    },
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Top controls */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid #262626",
          display: "flex",
          alignItems: "center",
          gap: "12px",
        }}
      >
        {recordingState === "idle" && (
          <>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value as "web" | "android" | "ios")}
              style={{
                background: "#1a1a1a",
                color: "#e5e5e5",
                border: "1px solid #333",
                borderRadius: "6px",
                padding: "6px 10px",
              }}
            >
              <option value="web">Web</option>
              <option value="android">Android</option>
              <option value="ios">iOS</option>
            </select>
            <button
              onClick={() => startMutation.mutate()}
              style={{
                background: "#dc2626",
                color: "white",
                border: "none",
                borderRadius: "6px",
                padding: "6px 16px",
                cursor: "pointer",
              }}
            >
              Start Recording
            </button>
          </>
        )}
        {recordingState === "recording" && (
          <>
            <span
              style={{
                color: "#dc2626",
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "#dc2626",
                  animation: "pulse 1s infinite",
                }}
              />
              Recording — {platform}
            </span>
            <button
              onClick={() => stopMutation.mutate()}
              style={{
                background: "#333",
                color: "white",
                border: "none",
                borderRadius: "6px",
                padding: "6px 16px",
                cursor: "pointer",
              }}
            >
              Stop & Review
            </button>
          </>
        )}
        {recordingState === "stopped" && (
          <>
            <input
              type="text"
              placeholder="Flow name..."
              value={flowName}
              onChange={(e) => setFlowName(e.target.value)}
              style={{
                background: "#1a1a1a",
                color: "#e5e5e5",
                border: "1px solid #333",
                borderRadius: "6px",
                padding: "6px 10px",
                flex: 1,
                maxWidth: 300,
              }}
            />
            <button
              onClick={() => generateMutation.mutate()}
              style={{
                background: "#2563eb",
                color: "white",
                border: "none",
                borderRadius: "6px",
                padding: "6px 16px",
                cursor: "pointer",
              }}
            >
              Generate Code
            </button>
            <button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              style={{
                background: "#16a34a",
                color: "white",
                border: "none",
                borderRadius: "6px",
                padding: "6px 16px",
                cursor: "pointer",
              }}
            >
              {saveMutation.isPending ? "Saving..." : "Save Flow"}
            </button>
            <button
              onClick={() => {
                setRecordingState("idle");
                setSessionId(null);
                setActions([]);
                setGeneratedCode("");
                setFlowName("");
              }}
              style={{
                background: "#333",
                color: "white",
                border: "none",
                borderRadius: "6px",
                padding: "6px 16px",
                cursor: "pointer",
              }}
            >
              New Recording
            </button>
          </>
        )}
      </div>

      {/* Main content: timeline + code preview */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Action timeline */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px",
            borderRight: "1px solid #262626",
          }}
        >
          <h3
            style={{
              margin: "0 0 12px",
              color: "#a3a3a3",
              fontSize: 13,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Actions ({actions.length})
          </h3>
          {actions.length === 0 && (
            <p style={{ color: "#737373", fontSize: 14 }}>
              {recordingState === "recording"
                ? "Interact with the device to record actions..."
                : "No actions recorded."}
            </p>
          )}
          {actions.map((action, idx) => (
            <div
              key={action.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 12px",
                marginBottom: "4px",
                background: "#1a1a1a",
                borderRadius: "6px",
                fontSize: 13,
              }}
            >
              <span style={{ color: "#737373", minWidth: 24 }}>{idx + 1}.</span>
              <span style={{ color: "#e5e5e5", flex: 1 }}>
                {action.type}
                {action.selector && (
                  <span style={{ color: "#60a5fa", marginLeft: 6 }}>
                    {JSON.stringify(action.selector)}
                  </span>
                )}
                {action.params.text && (
                  <span style={{ color: "#a78bfa", marginLeft: 6 }}>
                    "{String(action.params.text)}"
                  </span>
                )}
              </span>
              <button
                onClick={() => deleteActionMutation.mutate(action.id)}
                style={{
                  background: "none",
                  border: "none",
                  color: "#737373",
                  cursor: "pointer",
                  fontSize: 16,
                }}
                title="Delete action"
              >
                ×
              </button>
            </div>
          ))}
          {saveMutation.isSuccess && (
            <div
              style={{
                marginTop: 16,
                padding: "12px",
                background: "#052e16",
                border: "1px solid #16a34a",
                borderRadius: "6px",
                color: "#4ade80",
                fontSize: 13,
              }}
            >
              Flow saved to: {(saveMutation.data as any)?.filePath}
            </div>
          )}
        </div>

        {/* Code preview */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px",
            background: "#0a0a0a",
          }}
        >
          <h3
            style={{
              margin: "0 0 12px",
              color: "#a3a3a3",
              fontSize: 13,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Generated Code
          </h3>
          <pre
            style={{
              color: "#e5e5e5",
              fontSize: 13,
              fontFamily: "monospace",
              whiteSpace: "pre-wrap",
              lineHeight: 1.6,
              margin: 0,
            }}
          >
            {generatedCode ||
              (actions.length > 0
                ? "Click 'Generate Code' to preview..."
                : "Record some actions to see generated code here.")}
          </pre>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add Recorder tab to main.tsx**

Modify `apps/studio/src/main.tsx` — add "recorder" to the Page type and navigation:

Add import at top:

```typescript
import { RecorderPage } from "./pages/recorder";
```

Change the `Page` type to:

```typescript
type Page = "inspector" | "runner" | "recorder";
```

Add a third nav button after the Runner button (copy the Runner button pattern), with `page === "recorder"` conditional styling and `onClick={() => setPage("recorder")}`, label "Recorder".

Add rendering below the runner section:

```tsx
<div className={page === "recorder" ? "" : "hidden"} style={{ flex: 1 }}>
  <RecorderPage />
</div>
```

- [ ] **Step 3: Verify Studio builds**

Run: `cd apps/studio && bun run build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add apps/studio/src/pages/recorder.tsx apps/studio/src/main.tsx
git commit -m "feat(studio): add Recorder page with action timeline and code preview"
```

---

### Task 5: Inspector Integration for Recording Actions

**Files:**

- Modify: `apps/studio/src/pages/recorder.tsx`

This task wires up the inspector's screenshot/element selection to the recorder, so clicking an element on the screenshot during recording triggers action capture.

- [ ] **Step 1: Add screenshot and element selection to recorder**

Modify `apps/studio/src/pages/recorder.tsx` to:

1. Add screenshot query (reuse inspector pattern):

```typescript
const screenshotQuery = useQuery({
  queryKey: ["recording-screenshot", platform, sessionId],
  queryFn: () => client.inspector.screenshot({ platform }),
  enabled: recordingState === "recording",
  refetchInterval: recordingState === "recording" ? 1000 : false,
});
```

2. Add hierarchy query for element picking:

```typescript
const hierarchyQuery = useQuery({
  queryKey: ["recording-hierarchy", platform, sessionId],
  queryFn: () => client.inspector.hierarchy({ platform }),
  enabled: recordingState === "recording",
  refetchInterval: recordingState === "recording" ? 2000 : false,
});
```

3. Add selectors query for alternatives:

```typescript
const selectorsQuery = useQuery({
  queryKey: ["recording-selectors", platform, sessionId],
  queryFn: () => client.inspector.selectors({ platform }),
  enabled: recordingState === "recording",
  refetchInterval: recordingState === "recording" ? 2000 : false,
});
```

4. Add action picker state and handler:

```typescript
const [pickerTarget, setPickerTarget] = useState<{
  selector: unknown;
  alternatives: unknown[];
  bounds: { x: number; y: number; width: number; height: number };
} | null>(null);

const executeAndRecord = useMutation({
  mutationFn: async (params: {
    actionType: string;
    selector?: unknown;
    actionParams?: Record<string, unknown>;
  }) => {
    if (!sessionId) throw new Error("No session");

    // Execute the action on device
    await client.recording.executeAction({
      sessionId,
      platform,
      actionType: params.actionType as any,
      selector: params.selector as any,
      params: params.actionParams ?? {},
    });

    // Record the action
    const { actionId } = await client.recording.addAction({
      sessionId,
      action: {
        type: params.actionType as any,
        selector: params.selector as any,
        selectorAlternatives: [],
        params: params.actionParams ?? {},
        timestamp: Date.now(),
      },
    });

    return actionId;
  },
  onSuccess: () => {
    setPickerTarget(null);
    // Refresh session to get updated actions
    if (sessionId) {
      client.recording.getSession({ sessionId }).then((s) => {
        setActions(s.actions as RecordedActionEntry[]);
      });
    }
  },
});
```

5. Update the main content area to show screenshot on the left (during recording) with click handler that finds the nearest element and shows action picker, and timeline on the right.

6. Add a simple action picker overlay when `pickerTarget` is set:

```tsx
{
  pickerTarget && (
    <div
      style={{
        position: "absolute",
        top: pickerTarget.bounds.y,
        left: pickerTarget.bounds.x,
        background: "#1a1a1a",
        border: "1px solid #333",
        borderRadius: 6,
        padding: 4,
        zIndex: 10,
        display: "flex",
        gap: 4,
      }}
    >
      {["tap", "doubleTap", "longPress", "inputText", "expect.toBeVisible"].map((action) => (
        <button
          key={action}
          onClick={() => {
            const params: Record<string, unknown> = {};
            if (action === "inputText") {
              const text = prompt("Enter text:");
              if (text === null) return;
              params.text = text;
            }
            executeAndRecord.mutate({
              actionType: action,
              selector: pickerTarget.selector,
              actionParams: params,
            });
          }}
          style={{
            background: "#262626",
            color: "#e5e5e5",
            border: "none",
            borderRadius: 4,
            padding: "4px 8px",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          {action}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Verify Studio builds**

Run: `cd apps/studio && bun run build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add apps/studio/src/pages/recorder.tsx
git commit -m "feat(studio): wire inspector screenshot/elements to recorder actions"
```

---

### Task 6: Watch Mode — Hierarchy Change Detection

**Files:**

- Modify: `apps/studio/src/pages/recorder.tsx`

- [ ] **Step 1: Add watch mode state and polling**

Add to `RecorderPage`:

```typescript
const [watchMode, setWatchMode] = useState(false);
const [lastHierarchyHash, setLastHierarchyHash] = useState<string | null>(null);
const [watchPrompt, setWatchPrompt] = useState(false);

// Simple hash of hierarchy to detect changes
function hashHierarchy(hierarchy: unknown): string {
  const str = JSON.stringify(hierarchy);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return String(hash);
}
```

Add a `useEffect` that polls hierarchy when watch mode is on:

```typescript
useEffect(() => {
  if (!watchMode || recordingState !== "recording") return;
  const interval = setInterval(async () => {
    try {
      const hierarchy = await client.inspector.hierarchy({ platform });
      const hash = hashHierarchy(hierarchy);
      if (lastHierarchyHash !== null && hash !== lastHierarchyHash) {
        setWatchPrompt(true);
        clearInterval(interval);
      }
      setLastHierarchyHash(hash);
    } catch {
      /* ignore polling errors */
    }
  }, 1500);
  return () => clearInterval(interval);
}, [watchMode, recordingState, platform, lastHierarchyHash]);
```

- [ ] **Step 2: Add watch mode toggle to controls bar**

In the recording state controls area, add:

```tsx
<label
  style={{ display: "flex", alignItems: "center", gap: "6px", color: "#a3a3a3", fontSize: 13 }}
>
  <input
    type="checkbox"
    checked={watchMode}
    onChange={(e) => {
      setWatchMode(e.target.checked);
      if (e.target.checked) setLastHierarchyHash(null);
    }}
  />
  Watch Mode
</label>
```

- [ ] **Step 3: Add watch prompt dialog**

Add below the controls bar when `watchPrompt` is true:

```tsx
{
  watchPrompt && (
    <div
      style={{
        padding: "12px 16px",
        background: "#1e1b4b",
        borderBottom: "1px solid #4338ca",
        display: "flex",
        alignItems: "center",
        gap: "8px",
      }}
    >
      <span style={{ color: "#c4b5fd", fontSize: 13 }}>Screen changed — what did you just do?</span>
      {["tap", "inputText", "scroll", "swipe", "back"].map((action) => (
        <button
          key={action}
          onClick={() => {
            const params: Record<string, unknown> = {};
            if (action === "inputText") {
              const text = prompt("What text did you enter?");
              if (text === null) return;
              params.text = text;
            }
            if (action === "scroll" || action === "swipe") {
              const dir = prompt("Direction? (up/down/left/right)");
              if (dir === null) return;
              params.direction = dir;
            }
            if (sessionId) {
              client.recording
                .addAction({
                  sessionId,
                  action: {
                    type: action as any,
                    selectorAlternatives: [],
                    params,
                    timestamp: Date.now(),
                  },
                })
                .then(() => {
                  client.recording.getSession({ sessionId }).then((s) => {
                    setActions(s.actions as RecordedActionEntry[]);
                  });
                });
            }
            setWatchPrompt(false);
            setLastHierarchyHash(null);
          }}
          style={{
            background: "#312e81",
            color: "#e5e5e5",
            border: "1px solid #4338ca",
            borderRadius: 4,
            padding: "4px 10px",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          {action}
        </button>
      ))}
      <button
        onClick={() => {
          setWatchPrompt(false);
          setLastHierarchyHash(null);
        }}
        style={{
          background: "none",
          border: "none",
          color: "#737373",
          cursor: "pointer",
          marginLeft: "auto",
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Verify Studio builds**

Run: `cd apps/studio && bun run build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add apps/studio/src/pages/recorder.tsx
git commit -m "feat(studio): add watch mode for detecting external device interactions"
```

---

### Task 7: Live Code Preview Auto-Update

**Files:**

- Modify: `apps/studio/src/pages/recorder.tsx`

- [ ] **Step 1: Auto-generate code when actions change**

Add a `useEffect` that regenerates code whenever the actions array changes:

```typescript
useEffect(() => {
  if (!sessionId || actions.length === 0) {
    setGeneratedCode("");
    return;
  }
  client.recording
    .generateCode({
      sessionId,
      flowName: flowName || "Recorded flow",
    })
    .then((data) => setGeneratedCode(data.code))
    .catch(() => {});
}, [sessionId, actions, flowName]);
```

Remove the separate "Generate Code" button — code now updates live. Keep the button only in the `stopped` state as a manual refresh option.

- [ ] **Step 2: Verify Studio builds**

Run: `cd apps/studio && bun run build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add apps/studio/src/pages/recorder.tsx
git commit -m "feat(studio): auto-update code preview as actions are recorded"
```

---

### Task 8: Export getOrCreateSession from Inspector Router

**Files:**

- Modify: `packages/spana/src/studio/routers/inspector.ts`

- [ ] **Step 1: Verify getOrCreateSession is exported**

Check if `getOrCreateSession` is already exported from `inspector.ts`. If not, add `export` to its declaration. The recording router imports it to execute actions on the device.

Run: `grep -n "function getOrCreateSession\|export.*getOrCreateSession" packages/spana/src/studio/routers/inspector.ts`

If not exported, add `export` keyword to the function declaration.

- [ ] **Step 2: Commit if changed**

```bash
git add packages/spana/src/studio/routers/inspector.ts
git commit -m "refactor(studio): export getOrCreateSession for recording router"
```

---

### Task 9: End-to-End Integration Test

**Files:**

- Create: `packages/spana/src/studio/recording-integration.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
import { describe, expect, it } from "bun:test";
import { createRecordingSessionStore } from "./recording-session.js";
import { generateFlowCode } from "../core/flow-generator.js";

describe("Recording → Code Generation integration", () => {
  it("records a login flow and generates valid code", () => {
    const store = createRecordingSessionStore();
    const session = store.start("web");

    store.addAction(session.id, {
      type: "tap",
      selector: { testID: "email-input" },
      selectorAlternatives: [{ text: "Email" }],
      params: {},
      timestamp: 1,
    });
    store.addAction(session.id, {
      type: "inputText",
      selector: { testID: "email-input" },
      selectorAlternatives: [],
      params: { text: "user@test.com" },
      timestamp: 2,
    });
    store.addAction(session.id, {
      type: "tap",
      selector: { testID: "login-btn" },
      selectorAlternatives: [{ accessibilityLabel: "Log in" }],
      params: {},
      timestamp: 3,
    });
    store.addAction(session.id, {
      type: "expect.toBeVisible",
      selector: { testID: "dashboard" },
      selectorAlternatives: [],
      params: {},
      timestamp: 4,
    });

    store.stop(session.id);
    const stopped = store.get(session.id)!;
    expect(stopped.status).toBe("stopped");

    const code = generateFlowCode("Login flow", stopped.actions);
    expect(code).toContain('import { flow } from "spana-test"');
    expect(code).toContain('"Login flow"');
    expect(code).toContain('app.tap({ testID: "email-input" })');
    expect(code).toContain('app.inputText("user@test.com")');
    expect(code).toContain('app.tap({ testID: "login-btn" })');
    expect(code).toContain('expect({ testID: "dashboard" }).toBeVisible()');
  });

  it("supports reordering before generation", () => {
    const store = createRecordingSessionStore();
    const session = store.start("web");

    const id1 = store.addAction(session.id, {
      type: "tap",
      selector: { text: "First" },
      selectorAlternatives: [],
      params: {},
      timestamp: 1,
    });
    const id2 = store.addAction(session.id, {
      type: "tap",
      selector: { text: "Second" },
      selectorAlternatives: [],
      params: {},
      timestamp: 2,
    });

    store.reorderActions(session.id, [id2, id1]);
    const code = generateFlowCode("Reorder test", store.get(session.id)!.actions);
    const secondIdx = code.indexOf('"Second"');
    const firstIdx = code.indexOf('"First"');
    expect(secondIdx).toBeLessThan(firstIdx);
  });

  it("supports selector swap before generation", () => {
    const store = createRecordingSessionStore();
    const session = store.start("android");

    const actionId = store.addAction(session.id, {
      type: "tap",
      selector: { text: "Submit" },
      selectorAlternatives: [{ testID: "submit-btn" }],
      params: {},
      timestamp: 1,
    });

    store.updateSelector(session.id, actionId, { testID: "submit-btn" });
    const code = generateFlowCode("Selector swap", store.get(session.id)!.actions);
    expect(code).toContain('testID: "submit-btn"');
    expect(code).not.toContain('text: "Submit"');
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `cd packages/spana && bun test src/studio/recording-integration.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/spana/src/studio/recording-integration.test.ts
git commit -m "test(studio): add recording-to-code integration tests"
```
