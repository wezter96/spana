import { describe, it, expect, beforeEach } from "bun:test";
import { createRecordingSessionStore } from "./recording-session.js";
import { generateFlowCode } from "../core/flow-generator.js";
import type { RecordingSessionStore } from "./recording-session.js";

describe("recording-to-code integration", () => {
  let store: RecordingSessionStore;

  beforeEach(() => {
    store = createRecordingSessionStore();
  });

  it("records a login flow and generates code with all expected calls", () => {
    const session = store.start("ios");

    store.addAction(session.id, {
      type: "tap",
      selector: { testID: "email-input" },
      selectorAlternatives: [],
      params: {},
      timestamp: 1000,
    });
    store.addAction(session.id, {
      type: "inputText",
      selector: { testID: "email-input" },
      selectorAlternatives: [],
      params: { text: "user@example.com" },
      timestamp: 1100,
    });
    store.addAction(session.id, {
      type: "tap",
      selector: { testID: "login-button" },
      selectorAlternatives: [],
      params: {},
      timestamp: 1200,
    });
    store.addAction(session.id, {
      type: "expect.toBeVisible",
      selector: { testID: "dashboard" },
      selectorAlternatives: [],
      params: {},
      timestamp: 1300,
    });

    store.stop(session.id);

    const finalSession = store.get(session.id)!;
    const code = generateFlowCode("Login Flow", finalSession.actions);

    expect(code).toContain(`await app.tap({ testID: "email-input" });`);
    expect(code).toContain(`await app.inputText("user@example.com", { testID: "email-input" });`);
    expect(code).toContain(`await app.tap({ testID: "login-button" });`);
    expect(code).toContain(`await expect({ testID: "dashboard" }).toBeVisible();`);
    expect(code).toContain(`flow("Login Flow",`);
  });

  it("reorders actions before generation and verifies output order", () => {
    const session = store.start("android");

    const a1 = store.addAction(session.id, {
      type: "tap",
      selector: { testID: "step-one" },
      selectorAlternatives: [],
      params: {},
      timestamp: 1000,
    })!;
    const a2 = store.addAction(session.id, {
      type: "inputText",
      selector: { testID: "step-two" },
      selectorAlternatives: [],
      params: { text: "hello" },
      timestamp: 1100,
    })!;
    const a3 = store.addAction(session.id, {
      type: "expect.toBeVisible",
      selector: { testID: "step-three" },
      selectorAlternatives: [],
      params: {},
      timestamp: 1200,
    })!;

    // Reorder: a3, a1, a2
    store.reorderActions(session.id, [a3.id, a1.id, a2.id]);

    const finalSession = store.get(session.id)!;
    const code = generateFlowCode("Reordered Flow", finalSession.actions);

    const expectIdx = code.indexOf(`expect({ testID: "step-three" })`);
    const tapIdx = code.indexOf(`app.tap({ testID: "step-one" })`);
    const inputIdx = code.indexOf(`app.inputText("hello", { testID: "step-two" })`);

    expect(expectIdx).toBeLessThan(tapIdx);
    expect(tapIdx).toBeLessThan(inputIdx);
  });

  it("swaps a selector before generation and verifies output uses the new selector", () => {
    const session = store.start("ios");

    const action = store.addAction(session.id, {
      type: "tap",
      selector: { testID: "old-button" },
      selectorAlternatives: [{ accessibilityLabel: "Submit" }],
      params: {},
      timestamp: 1000,
    })!;

    // Swap to the alternative selector
    store.updateSelector(session.id, action.id, { accessibilityLabel: "Submit" });

    const finalSession = store.get(session.id)!;
    const code = generateFlowCode("Selector Swap Flow", finalSession.actions);

    expect(code).toContain(`await app.tap({ accessibilityLabel: "Submit" });`);
    expect(code).not.toContain(`testID: "old-button"`);
  });
});
