import { Effect } from "effect";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { ExtendedSelector } from "../schemas/selector.js";
import { createCoordinator, type CoordinatorConfig } from "../smart/coordinator.js";
import type { WaitOptions } from "../smart/auto-wait.js";
import type { StepRecorder } from "../core/step-recorder.js";

export interface PromiseExpectation {
  toBeVisible(opts?: WaitOptions): Promise<void>;
  toBeHidden(opts?: WaitOptions): Promise<void>;
  toHaveText(expected: string, opts?: WaitOptions): Promise<void>;
  toMatchText(pattern: RegExp, opts?: WaitOptions): Promise<void>;
  toHaveValue(expected: string | number, opts?: WaitOptions): Promise<void>;
  toHaveAttribute(name: string, value?: string, opts?: WaitOptions): Promise<void>;
  toBeEnabled(opts?: WaitOptions): Promise<void>;
  toBeDisabled(opts?: WaitOptions): Promise<void>;
  toContainText(expected: string, opts?: WaitOptions): Promise<void>;
}

export function createPromiseExpect(
  driver: RawDriverService,
  config: CoordinatorConfig,
  recorder?: StepRecorder,
): (selector: ExtendedSelector) => PromiseExpectation {
  const coord = createCoordinator(driver, config);

  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

  const runStep = <A>(command: string, selector: ExtendedSelector, action: () => Promise<A>) =>
    recorder ? recorder.runStep(command, action, { selector, captureScreenshot: false }) : action();

  return (selector: ExtendedSelector): PromiseExpectation => ({
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
  });
}
