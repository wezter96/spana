import { Effect } from "effect";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { ExtendedSelector } from "../schemas/selector.js";
import { createCoordinator, type CoordinatorConfig } from "../smart/coordinator.js";
import type { WaitOptions } from "../smart/auto-wait.js";
import type { StepRecorder } from "../core/step-recorder.js";

export interface FlowContext {
  flowFilePath: string;
  flowName: string;
  platform: string;
  updateBaselines?: boolean;
}

export interface PromiseExpectation<T extends string = string> {
  toBeVisible(opts?: WaitOptions): Promise<void>;
  toBeHidden(opts?: WaitOptions): Promise<void>;
  toHaveText(expected: string, opts?: WaitOptions): Promise<void>;
  toMatchText(pattern: RegExp, opts?: WaitOptions): Promise<void>;
  toHaveValue(expected: string | number, opts?: WaitOptions): Promise<void>;
  toHaveAttribute(name: string, value?: string, opts?: WaitOptions): Promise<void>;
  toBeEnabled(opts?: WaitOptions): Promise<void>;
  toBeDisabled(opts?: WaitOptions): Promise<void>;
  toContainText(expected: string, opts?: WaitOptions): Promise<void>;

  // Visual regression
  toMatchScreenshot(
    name: string,
    options?: {
      threshold?: number;
      maxDiffPixelRatio?: number;
      mask?: ExtendedSelector<T>[];
    },
  ): Promise<void>;

  // Accessibility
  toPassAccessibilityAudit(options?: {
    severity?: "critical" | "serious" | "moderate" | "minor";
    rules?: string[];
    exclude?: ExtendedSelector<T>[];
  }): Promise<void>;

  toHaveAccessibilityLabel(expected?: string): Promise<void>;
  toBeFocusable(): Promise<void>;
  toHaveRole(expected: string): Promise<void>;
  toHaveMinTouchTarget(size?: number): Promise<void>;
}

function selectorToCss<T extends string = string>(sel: ExtendedSelector<T>): string {
  if (typeof sel === "string") return sel;
  if (typeof sel === "object" && sel !== null && "testID" in sel && sel.testID)
    return `[data-testid="${sel.testID}"]`;
  if (
    typeof sel === "object" &&
    sel !== null &&
    "accessibilityLabel" in sel &&
    sel.accessibilityLabel
  )
    return `[aria-label="${sel.accessibilityLabel}"]`;
  return "";
}

export function createPromiseExpect<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  config: CoordinatorConfig,
  recorder?: StepRecorder,
  flowContext?: FlowContext,
  visualRegression?: {
    threshold?: number;
    maxDiffPixelRatio?: number;
    baselinesDir?: string;
  },
): (selector: ExtendedSelector<T>) => PromiseExpectation<T> {
  const ctx: FlowContext = flowContext ?? {
    flowFilePath: "",
    flowName: "unknown",
    platform: "web",
  };

  const coord = createCoordinator<T, R>(driver, config);

  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

  const runStep = <A>(command: string, selector: ExtendedSelector<T>, action: () => Promise<A>) =>
    recorder ? recorder.runStep(command, action, { selector, captureScreenshot: false }) : action();

  return (selector: ExtendedSelector<T>): PromiseExpectation<T> => ({
    toBeVisible: (opts) =>
      runStep("expect.toBeVisible", selector, () =>
        run(coord.assertVisible(selector, opts)).then(() => {}),
      ),
    toBeHidden: (opts) =>
      runStep("expect.toBeHidden", selector, () => run(coord.assertHidden(selector, opts))),
    toHaveText: (expected, opts) =>
      runStep(`expect.toHaveText(${JSON.stringify(expected)})`, selector, () =>
        run(coord.assertText(selector, expected, opts)),
      ),
    toMatchText: (pattern, opts) =>
      runStep(`expect.toMatchText(${pattern})`, selector, () =>
        run(coord.assertMatchesText(selector, pattern, opts)),
      ),
    toHaveValue: (expected, opts) =>
      runStep(`expect.toHaveValue(${JSON.stringify(expected)})`, selector, () =>
        run(coord.assertValue(selector, expected, opts)),
      ),
    toHaveAttribute: (name, value, opts) =>
      runStep(`expect.toHaveAttribute(${JSON.stringify(name)})`, selector, () =>
        run(coord.assertAttribute(selector, name, value, opts)),
      ),
    toBeEnabled: (opts) =>
      runStep("expect.toBeEnabled", selector, () => run(coord.assertEnabled(selector, opts))),
    toBeDisabled: (opts) =>
      runStep("expect.toBeDisabled", selector, () => run(coord.assertDisabled(selector, opts))),
    toContainText: (expected, opts) =>
      runStep(`expect.toContainText(${JSON.stringify(expected)})`, selector, () =>
        run(coord.assertContainsText(selector, expected, opts)),
      ),

    toMatchScreenshot: (name, options) =>
      runStep(`expect.toMatchScreenshot(${JSON.stringify(name)})`, selector, () =>
        run(
          coord.assertScreenshot(selector, name, ctx.flowFilePath, ctx.flowName, ctx.platform, {
            threshold: options?.threshold ?? visualRegression?.threshold,
            maxDiffPixelRatio: options?.maxDiffPixelRatio ?? visualRegression?.maxDiffPixelRatio,
            mask: [],
            updateBaselines: ctx.updateBaselines,
            baselinesDir: visualRegression?.baselinesDir,
          }),
        ),
      ),

    toPassAccessibilityAudit: (options) => {
      const excludeCss = options?.exclude?.map(selectorToCss).filter(Boolean) ?? [];
      const targetCss = selectorToCss(selector);
      return runStep("expect.toPassAccessibilityAudit", selector, () =>
        run(
          coord.assertAccessibilityAudit(ctx.platform, {
            severity: options?.severity,
            rules: options?.rules,
            targetSelector: targetCss || undefined,
            excludeSelectors: excludeCss,
          }),
        ),
      );
    },

    toHaveAccessibilityLabel: (expected) =>
      runStep(
        `expect.toHaveAccessibilityLabel(${expected !== undefined ? JSON.stringify(expected) : ""})`,
        selector,
        () => run(coord.assertAccessibilityLabel(selector, expected)),
      ),

    toBeFocusable: () =>
      runStep("expect.toBeFocusable", selector, () =>
        run(coord.assertFocusable(selector, ctx.platform)),
      ),

    toHaveRole: (expected) =>
      runStep(`expect.toHaveRole(${JSON.stringify(expected)})`, selector, () =>
        run(coord.assertRole(selector, expected, ctx.platform)),
      ),

    toHaveMinTouchTarget: (size = 44) =>
      runStep(`expect.toHaveMinTouchTarget(${size})`, selector, () =>
        run(coord.assertMinTouchTarget(selector, size)),
      ),
  });
}
