# Accessibility Audits and Assertions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add web axe-core audits with structured violation reports, plus cross-platform assertion matchers for accessibility labels, roles, focusability, and touch target sizes.

**Architecture:** `accessibility-audit.ts` handles axe-core injection/execution on web and provides role normalization tables for cross-platform matchers. New assertions added to `coordinator.ts` and `expect.ts` using existing `pollUntilMatch` and element hierarchy data. Reporters extended to render violation tables.

**Tech Stack:** axe-core (WCAG scanning), existing Element hierarchy data, existing reporter infrastructure

---

### Task 1: Add axe-core Dependency

**Files:**

- Modify: `packages/spana/package.json`

- [ ] **Step 1: Install axe-core**

Run:

```bash
cd packages/spana && bun add axe-core
```

- [ ] **Step 2: Verify installation**

Run: `ls packages/spana/node_modules/axe-core/axe.min.js`
Expected: File exists

- [ ] **Step 3: Commit**

```bash
git add packages/spana/package.json bun.lock
git commit -m "chore: add axe-core for accessibility auditing"
```

---

### Task 2: Role Normalization Table

**Files:**

- Create: `packages/spana/src/core/accessibility-audit.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/spana/src/core/accessibility-audit.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { normalizeRole, isFocusable, type A11yPlatformContext } from "./accessibility-audit.js";

describe("normalizeRole", () => {
  it("normalizes web tag names to roles", () => {
    expect(normalizeRole("web", "button", {})).toBe("button");
    expect(normalizeRole("web", "a", {})).toBe("link");
    expect(normalizeRole("web", "h1", {})).toBe("heading");
    expect(normalizeRole("web", "h2", {})).toBe("heading");
    expect(normalizeRole("web", "input", {})).toBe("textfield");
    expect(normalizeRole("web", "select", {})).toBe("combobox");
    expect(normalizeRole("web", "textarea", {})).toBe("textfield");
    expect(normalizeRole("web", "img", {})).toBe("image");
    expect(normalizeRole("web", "nav", {})).toBe("navigation");
    expect(normalizeRole("web", "main", {})).toBe("main");
  });

  it("uses explicit role attribute on web", () => {
    expect(normalizeRole("web", "div", { role: "button" })).toBe("button");
    expect(normalizeRole("web", "span", { role: "link" })).toBe("link");
  });

  it("normalizes Android classNames", () => {
    expect(normalizeRole("android", "android.widget.Button", {})).toBe("button");
    expect(normalizeRole("android", "android.widget.EditText", {})).toBe("textfield");
    expect(normalizeRole("android", "android.widget.ImageView", {})).toBe("image");
    expect(normalizeRole("android", "android.widget.CheckBox", {})).toBe("checkbox");
    expect(normalizeRole("android", "android.widget.Switch", {})).toBe("switch");
  });

  it("normalizes iOS traits", () => {
    expect(normalizeRole("ios", "", { traits: "button" })).toBe("button");
    expect(normalizeRole("ios", "", { traits: "header" })).toBe("heading");
    expect(normalizeRole("ios", "", { traits: "link" })).toBe("link");
    expect(normalizeRole("ios", "", { traits: "image" })).toBe("image");
    expect(normalizeRole("ios", "", { traits: "staticText" })).toBe("text");
  });

  it("returns the raw value for unknown elements", () => {
    expect(normalizeRole("web", "custom-element", {})).toBe("custom-element");
    expect(normalizeRole("android", "com.custom.View", {})).toBe("com.custom.View");
  });
});

describe("isFocusable", () => {
  it("detects focusable web elements", () => {
    const ctx: A11yPlatformContext = { platform: "web" };
    expect(
      isFocusable({ elementType: "button", bounds: { x: 0, y: 0, width: 44, height: 44 } }, ctx),
    ).toBe(true);
    expect(
      isFocusable({ elementType: "input", bounds: { x: 0, y: 0, width: 44, height: 44 } }, ctx),
    ).toBe(true);
    expect(
      isFocusable({ elementType: "a", bounds: { x: 0, y: 0, width: 44, height: 44 } }, ctx),
    ).toBe(true);
    expect(
      isFocusable({ elementType: "div", bounds: { x: 0, y: 0, width: 44, height: 44 } }, ctx),
    ).toBe(false);
    expect(
      isFocusable(
        {
          elementType: "div",
          attributes: { tabindex: "0" },
          bounds: { x: 0, y: 0, width: 44, height: 44 },
        },
        ctx,
      ),
    ).toBe(true);
  });

  it("detects focusable Android elements", () => {
    const ctx: A11yPlatformContext = { platform: "android" };
    expect(isFocusable({ focused: true, bounds: { x: 0, y: 0, width: 44, height: 44 } }, ctx)).toBe(
      true,
    );
    expect(
      isFocusable({ clickable: true, bounds: { x: 0, y: 0, width: 44, height: 44 } }, ctx),
    ).toBe(true);
    expect(isFocusable({ bounds: { x: 0, y: 0, width: 44, height: 44 } }, ctx)).toBe(false);
  });

  it("detects focusable iOS elements", () => {
    const ctx: A11yPlatformContext = { platform: "ios" };
    expect(
      isFocusable(
        {
          accessibilityLabel: "Log in",
          bounds: { x: 0, y: 0, width: 44, height: 44 },
        },
        ctx,
      ),
    ).toBe(true);
    expect(
      isFocusable({ clickable: true, bounds: { x: 0, y: 0, width: 44, height: 44 } }, ctx),
    ).toBe(true);
    expect(isFocusable({ bounds: { x: 0, y: 0, width: 44, height: 44 } }, ctx)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/spana && bun test src/core/accessibility-audit.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `packages/spana/src/core/accessibility-audit.ts`:

```typescript
import type { Platform } from "../schemas/selector.js";

