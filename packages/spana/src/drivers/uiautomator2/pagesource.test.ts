import { describe, expect, test } from "bun:test";
import { parseAndroidHierarchy } from "./pagesource.js";

describe("parseAndroidHierarchy", () => {
  test("normalizes Appium XML into the shared element shape", () => {
    const hierarchy = parseAndroidHierarchy(`
      <hierarchy>
        <node class="android.widget.FrameLayout" bounds="[0,0][100,200]" clickable="false">
          <node
            class="android.widget.Button"
            resource-id="com.example:id/login_button"
            text="Log In"
            content-desc="Log in"
            bounds="[10,20][90,60]"
            enabled="true"
            focused="false"
            clickable="true"
          />
        </node>
      </hierarchy>
    `);

    expect(hierarchy.elementType).toBe("android.widget.FrameLayout");
    expect(hierarchy.children).toHaveLength(1);

    expect(hierarchy.children?.[0]).toEqual({
      id: "login_button",
      text: "Log In",
      accessibilityLabel: "Log in",
      elementType: "android.widget.Button",
      bounds: { x: 10, y: 20, width: 80, height: 40 },
      enabled: true,
      focused: false,
      clickable: true,
    });
  });
});
