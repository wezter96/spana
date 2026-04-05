import { describe, expect, test } from "bun:test";
import { parseWebHierarchy } from "./playwright-parser.js";

describe("parseWebHierarchy", () => {
  test("prefers role over tag and maps nested children", () => {
    const root = parseWebHierarchy(
      JSON.stringify({
        tag: "div",
        bounds: { x: 0, y: 0, width: 100, height: 200 },
        children: [
          {
            tag: "button",
            role: "button",
            id: "login",
            text: "Log In",
            accessibilityLabel: "Log in",
            bounds: { x: 10, y: 20, width: 80, height: 40 },
            enabled: true,
            visible: true,
            clickable: true,
          },
        ],
      }),
    );

    expect(root.elementType).toBe("div");
    expect(root.children?.[0]).toEqual({
      id: "login",
      text: "Log In",
      accessibilityLabel: "Log in",
      elementType: "button",
      bounds: { x: 10, y: 20, width: 80, height: 40 },
      enabled: true,
      visible: true,
      clickable: true,
    });
  });
});
