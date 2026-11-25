import type { Selector } from "../schemas/selector.js";

export type { Selector };

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

function formatSelector(selector: Selector): string {
  if (typeof selector === "string") {
    return `"${selector}"`;
  }
  if ("testID" in selector) {
    return `{ testID: "${selector.testID}" }`;
  }
  if ("text" in selector) {
    return `{ text: "${selector.text}" }`;
  }
  if ("accessibilityLabel" in selector) {
    return `{ accessibilityLabel: "${selector.accessibilityLabel}" }`;
  }
  if ("point" in selector) {
    return `{ point: { x: ${selector.point.x}, y: ${selector.point.y} } }`;
  }
  return JSON.stringify(selector);
}

function generateActionLine(action: RecordedAction): string {
  const { type, selector, params } = action;

  if (type === "expect.toBeVisible") {
    const sel = selector ? formatSelector(selector) : "undefined";
    return `await expect(${sel}).toBeVisible();`;
  }

  if (type === "expect.toHaveText") {
    const sel = selector ? formatSelector(selector) : "undefined";
    const expected =
      typeof params.expected === "string" ? params.expected : String(params.expected);
    return `await expect(${sel}).toHaveText("${expected}");`;
  }

  if (type === "back") {
    return `await app.back();`;
  }

  if (type === "pressKey") {
    const key = typeof params.key === "string" ? params.key : String(params.key);
    return `await app.pressKey("${key}");`;
  }

  if (type === "inputText") {
    const text = typeof params.text === "string" ? params.text : String(params.text);
    if (selector) {
      return `await app.inputText("${text}", ${formatSelector(selector)});`;
    }
    return `await app.inputText("${text}");`;
  }

  if (type === "scroll" || type === "swipe") {
    const direction =
      typeof params.direction === "string" ? params.direction : String(params.direction);
    if (selector) {
      return `await app.${type}("${direction}", ${formatSelector(selector)});`;
    }
    return `await app.${type}("${direction}");`;
  }

  // tap, doubleTap, longPress
  if (selector) {
    return `await app.${type}(${formatSelector(selector)});`;
  }
  return `await app.${type}();`;
}

export function generateFlowCode(flowName: string, actions: RecordedAction[]): string {
  const lines = actions.map((action) => `  ${generateActionLine(action)}`);
  const body = lines.length > 0 ? `\n${lines.join("\n")}\n` : "\n";

  return `import { flow } from "spana-test";

export default flow("${flowName}", async ({ app, expect }) => {${body}});`;
}
