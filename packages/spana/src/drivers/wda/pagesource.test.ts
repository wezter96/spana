import { describe, expect, test } from "bun:test";
import { parseIOSHierarchy } from "./pagesource.js";

describe("parseIOSHierarchy", () => {
  test("skips the AppiumAUT wrapper and infers clickable iOS controls", () => {
    const hierarchy = parseIOSHierarchy(`
      <AppiumAUT>
        <XCUIElementTypeWindow x="0" y="0" width="390" height="844" visible="true">
          <XCUIElementTypeButton
            type="XCUIElementTypeButton"
            name="login-button"
            label="Log in"
            value="Log in"
            x="20"
            y="100"
            width="120"
            height="44"
            enabled="true"
            visible="true"
          />
        </XCUIElementTypeWindow>
      </AppiumAUT>
    `);

    expect(hierarchy.elementType).toBe("XCUIElementTypeWindow");
    expect(hierarchy.children).toHaveLength(1);

    expect(hierarchy.children?.[0]).toEqual({
      id: "login-button",
      text: "Log in",
      accessibilityLabel: "Log in",
      elementType: "XCUIElementTypeButton",
      bounds: { x: 20, y: 100, width: 120, height: 44 },
      enabled: true,
      visible: true,
      clickable: true,
    });
  });
});
