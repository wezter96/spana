import { describe, expect, test } from "bun:test";
import {
  type AccessibilityViolation,
  buildAxeConfig,
  filterViolations,
  formatViolationSummary,
  isFocusable,
  normalizeRole,
} from "./accessibility-audit.js";

// ---------------------------------------------------------------------------
// normalizeRole — web
// ---------------------------------------------------------------------------

describe("normalizeRole (web)", () => {
  test("maps button tag to button role", () => {
    expect(normalizeRole("web", "button")).toBe("button");
  });

  test("maps a tag to link role", () => {
    expect(normalizeRole("web", "a")).toBe("link");
  });

  test("maps h1-h6 to heading role", () => {
    for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
      expect(normalizeRole("web", tag)).toBe("heading");
    }
  });

  test("maps input and textarea to ARIA textbox role (and input types per ARIA-in-HTML)", () => {
    expect(normalizeRole("web", "input")).toBe("textbox");
    expect(normalizeRole("web", "textarea")).toBe("textbox");
    expect(normalizeRole("web", "input", { type: "checkbox" })).toBe("checkbox");
    expect(normalizeRole("web", "input", { type: "radio" })).toBe("radio");
    expect(normalizeRole("web", "input", { type: "submit" })).toBe("button");
    expect(normalizeRole("web", "input", { type: "search" })).toBe("searchbox");
    expect(normalizeRole("web", "input", { type: "number" })).toBe("spinbutton");
    expect(normalizeRole("web", "input", { type: "range" })).toBe("slider");
  });

  test("maps select to combobox role", () => {
    expect(normalizeRole("web", "select")).toBe("combobox");
  });

  test("maps img to ARIA img role", () => {
    expect(normalizeRole("web", "img")).toBe("img");
  });

  test("maps nav to navigation role", () => {
    expect(normalizeRole("web", "nav")).toBe("navigation");
  });

  test("maps main to main role", () => {
    expect(normalizeRole("web", "main")).toBe("main");
  });

  test("explicit role attribute wins over tag name", () => {
    expect(normalizeRole("web", "div", { role: "dialog" })).toBe("dialog");
    expect(normalizeRole("web", "button", { role: "tab" })).toBe("tab");
  });

  test("unknown tag returns raw elementType", () => {
    expect(normalizeRole("web", "article")).toBe("article");
    expect(normalizeRole("web", "custom-element")).toBe("custom-element");
  });
});

// ---------------------------------------------------------------------------
// normalizeRole — android
// ---------------------------------------------------------------------------

describe("normalizeRole (android)", () => {
  test("maps android.widget.Button to button", () => {
    expect(normalizeRole("android", "android.widget.Button")).toBe("button");
  });

  test("maps android.widget.EditText to textbox", () => {
    expect(normalizeRole("android", "android.widget.EditText")).toBe("textbox");
  });

  test("maps android.widget.ImageView to img", () => {
    expect(normalizeRole("android", "android.widget.ImageView")).toBe("img");
  });

  test("maps android.widget.CheckBox to checkbox", () => {
    expect(normalizeRole("android", "android.widget.CheckBox")).toBe("checkbox");
  });

  test("maps android.widget.Switch to switch", () => {
    expect(normalizeRole("android", "android.widget.Switch")).toBe("switch");
  });

  test("unknown class returns raw elementType", () => {
    expect(normalizeRole("android", "com.example.CustomView")).toBe("com.example.CustomView");
  });
});

// ---------------------------------------------------------------------------
// normalizeRole — ios
// ---------------------------------------------------------------------------