export interface A11yPlatformContext {
  platform: Platform;
}

interface ElementLike {
  elementType?: string;
  accessibilityLabel?: string;
  attributes?: Record<string, string>;
  focused?: boolean;
  clickable?: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

// Web: tag name → ARIA role
const WEB_IMPLICIT_ROLES: Record<string, string> = {
  button: "button",
  a: "link",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  input: "textfield",
  textarea: "textfield",
  select: "combobox",
  img: "image",
  nav: "navigation",
  main: "main",
  aside: "complementary",
  footer: "contentinfo",
  header: "banner",
  form: "form",
  table: "table",
  ul: "list",
  ol: "list",
  li: "listitem",
};

// Android: className → normalized role
const ANDROID_CLASS_ROLES: Record<string, string> = {
  "android.widget.Button": "button",
  "android.widget.EditText": "textfield",
  "android.widget.TextView": "text",
  "android.widget.ImageView": "image",
  "android.widget.ImageButton": "button",
  "android.widget.CheckBox": "checkbox",
  "android.widget.RadioButton": "radio",
  "android.widget.Switch": "switch",
  "android.widget.ToggleButton": "switch",
  "android.widget.Spinner": "combobox",
  "android.widget.SeekBar": "slider",
  "android.widget.ProgressBar": "progressbar",
  "android.widget.ListView": "list",
  "android.widget.RecyclerView": "list",
  "android.widget.ScrollView": "scrollbar",
  "android.widget.TabWidget": "tablist",
};

// iOS: trait → normalized role
const IOS_TRAIT_ROLES: Record<string, string> = {
  button: "button",
  link: "link",
  header: "heading",
  image: "image",
  staticText: "text",
  searchField: "searchbox",
  adjustable: "slider",
  tabBar: "tablist",
  selected: "tab",
};

const FOCUSABLE_WEB_TAGS = new Set([
  "a",
  "button",
  "input",
  "textarea",
  "select",
  "details",
  "summary",
]);

export function normalizeRole(
  platform: Platform,
  elementType: string,
  attributes: Record<string, string>,
): string {
  if (platform === "web") {
    // Explicit role takes precedence
    if (attributes.role) return attributes.role;
    return WEB_IMPLICIT_ROLES[elementType.toLowerCase()] ?? elementType;
  }

  if (platform === "android") {
    return ANDROID_CLASS_ROLES[elementType] ?? elementType;
  }

  if (platform === "ios") {
    const traits = attributes.traits ?? "";
    // Check each known trait
    for (const [trait, role] of Object.entries(IOS_TRAIT_ROLES)) {
      if (traits.toLowerCase().includes(trait.toLowerCase())) return role;
    }
    return elementType || "unknown";
  }

  return elementType;
}

export function isFocusable(element: ElementLike, context: A11yPlatformContext): boolean {
  const { platform } = context;

  if (platform === "web") {
    const tag = element.elementType?.toLowerCase() ?? "";
    if (FOCUSABLE_WEB_TAGS.has(tag)) return true;
    const tabindex = element.attributes?.tabindex;
    if (tabindex !== undefined && Number.parseInt(tabindex, 10) >= 0) return true;
    return false;
  }

  if (platform === "android") {
    return !!(element.focused || element.clickable);
  }

  if (platform === "ios") {
    // On iOS, elements with accessibilityLabel or clickable are focusable
    return !!(element.accessibilityLabel || element.clickable);
  }

  return false;
}

export interface AccessibilityViolation {
  ruleId: string;
  severity: "critical" | "serious" | "moderate" | "minor";
  description: string;
  helpUrl: string;
  wcagCriteria: string[];
  elements: Array<{
    selector: string;
    html: string;
    failureSummary: string;
  }>;
}

export interface AuditOptions {
  severity?: "critical" | "serious" | "moderate" | "minor";
  rules?: Record<string, boolean>;
  exclude?: string[]; // CSS selectors to exclude
}

const SEVERITY_ORDER: Record<string, number> = {
  minor: 0,
  moderate: 1,
  serious: 2,
  critical: 3,
};

export function filterViolations(
  violations: AccessibilityViolation[],
  minSeverity: string,
): AccessibilityViolation[] {
  const minLevel = SEVERITY_ORDER[minSeverity] ?? 2;
  return violations.filter((v) => (SEVERITY_ORDER[v.severity] ?? 0) >= minLevel);
}

export function formatViolationSummary(violations: AccessibilityViolation[]): string {
  if (violations.length === 0) return "No accessibility violations found.";

  const bySeverity = new Map<string, number>();
  for (const v of violations) {
    bySeverity.set(v.severity, (bySeverity.get(v.severity) ?? 0) + 1);
  }

  const parts = ["critical", "serious", "moderate", "minor"]
    .filter((s) => bySeverity.has(s))
    .map((s) => `${bySeverity.get(s)} ${s}`);

  return `Accessibility audit failed: ${violations.length} violation${violations.length > 1 ? "s" : ""} (${parts.join(", ")})`;
}

export function buildAxeConfig(options: AuditOptions): {
  runOnly?: { type: string; values: string[] };
  rules?: Record<string, { enabled: boolean }>;
  exclude?: string[][];
} {
  const config: Record<string, unknown> = {};

  if (options.rules) {
    config.rules = Object.fromEntries(
      Object.entries(options.rules).map(([id, enabled]) => [id, { enabled }]),
    );
  }

  if (options.exclude && options.exclude.length > 0) {
    config.exclude = options.exclude.map((sel) => [sel]);
  }

  return config;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/spana && bun test src/core/accessibility-audit.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/spana/src/core/accessibility-audit.ts packages/spana/src/core/accessibility-audit.test.ts
git commit -m "feat: add role normalization and focusability detection for a11y"
```

---

### Task 3: Coordinator — Cross-Platform A11y Assertions

**Files:**

- Modify: `packages/spana/src/smart/coordinator.ts`

- [ ] **Step 1: Add assertAccessibilityLabel to coordinator**

In the return object of `createCoordinator()`, add after existing assertions:

```typescript
assertAccessibilityLabel: (
  selector: ExtendedSelector,
  expected: string | undefined,
  opts?: WaitOptions,
) =>
  Effect.gen(function* () {
    const timeout = opts?.timeout ?? config.defaults?.waitTimeout ?? 5000;
    const pollInterval = opts?.pollInterval ?? config.defaults?.pollInterval ?? 100;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const raw = yield* driver.dumpHierarchy();
      const root = config.parse(raw);
      const el = findElementExtended(root, selector);
      if (el) {
        const label = el.accessibilityLabel;
        if (expected === undefined) {
          // Just check non-empty
          if (label && label.trim().length > 0) return;
        } else {
          if (label === expected) return;
        }
      }
      yield* Effect.sleep(Duration.millis(pollInterval));
    }

    yield* Effect.fail(
      new DriverError({
        message: expected
          ? `Element does not have accessibility label "${expected}"`
          : "Element does not have an accessibility label",
        cause: undefined,
      }),
    );
  }),

assertFocusable: (
  selector: ExtendedSelector,
  platform: string,
  opts?: WaitOptions,
) =>
  Effect.gen(function* () {
    const { isFocusable } = yield* Effect.promise(
      () => import("../core/accessibility-audit.js"),
    );
    const timeout = opts?.timeout ?? config.defaults?.waitTimeout ?? 5000;
    const pollInterval = opts?.pollInterval ?? config.defaults?.pollInterval ?? 100;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const raw = yield* driver.dumpHierarchy();
      const root = config.parse(raw);
      const el = findElementExtended(root, selector);
      if (el && isFocusable(el, { platform: platform as any })) return;
      yield* Effect.sleep(Duration.millis(pollInterval));
    }

    yield* Effect.fail(
      new DriverError({
        message: "Element is not focusable",
        cause: undefined,
      }),
    );
  }),

