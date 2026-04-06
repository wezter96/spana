import { describe, expect, test } from "bun:test";
import type { Element } from "../schemas/element.js";
import {
  centerOf,
  findElement,
  flattenElements,
  matchesSelector,
  formatSelector,
} from "./element-matcher.js";

function makeElement(overrides: Partial<Element> = {}): Element {
  return {
    elementType: "View",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    ...overrides,
  };
}

describe("element-matcher", () => {
  test("flattenElements returns a depth-first list", () => {
    const tree = makeElement({
      id: "root",
      children: [
        makeElement({ id: "child-1" }),
        makeElement({
          id: "child-2",
          children: [makeElement({ id: "grandchild" })],
        }),
      ],
    });

    expect(flattenElements(tree).map((element) => element.id)).toEqual([
      "root",
      "child-1",
      "child-2",
      "grandchild",
    ]);
  });

  test("matchesSelector supports text, testID, and point selectors", () => {
    const element = makeElement({
      id: "login-button",
      text: "Log In",
      accessibilityLabel: "Log in",
      bounds: { x: 10, y: 20, width: 80, height: 40 },
    });

    expect(matchesSelector(element, { testID: "login-button" })).toBe(true);
    expect(matchesSelector(element, { text: "log in" })).toBe(true);
    expect(matchesSelector(element, { accessibilityLabel: "Log in" })).toBe(true);
    expect(matchesSelector(element, { point: { x: 30, y: 40 } })).toBe(true);
    expect(matchesSelector(element, { point: { x: 200, y: 200 } })).toBe(false);
  });

  test("findElement prefers the deepest clickable visible match", () => {
    const target = makeElement({
      id: "cta",
      clickable: true,
      bounds: { x: 20, y: 20, width: 40, height: 20 },
    });

    const tree = makeElement({
      children: [
        makeElement({
          id: "cta",
          clickable: true,
          children: [target],
        }),
        makeElement({
          id: "cta",
          clickable: true,
          visible: false,
        }),
      ],
    });

    expect(findElement(tree, { testID: "cta" })).toBe(target);
  });

  test("centerOf rounds the midpoint of bounds", () => {
    expect(
      centerOf(
        makeElement({
          bounds: { x: 11, y: 21, width: 79, height: 39 },
        }),
      ),
    ).toEqual({ x: 51, y: 41 });
  });
});

describe("formatSelector", () => {
  test("formats string selector", () => {
    expect(formatSelector("Login")).toBe('"Login"');
  });

  test("formats testID selector", () => {
    expect(formatSelector({ testID: "btn-submit" })).toBe('testID: "btn-submit"');
  });

  test("formats text selector", () => {
    expect(formatSelector({ text: "Submit" })).toBe('text: "Submit"');
  });

  test("formats accessibilityLabel selector", () => {
    expect(formatSelector({ accessibilityLabel: "Close" })).toBe('accessibilityLabel: "Close"');
  });

  test("formats point selector", () => {
    expect(formatSelector({ point: { x: 10, y: 20 } })).toBe("point: (10, 20)");
  });

  test("formats relative selector", () => {
    expect(formatSelector({ selector: { text: "Submit" }, below: { text: "Email" } })).toBe(
      'text: "Submit" below text: "Email"',
    );
  });

  test("formats relative selector with multiple constraints", () => {
    expect(
      formatSelector({ selector: { testID: "btn" }, below: "Header", rightOf: { text: "Label" } }),
    ).toBe('testID: "btn" below "Header" rightOf text: "Label"');
  });
});