describe("normalizeRole (ios)", () => {
  test("maps button traits and XCUI button types to button", () => {
    expect(normalizeRole("ios", "button")).toBe("button");
    expect(normalizeRole("ios", "XCUIElementTypeButton")).toBe("button");
  });

  test("maps header trait to heading", () => {
    expect(normalizeRole("ios", "header")).toBe("heading");
  });

  test("maps link traits and XCUI link types to link", () => {
    expect(normalizeRole("ios", "link")).toBe("link");
    expect(normalizeRole("ios", "XCUIElementTypeLink")).toBe("link");
  });

  test("maps image traits and XCUI image types to img", () => {
    expect(normalizeRole("ios", "image")).toBe("img");
    expect(normalizeRole("ios", "XCUIElementTypeImage")).toBe("img");
  });

  test("maps staticText traits and XCUI static text types to text", () => {
    expect(normalizeRole("ios", "staticText")).toBe("text");
    expect(normalizeRole("ios", "XCUIElementTypeStaticText")).toBe("text");
  });

  test("unknown trait returns raw elementType", () => {
    expect(normalizeRole("ios", "unknownTrait")).toBe("unknownTrait");
  });
});

// ---------------------------------------------------------------------------
// isFocusable — web
// ---------------------------------------------------------------------------

describe("isFocusable (web)", () => {
  const ctx = { platform: "web" as const };

  test("focusable tags are focusable", () => {
    for (const tag of ["a", "button", "input", "textarea", "select", "details", "summary"]) {
      expect(isFocusable({ tag }, ctx)).toBe(true);
    }
  });

  test("non-focusable tag without tabindex is not focusable", () => {
    expect(isFocusable({ tag: "div" }, ctx)).toBe(false);
  });

  test("tabindex=0 makes element focusable", () => {
    expect(isFocusable({ tag: "div", tabindex: 0 }, ctx)).toBe(true);
  });

  test("tabindex=1 makes element focusable", () => {
    expect(isFocusable({ tag: "span", tabindex: 1 }, ctx)).toBe(true);
  });

  test("tabindex=-1 does not make element focusable", () => {
    expect(isFocusable({ tag: "div", tabindex: -1 }, ctx)).toBe(false);
  });

  test("tag check is case-insensitive", () => {
    expect(isFocusable({ tag: "BUTTON" }, ctx)).toBe(true);
    expect(isFocusable({ tag: "INPUT" }, ctx)).toBe(true);
  });

  test("parsed web nodes remain focusable via elementType and attributes.tabindex", () => {
    expect(
      isFocusable(
        {
          elementType: "button",
          attributes: { tabindex: "0" },
        },
        ctx,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isFocusable — android
// ---------------------------------------------------------------------------

describe("isFocusable (android)", () => {
  const ctx = { platform: "android" as const };

  test("focused=true is focusable", () => {
    expect(isFocusable({ focused: true }, ctx)).toBe(true);
  });

  test("clickable=true is focusable", () => {
    expect(isFocusable({ clickable: true }, ctx)).toBe(true);
  });

  test("neither focused nor clickable is not focusable", () => {
    expect(isFocusable({ focused: false, clickable: false }, ctx)).toBe(false);
  });

  test("empty element is not focusable", () => {
    expect(isFocusable({}, ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isFocusable — ios
// ---------------------------------------------------------------------------

describe("isFocusable (ios)", () => {
  const ctx = { platform: "ios" as const };

  test("element with accessibilityLabel is focusable", () => {
    expect(isFocusable({ accessibilityLabel: "Submit" }, ctx)).toBe(true);
  });

  test("element with empty accessibilityLabel is not focusable", () => {
    expect(isFocusable({ accessibilityLabel: "" }, ctx)).toBe(false);
  });

  test("clickable=true is focusable", () => {
    expect(isFocusable({ clickable: true }, ctx)).toBe(true);
  });

  test("empty element is not focusable", () => {
    expect(isFocusable({}, ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterViolations
// ---------------------------------------------------------------------------

function makeViolation(
  severity: AccessibilityViolation["severity"],
  ruleId = "test-rule",
): AccessibilityViolation {
  return {
    ruleId,
    severity,
    description: `${severity} violation`,
    helpUrl: `https://example.com/${ruleId}`,
    wcagCriteria: [],
    elements: [],
  };
}

describe("filterViolations", () => {
  const violations: AccessibilityViolation[] = [
    makeViolation("minor"),
    makeViolation("moderate"),
    makeViolation("serious"),
    makeViolation("critical"),
  ];

  test("minSeverity=minor returns all violations", () => {
    expect(filterViolations(violations, "minor")).toHaveLength(4);
  });

  test("minSeverity=moderate excludes minor", () => {
    const result = filterViolations(violations, "moderate");
    expect(result).toHaveLength(3);
    expect(result.every((v) => v.severity !== "minor")).toBe(true);
  });

  test("minSeverity=serious returns only serious and critical", () => {
    const result = filterViolations(violations, "serious");
    expect(result).toHaveLength(2);
    expect(result.map((v) => v.severity)).toEqual(["serious", "critical"]);
  });

  test("minSeverity=critical returns only critical", () => {
    const result = filterViolations(violations, "critical");
    expect(result).toHaveLength(1);
    expect(result[0]!.severity).toBe("critical");
  });

  test("empty array returns empty array", () => {
    expect(filterViolations([], "minor")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatViolationSummary
// ---------------------------------------------------------------------------

describe("formatViolationSummary", () => {
  test("formats summary with correct counts", () => {
    const violations: AccessibilityViolation[] = [
      makeViolation("critical"),
      makeViolation("critical"),
      makeViolation("serious"),
      makeViolation("moderate"),
      makeViolation("minor"),
    ];
    expect(formatViolationSummary(violations)).toBe(
      "Accessibility audit failed: 5 violations (2 critical, 1 serious)",
    );
  });

  test("formats summary with zero critical and serious", () => {
    const violations: AccessibilityViolation[] = [
      makeViolation("minor"),
      makeViolation("moderate"),
    ];
    expect(formatViolationSummary(violations)).toBe(
      "Accessibility audit failed: 2 violations (0 critical, 0 serious)",
    );
  });

  test("formats summary with no violations", () => {
    expect(formatViolationSummary([])).toBe(
      "Accessibility audit failed: 0 violations (0 critical, 0 serious)",
    );
  });
});

// ---------------------------------------------------------------------------
// buildAxeConfig
// ---------------------------------------------------------------------------

describe("buildAxeConfig", () => {
  test("returns empty config for empty options", () => {
    expect(buildAxeConfig({})).toEqual({});
  });

  test("enables specified rules", () => {
    const config = buildAxeConfig({ rules: ["color-contrast", "label"] });
    expect(config["rules"]).toEqual({
      "color-contrast": { enabled: true },
      label: { enabled: true },
    });
  });

  test("disables specified rules", () => {
    const config = buildAxeConfig({ disabledRules: ["region"] });
    expect(config["rules"]).toEqual({ region: { enabled: false } });
  });

  test("merges enabled and disabled rules", () => {
    const config = buildAxeConfig({
      rules: ["color-contrast"],
      disabledRules: ["region"],
    });
    const rules = config["rules"] as Record<string, { enabled: boolean }>;
    expect(rules["color-contrast"]).toEqual({ enabled: true });
    expect(rules["region"]).toEqual({ enabled: false });
  });

  test("sets runOnly for tags", () => {
    const config = buildAxeConfig({ tags: ["wcag2a", "wcag2aa"] });
    expect(config["runOnly"]).toEqual({ type: "tag", values: ["wcag2a", "wcag2aa"] });
  });

  test("sets context with exclude selectors", () => {
    const config = buildAxeConfig({ exclude: [".ads", "#cookie-banner"] });
    expect(config["context"]).toEqual({ exclude: [".ads", "#cookie-banner"] });
  });

  test("sets context with include selectors", () => {
    const config = buildAxeConfig({ include: ["#main"] });
    expect(config["context"]).toEqual({ include: ["#main"] });
  });

  test("sets context with both include and exclude", () => {
    const config = buildAxeConfig({ include: ["#main"], exclude: [".ads"] });
    expect(config["context"]).toEqual({ include: ["#main"], exclude: [".ads"] });
  });

  test("does not set context when neither include nor exclude provided", () => {
    const config = buildAxeConfig({ rules: ["label"] });
    expect(config["context"]).toBeUndefined();
  });
});
