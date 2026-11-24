import type { StepResult } from "./types.js";

export interface SelectorWarning {
  rule: "coordinate-tap" | "text-heavy" | "bare-string";
  stepIndex?: number;
  message: string;
}

function isCoordinateTap(step: StepResult): boolean {
  if (step.command === "tapXY" || step.command === "longPressXY") return true;
  if (
    step.selector &&
    typeof step.selector === "object" &&
    "point" in (step.selector as Record<string, unknown>)
  ) {
    return true;
  }
  return false;
}

function isSystemUILabel(selector: unknown): boolean {
  return (
    selector !== null &&
    typeof selector === "object" &&
    "systemUI" in (selector as Record<string, unknown>) &&
    (selector as Record<string, unknown>)["systemUI"] === true
  );
}

function isTextSelector(selector: unknown): boolean {
  if (isSystemUILabel(selector)) return false;
  if (typeof selector === "string") return true;
  if (selector && typeof selector === "object" && "text" in (selector as Record<string, unknown>)) {
    return true;
  }
  return false;
}

function isBareString(selector: unknown): boolean {
  return typeof selector === "string";
}

/**
 * Analyze recorded steps for brittle selector patterns.
 * Returns advisory warnings — never blocks execution.
 */
export function analyzeStepQuality(steps: StepResult[]): SelectorWarning[] {
  const warnings: SelectorWarning[] = [];

  // Only consider steps that have selectors (skip inputText, pressKey, etc.)
  const selectorSteps = steps.filter((s) => s.selector !== undefined);

  for (const [i, step] of steps.entries()) {
    // Rule: coordinate-tap
    if (isCoordinateTap(step)) {
      warnings.push({
        rule: "coordinate-tap",
        stepIndex: i,
        message: `Step ${i + 1} used coordinate tap — prefer testID or text selectors for stability`,
      });
    }

    // Rule: bare-string
    if (step.selector !== undefined && isBareString(step.selector)) {
      warnings.push({
        rule: "bare-string",
        stepIndex: i,
        message: `Step ${i + 1} uses bare string selector '${step.selector}' — prefer { testID: '...' } for unambiguous targeting`,
      });
    }
  }

  // Rule: text-heavy (>50% of selector steps use text/string selectors)
  if (selectorSteps.length >= 2) {
    const textCount = selectorSteps.filter((s) => isTextSelector(s.selector)).length;
    if (textCount > selectorSteps.length / 2) {
      warnings.push({
        rule: "text-heavy",
        message: `Flow uses text selectors for ${textCount}/${selectorSteps.length} steps — consider adding testID attributes for reliability`,
      });
    }
  }

  return warnings;
}
