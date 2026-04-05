import { describe, it, expect } from "bun:test";
import { flattenTree, getElementByPath, elementsAtPoint, searchElements } from "./element-tree.js";
import type { Element } from "../../schemas/element.js";

function makeElement(overrides: Partial<Element> & { bounds: Element["bounds"] }): Element {
  return { ...overrides };
}

const tree: Element = makeElement({
  elementType: "FrameLayout",
  bounds: { x: 0, y: 0, width: 400, height: 800 },
  children: [
    makeElement({
      elementType: "TextView",
      text: "Hello World",
      resourceId: "greeting",
      bounds: { x: 10, y: 10, width: 200, height: 50 },
    }),
    makeElement({
      elementType: "Button",
      text: "Submit",
      accessibilityLabel: "submit button",
      bounds: { x: 10, y: 100, width: 200, height: 50 },
      children: [
        makeElement({
          elementType: "ImageView",
          resourceId: "icon_submit",
          bounds: { x: 20, y: 110, width: 30, height: 30 },
        }),
      ],
    }),
  ],
});

describe("flattenTree", () => {
  it("returns all elements with correct depth and path", () => {
    const flat = flattenTree(tree);
    expect(flat).toHaveLength(4);

    expect(flat[0].depth).toBe(0);
    expect(flat[0].path).toEqual([]);
    expect(flat[0].element.elementType).toBe("FrameLayout");

    expect(flat[1].depth).toBe(1);
    expect(flat[1].path).toEqual([0]);
    expect(flat[1].element.text).toBe("Hello World");

    expect(flat[2].depth).toBe(1);
    expect(flat[2].path).toEqual([1]);
    expect(flat[2].element.text).toBe("Submit");

    expect(flat[3].depth).toBe(2);
    expect(flat[3].path).toEqual([1, 0]);
    expect(flat[3].element.resourceId).toBe("icon_submit");
  });
});

describe("getElementByPath", () => {
  it("finds elements by valid path", () => {
    expect(getElementByPath(tree, [])?.elementType).toBe("FrameLayout");
    expect(getElementByPath(tree, [0])?.text).toBe("Hello World");
    expect(getElementByPath(tree, [1])?.text).toBe("Submit");
    expect(getElementByPath(tree, [1, 0])?.resourceId).toBe("icon_submit");
  });

  it("returns undefined for invalid paths", () => {
    expect(getElementByPath(tree, [5])).toBeUndefined();
    expect(getElementByPath(tree, [0, 0])).toBeUndefined();
    expect(getElementByPath(tree, [1, 1])).toBeUndefined();
  });
});

describe("elementsAtPoint", () => {
  it("returns matching elements deepest-first", () => {
    // Point inside the ImageView nested in Button
    const results = elementsAtPoint(tree, 25, 115);
    expect(results.length).toBeGreaterThanOrEqual(3);
    // Deepest first: ImageView, then Button, then FrameLayout
    expect(results[0].element.resourceId).toBe("icon_submit");
    expect(results[1].element.text).toBe("Submit");
    expect(results[2].element.elementType).toBe("FrameLayout");
  });

  it("returns empty for a point outside all bounds", () => {
    const results = elementsAtPoint(tree, 999, 999);
    expect(results).toHaveLength(0);
  });

  it("returns only root for point in root but not children", () => {
    // Bottom-right of root, outside any child bounds
    const results = elementsAtPoint(tree, 350, 700);
    expect(results).toHaveLength(1);
    expect(results[0].element.elementType).toBe("FrameLayout");
  });
});

describe("searchElements", () => {
  it("finds by text (case-insensitive)", () => {
    const results = searchElements(tree, "hello");
    expect(results).toHaveLength(1);
    expect(results[0].element.text).toBe("Hello World");
  });

  it("finds by resourceId", () => {
    const results = searchElements(tree, "icon_submit");
    expect(results).toHaveLength(1);
    expect(results[0].element.resourceId).toBe("icon_submit");
  });

  it("finds by accessibilityLabel", () => {
    const results = searchElements(tree, "SUBMIT BUTTON");
    expect(results).toHaveLength(1);
    expect(results[0].element.accessibilityLabel).toBe("submit button");
  });

  it("finds by elementType", () => {
    const results = searchElements(tree, "textview");
    expect(results).toHaveLength(1);
    expect(results[0].element.elementType).toBe("TextView");
  });

  it("returns empty for no match", () => {
    const results = searchElements(tree, "nonexistent");
    expect(results).toHaveLength(0);
  });

  it("finds multiple matches", () => {
    // "submit" matches both the button text and the icon resourceId
    const results = searchElements(tree, "submit");
    expect(results.length).toBeGreaterThanOrEqual(2);
  });
});