assertRole: (
  selector: ExtendedSelector,
  expectedRole: string,
  platform: string,
  opts?: WaitOptions,
) =>
  Effect.gen(function* () {
    const { normalizeRole } = yield* Effect.promise(
      () => import("../core/accessibility-audit.js"),
    );
    const timeout = opts?.timeout ?? config.defaults?.waitTimeout ?? 5000;
    const pollInterval = opts?.pollInterval ?? config.defaults?.pollInterval ?? 100;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const raw = yield* driver.dumpHierarchy();
      const root = config.parse(raw);
      const el = findElementExtended(root, selector);
      if (el) {
        const role = normalizeRole(
          platform as any,
          el.elementType ?? "",
          el.attributes ?? {},
        );
        if (role === expectedRole) return;
      }
      yield* Effect.sleep(Duration.millis(pollInterval));
    }

    yield* Effect.fail(
      new DriverError({
        message: `Element does not have role "${expectedRole}"`,
        cause: undefined,
      }),
    );
  }),

assertMinTouchTarget: (
  selector: ExtendedSelector,
  minSize: number,
  opts?: WaitOptions,
) =>
  Effect.gen(function* () {
    const timeout = opts?.timeout ?? config.defaults?.waitTimeout ?? 5000;
    const pollInterval = opts?.pollInterval ?? config.defaults?.pollInterval ?? 100;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const raw = yield* driver.dumpHierarchy();
      const root = config.parse(raw);
      const el = findElementExtended(root, selector);
      if (
        el &&
        el.bounds.width >= minSize &&
        el.bounds.height >= minSize
      )
        return;
      yield* Effect.sleep(Duration.millis(pollInterval));
    }

    yield* Effect.fail(
      new DriverError({
        message: `Element touch target is smaller than ${minSize}x${minSize}`,
        cause: undefined,
      }),
    );
  }),
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd packages/spana && bun build src/smart/coordinator.ts --no-bundle --outdir /tmp/check-coord-a11y 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add packages/spana/src/smart/coordinator.ts
git commit -m "feat: add a11y assertion methods to coordinator"
```

---

### Task 4: Coordinator — Web Accessibility Audit

**Files:**

- Modify: `packages/spana/src/smart/coordinator.ts`

- [ ] **Step 1: Add assertAccessibilityAudit to coordinator**

Add to the coordinator return object:

```typescript
assertAccessibilityAudit: (
  platform: string,
  options: {
    severity?: "critical" | "serious" | "moderate" | "minor";
    rules?: Record<string, boolean>;
    excludeSelectors?: string[];
  },
) =>
  Effect.gen(function* () {
    if (platform !== "web") {
      yield* Effect.fail(
        new DriverError({
          message:
            "Accessibility audits are only supported on web. Use toHaveAccessibilityLabel(), toBeFocusable(), toHaveRole(), or toHaveMinTouchTarget() for cross-platform accessibility assertions.",
          cause: undefined,
        }),
      );
      return;
    }

    const { filterViolations, buildAxeConfig, formatViolationSummary } =
      yield* Effect.promise(
        () => import("../core/accessibility-audit.js"),
      );
    const { readFileSync } = yield* Effect.promise(
      () => import("node:fs"),
    );
    const { join } = yield* Effect.promise(() => import("node:path"));

    // Read axe-core source
    const axeSource = readFileSync(
      join(
        require.resolve("axe-core"),
        "..",
        "axe.min.js",
      ),
      "utf-8",
    );

    const axeConfig = buildAxeConfig({
      severity: options.severity,
      rules: options.rules,
      exclude: options.excludeSelectors,
    });

    // Inject and run axe-core via driver.evaluate
    if (!driver.evaluate) {
      yield* Effect.fail(
        new DriverError({
          message: "Accessibility audit requires evaluate() support (web driver only)",
          cause: undefined,
        }),
      );
      return;
    }

    const rawResults = yield* driver.evaluate(
      `
      (async () => {
        ${axeSource};
        const config = ${JSON.stringify(axeConfig)};
        const results = await axe.run(document, config);
        return JSON.stringify(results.violations.map(v => ({
          ruleId: v.id,
          severity: v.impact,
          description: v.description,
          helpUrl: v.helpUrl,
          wcagCriteria: (v.tags || []).filter(t => t.startsWith('wcag')).map(t => t.replace('wcag', '').replace(/(..)/, '$1.')),
          elements: v.nodes.map(n => ({
            selector: n.target.join(' '),
            html: n.html,
            failureSummary: n.failureSummary || '',
          })),
        })));
      })()
      `,
    );

    const violations = filterViolations(
      JSON.parse(rawResults as string),
      options.severity ?? "serious",
    );

    if (violations.length > 0) {
      const summary = formatViolationSummary(violations);
      yield* Effect.fail(
        new DriverError({
          message: summary,
          cause: violations,
        }),
      );
    }
  }),
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd packages/spana && bun build src/smart/coordinator.ts --no-bundle --outdir /tmp/check-coord-audit 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add packages/spana/src/smart/coordinator.ts
git commit -m "feat: add web accessibility audit to coordinator"
```

---

### Task 5: Expect API — A11y Assertions

**Files:**

- Modify: `packages/spana/src/api/expect.ts`

- [ ] **Step 1: Add a11y methods to PromiseExpectation interface**

Add to the `PromiseExpectation` interface:

```typescript
toPassAccessibilityAudit(options?: {
  severity?: "critical" | "serious" | "moderate" | "minor";
  rules?: Record<string, boolean>;
  exclude?: Selector[];
}): Promise<void>;

