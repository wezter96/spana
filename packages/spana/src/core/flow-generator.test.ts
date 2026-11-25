import { describe, expect, test } from "bun:test";
import { generateFlowCode } from "./flow-generator.js";
import type { RecordedAction } from "./flow-generator.js";

function makeAction(
  overrides: Partial<RecordedAction> & Pick<RecordedAction, "type">,
): RecordedAction {
  return {
    id: "a1",
    selectorAlternatives: [],
    params: {},
    timestamp: 0,
    ...overrides,
  };
}

describe("generateFlowCode", () => {
  test("generates minimal flow with no actions", () => {
    const code = generateFlowCode("Empty Flow", []);
    expect(code).toBe(
      `import { flow } from "spana-test";

export default flow("Empty Flow", async ({ app, expect }) => {
});`,
    );
  });

  test("tap with testID selector", () => {
    const actions: RecordedAction[] = [
      makeAction({ type: "tap", selector: { testID: "login-btn" } }),
    ];
    const code = generateFlowCode("Login", actions);
    expect(code).toContain(`  await app.tap({ testID: "login-btn" });`);
  });

  test("tap with text selector", () => {
    const actions: RecordedAction[] = [makeAction({ type: "tap", selector: { text: "Submit" } })];
    const code = generateFlowCode("Submit", actions);
    expect(code).toContain(`  await app.tap({ text: "Submit" });`);
  });

  test("tap with accessibilityLabel selector", () => {
    const actions: RecordedAction[] = [
      makeAction({ type: "tap", selector: { accessibilityLabel: "Close" } }),
    ];
    const code = generateFlowCode("Close", actions);
    expect(code).toContain(`  await app.tap({ accessibilityLabel: "Close" });`);
  });

  test("tap with string selector", () => {
    const actions: RecordedAction[] = [makeAction({ type: "tap", selector: "my-element" })];
    const code = generateFlowCode("Tap", actions);
    expect(code).toContain(`  await app.tap("my-element");`);
  });

  test("inputText with selector and text param", () => {
    const actions: RecordedAction[] = [
      makeAction({
        type: "inputText",
        selector: { testID: "email-input" },
        params: { text: "user@test.com" },
      }),
    ];
    const code = generateFlowCode("Login", actions);
    expect(code).toContain(`  await app.inputText("user@test.com", { testID: "email-input" });`);
  });

  test("inputText without selector", () => {
    const actions: RecordedAction[] = [
      makeAction({ type: "inputText", params: { text: "hello" } }),
    ];
    const code = generateFlowCode("Type", actions);
    expect(code).toContain(`  await app.inputText("hello");`);
  });

  test("doubleTap with testID selector", () => {
    const actions: RecordedAction[] = [
      makeAction({ type: "doubleTap", selector: { testID: "item" } }),
    ];
    const code = generateFlowCode("DoubleTap", actions);
    expect(code).toContain(`  await app.doubleTap({ testID: "item" });`);
  });

  test("longPress with testID selector", () => {
    const actions: RecordedAction[] = [
      makeAction({ type: "longPress", selector: { testID: "item" } }),
    ];
    const code = generateFlowCode("LongPress", actions);
    expect(code).toContain(`  await app.longPress({ testID: "item" });`);
  });

  test("scroll with direction param", () => {
    const actions: RecordedAction[] = [
      makeAction({ type: "scroll", params: { direction: "down" } }),
    ];
    const code = generateFlowCode("Scroll", actions);
    expect(code).toContain(`  await app.scroll("down");`);
  });

  test("scroll with selector and direction", () => {
    const actions: RecordedAction[] = [
      makeAction({
        type: "scroll",
        selector: { testID: "list" },
        params: { direction: "up" },
      }),
    ];
    const code = generateFlowCode("Scroll", actions);
    expect(code).toContain(`  await app.scroll("up", { testID: "list" });`);
  });

  test("swipe with direction param", () => {
    const actions: RecordedAction[] = [
      makeAction({ type: "swipe", params: { direction: "left" } }),
    ];
    const code = generateFlowCode("Swipe", actions);
    expect(code).toContain(`  await app.swipe("left");`);
  });

  test("swipe with selector", () => {
    const actions: RecordedAction[] = [
      makeAction({
        type: "swipe",
        selector: { testID: "card" },
        params: { direction: "right" },
      }),
    ];
    const code = generateFlowCode("Swipe", actions);
    expect(code).toContain(`  await app.swipe("right", { testID: "card" });`);
  });

  test("back action (no selector)", () => {
    const actions: RecordedAction[] = [makeAction({ type: "back" })];
    const code = generateFlowCode("Back", actions);
    expect(code).toContain(`  await app.back();`);
  });

  test("pressKey with key param", () => {
    const actions: RecordedAction[] = [makeAction({ type: "pressKey", params: { key: "Enter" } })];
    const code = generateFlowCode("PressKey", actions);
    expect(code).toContain(`  await app.pressKey("Enter");`);
  });

  test("expect.toBeVisible with testID selector", () => {
    const actions: RecordedAction[] = [
      makeAction({ type: "expect.toBeVisible", selector: { testID: "dashboard" } }),
    ];
    const code = generateFlowCode("Expect", actions);
    expect(code).toContain(`  await expect({ testID: "dashboard" }).toBeVisible();`);
  });

  test("expect.toHaveText with selector and expected param", () => {
    const actions: RecordedAction[] = [
      makeAction({
        type: "expect.toHaveText",
        selector: { testID: "title" },
        params: { expected: "Welcome" },
      }),
    ];
    const code = generateFlowCode("Expect", actions);
    expect(code).toContain(`  await expect({ testID: "title" }).toHaveText("Welcome");`);
  });

  test("multi-step ordering is preserved", () => {
    const actions: RecordedAction[] = [
      makeAction({ id: "1", type: "tap", selector: { testID: "login-btn" } }),
      makeAction({
        id: "2",
        type: "inputText",
        selector: { testID: "email" },
        params: { text: "user@test.com" },
      }),
      makeAction({ id: "3", type: "expect.toBeVisible", selector: { testID: "dashboard" } }),
    ];
    const code = generateFlowCode("Login Flow", actions);
    const tapIdx = code.indexOf(`app.tap(`);
    const inputIdx = code.indexOf(`app.inputText(`);
    const expectIdx = code.indexOf(`expect(`);
    expect(tapIdx).toBeLessThan(inputIdx);
    expect(inputIdx).toBeLessThan(expectIdx);
  });

  test("flow name is quoted correctly in output", () => {
    const code = generateFlowCode("My Test Flow", []);
    expect(code).toContain(`flow("My Test Flow",`);
  });

  test("full output structure matches expected template", () => {
    const actions: RecordedAction[] = [
      makeAction({ type: "tap", selector: { testID: "login-btn" } }),
      makeAction({ type: "inputText", params: { text: "user@test.com" } }),
      makeAction({ type: "expect.toBeVisible", selector: { testID: "dashboard" } }),
    ];
    const code = generateFlowCode("Login Flow", actions);
    expect(code).toBe(
      `import { flow } from "spana-test";

export default flow("Login Flow", async ({ app, expect }) => {
  await app.tap({ testID: "login-btn" });
  await app.inputText("user@test.com");
  await expect({ testID: "dashboard" }).toBeVisible();
});`,
    );
  });
});