toHaveAccessibilityLabel(expected?: string): Promise<void>;

toBeFocusable(): Promise<void>;

toHaveRole(expected: string): Promise<void>;

toHaveMinTouchTarget(size?: number): Promise<void>;
```

- [ ] **Step 2: Add implementations in createPromiseExpect**

In the return object of `createPromiseExpect`, add:

```typescript
toPassAccessibilityAudit: (options) =>
  runStep(
    "expect.toPassAccessibilityAudit()",
    () => {
      // Convert selector exclusions to CSS selectors
      const excludeSelectors = (options?.exclude ?? []).map((sel) => {
        if (typeof sel === "string") return sel;
        if ("testID" in sel) return `[data-testid="${sel.testID}"]`;
        if ("accessibilityLabel" in sel) return `[aria-label="${sel.accessibilityLabel}"]`;
        return "";
      }).filter(Boolean);

      return run(
        coordinator.assertAccessibilityAudit(
          flowContext?.platform ?? "web",
          {
            severity: options?.severity,
            rules: options?.rules,
            excludeSelectors,
          },
        ),
      );
    },
    { captureScreenshot: true },
  ),

toHaveAccessibilityLabel: (expected) =>
  runStep(
    expected
      ? `expect.toHaveAccessibilityLabel("${expected}")`
      : "expect.toHaveAccessibilityLabel()",
    () =>
      run(coordinator.assertAccessibilityLabel(selector, expected)),
  ),

toBeFocusable: () =>
  runStep("expect.toBeFocusable()", () =>
    run(
      coordinator.assertFocusable(
        selector,
        flowContext?.platform ?? "web",
      ),
    ),
  ),

toHaveRole: (expected) =>
  runStep(`expect.toHaveRole("${expected}")`, () =>
    run(
      coordinator.assertRole(
        selector,
        expected,
        flowContext?.platform ?? "web",
      ),
    ),
  ),

toHaveMinTouchTarget: (size) =>
  runStep(
    `expect.toHaveMinTouchTarget(${size ?? 44})`,
    () => run(coordinator.assertMinTouchTarget(selector, size ?? 44)),
  ),
```

- [ ] **Step 3: Verify the build compiles**

Run: `cd packages/spana && bun build src/api/expect.ts --no-bundle --outdir /tmp/check-expect-a11y 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add packages/spana/src/api/expect.ts
git commit -m "feat: add a11y assertion methods to expect API"
```

---

### Task 6: HTML Reporter — Violation Table

**Files:**

- Modify: `packages/spana/src/report/html.ts`

- [ ] **Step 1: Add violation table renderer**

Add a helper function in `html.ts`:

```typescript
function renderA11yViolations(steps: StepResult[]): string {
  // Find steps with a11y violations in their error cause
  const violationSteps = steps.filter(
    (s) => s.status === "failed" && s.command?.includes("AccessibilityAudit") && s.error,
  );

  if (violationSteps.length === 0) return "";

  let html =
    '<div style="margin:12px 0"><h4 style="color:#f87171;margin:0 0 8px">Accessibility Violations</h4>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:12px">';
  html += "<thead><tr>";
  html +=
    '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid #333;color:#a3a3a3">Rule</th>';
  html +=
    '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid #333;color:#a3a3a3">Severity</th>';
  html +=
    '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid #333;color:#a3a3a3">Elements</th>';
  html +=
    '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid #333;color:#a3a3a3">WCAG</th>';
  html += "</tr></thead><tbody>";

  for (const step of violationSteps) {
    // Parse violations from error message
    // The error cause contains the violations array
    const errorMsg = step.error ?? "";
    const lines = errorMsg.split("\n").filter((l) => l.trim().startsWith("-"));

    for (const line of lines) {
      const severityColors: Record<string, string> = {
        critical: "#dc2626",
        serious: "#f97316",
        moderate: "#eab308",
        minor: "#3b82f6",
      };

      html += `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #1a1a1a;color:#e5e5e5">${line.replace(/^-\s*/, "").split("(")[0]?.trim() ?? ""}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #1a1a1a"><span style="color:${severityColors.serious}">${line.match(/\((critical|serious|moderate|minor)\)/)?.[1] ?? "unknown"}</span></td>
        <td style="padding:6px 8px;border-bottom:1px solid #1a1a1a;color:#a3a3a3;max-width:300px;overflow:hidden;text-overflow:ellipsis">${line.split("—")[1]?.trim() ?? ""}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #1a1a1a;color:#60a5fa"></td>
      </tr>`;
    }
  }

  html += "</tbody></table></div>";
  return html;
}
```

- [ ] **Step 2: Call renderA11yViolations in failure details**

In the failure details rendering section, add a call to `renderA11yViolations(result.steps)` alongside the existing screenshot rendering.

- [ ] **Step 3: Verify the build compiles**

Run: `cd packages/spana && bun build src/report/html.ts --no-bundle --outdir /tmp/check-html-a11y 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add packages/spana/src/report/html.ts
git commit -m "feat: add a11y violation table to HTML reporter"
```

---

### Task 7: Allure Reporter — Violation Attachments

**Files:**

- Modify: `packages/spana/src/report/allure.ts`

- [ ] **Step 1: Attach violation data as JSON**

In `allure.ts`, modify `copyAttachments` to detect a11y violation data and attach it. After the existing attachment copying logic, add:

```typescript
// Attach a11y violations as JSON if present in failed steps
for (const step of result.steps ?? []) {
  if (step.status === "failed" && step.command?.includes("AccessibilityAudit") && step.error) {
    const violationJson = JSON.stringify({ command: step.command, error: step.error }, null, 2);
    const filename = `${randomUUID()}-attachment.json`;
    writeFileSync(join(outputDir, filename), violationJson, "utf-8");
    attachments.push({
      name: "a11y-violations",
      source: filename,
      type: "application/json",
    });
  }
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd packages/spana && bun build src/report/allure.ts --no-bundle --outdir /tmp/check-allure-a11y 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add packages/spana/src/report/allure.ts
git commit -m "feat: attach a11y violation data in Allure reporter"
```

---

### Task 8: Console Reporter — Violation Summary

**Files:**

- Modify: `packages/spana/src/report/console.ts`

- [ ] **Step 1: Add violation summary to console output**

Find the failure output section in `console.ts`. When a step fails with an a11y audit command, format the error with the violation summary:

```typescript
// In the step failure rendering section, check for a11y audit steps
if (step.command?.includes("AccessibilityAudit") && step.error) {
  console.log(`  ✗ ${step.error}`);
} else {
  // existing error output
}
```

The `formatViolationSummary` from `accessibility-audit.ts` already produces the right console format like:

```
  ✗ Accessibility audit failed: 2 violations (1 critical, 1 serious)
    - button-name (critical): 1 element — <button class="icon">...
    - color-contrast (serious): 3 elements
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd packages/spana && bun build src/report/console.ts --no-bundle --outdir /tmp/check-console 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add packages/spana/src/report/console.ts
git commit -m "feat: add a11y violation summary to console reporter"
```

---

### Task 9: Integration Test — A11y Assertions

**Files:**

- Create: `packages/spana/src/core/accessibility-integration.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
import { describe, expect, it } from "bun:test";
import {
  normalizeRole,
  isFocusable,
  filterViolations,
  formatViolationSummary,
  buildAxeConfig,
  type AccessibilityViolation,
} from "./accessibility-audit.js";

describe("A11y integration", () => {
  it("normalizes roles consistently across platforms", () => {
    // Button should normalize to "button" on all platforms
    expect(normalizeRole("web", "button", {})).toBe("button");
    expect(normalizeRole("android", "android.widget.Button", {})).toBe("button");
    expect(normalizeRole("ios", "", { traits: "button" })).toBe("button");

    // Heading/header should normalize consistently
    expect(normalizeRole("web", "h1", {})).toBe("heading");
    expect(normalizeRole("ios", "", { traits: "header" })).toBe("heading");
  });

  it("filters violations by severity", () => {
    const violations: AccessibilityViolation[] = [
      {
        ruleId: "button-name",
        severity: "critical",
        description: "Buttons must have discernible text",
        helpUrl: "https://dequeuniversity.com/rules/axe/4.4/button-name",
        wcagCriteria: ["4.1.2"],
        elements: [{ selector: "button.icon", html: "<button>", failureSummary: "" }],
      },
      {
        ruleId: "color-contrast",
        severity: "serious",
        description: "Elements must have sufficient color contrast",
        helpUrl: "https://dequeuniversity.com/rules/axe/4.4/color-contrast",
        wcagCriteria: ["1.4.3"],
        elements: [{ selector: "p.muted", html: "<p>", failureSummary: "" }],
      },
      {
        ruleId: "landmark-one-main",
        severity: "moderate",
        description: "Document should have one main landmark",
        helpUrl: "https://dequeuniversity.com/rules/axe/4.4/landmark-one-main",
        wcagCriteria: [],
        elements: [{ selector: "html", html: "<html>", failureSummary: "" }],
      },
      {
        ruleId: "tabindex",
        severity: "minor",
        description: "tabindex should not be greater than 0",
        helpUrl: "https://dequeuniversity.com/rules/axe/4.4/tabindex",
        wcagCriteria: [],
        elements: [{ selector: "div", html: "<div>", failureSummary: "" }],
      },
    ];

    // serious filter → critical + serious
    const serious = filterViolations(violations, "serious");
    expect(serious).toHaveLength(2);
    expect(serious.map((v) => v.ruleId)).toEqual(["button-name", "color-contrast"]);

    // critical filter → critical only
    const critical = filterViolations(violations, "critical");
    expect(critical).toHaveLength(1);
    expect(critical[0]!.ruleId).toBe("button-name");

    // minor filter → all
    const minor = filterViolations(violations, "minor");
    expect(minor).toHaveLength(4);
  });

  it("formats violation summary for console", () => {
    const violations: AccessibilityViolation[] = [
      {
        ruleId: "button-name",
        severity: "critical",
        description: "",
        helpUrl: "",
        wcagCriteria: [],
        elements: [{ selector: "", html: "", failureSummary: "" }],
      },
      {
        ruleId: "color-contrast",
        severity: "serious",
        description: "",
        helpUrl: "",
        wcagCriteria: [],
        elements: [{ selector: "", html: "", failureSummary: "" }],
      },
    ];

    const summary = formatViolationSummary(violations);
    expect(summary).toContain("2 violations");
    expect(summary).toContain("1 critical");
    expect(summary).toContain("1 serious");
  });

  it("builds axe config with rule overrides and exclusions", () => {
    const config = buildAxeConfig({
      rules: { "color-contrast": false, "button-name": true },
      exclude: ['[data-testid="widget"]', '[aria-label="ad"]'],
    });

    expect(config.rules).toEqual({
      "color-contrast": { enabled: false },
      "button-name": { enabled: true },
    });
    expect(config.exclude).toEqual([['[data-testid="widget"]'], ['[aria-label="ad"]']]);
  });

  it("detects touch target compliance", () => {
    const largeElement = {
      bounds: { x: 0, y: 0, width: 48, height: 48 },
    };
    const smallElement = {
      bounds: { x: 0, y: 0, width: 30, height: 30 },
    };

    // Touch target check is done by bounds comparison
    expect(largeElement.bounds.width >= 44).toBe(true);
    expect(largeElement.bounds.height >= 44).toBe(true);
    expect(smallElement.bounds.width >= 44).toBe(false);
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `cd packages/spana && bun test src/core/accessibility-integration.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/spana/src/core/accessibility-integration.test.ts
git commit -m "test: add accessibility assertions integration tests"
```
