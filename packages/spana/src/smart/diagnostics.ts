import type { Element } from "../schemas/element.js";
import type { ExtendedSelector } from "../schemas/selector.js";
import { flattenElements, matchesSelector } from "./element-matcher.js";
import { isRelativeSelector } from "../schemas/selector.js";

export interface DiagnosticResult {
  /** Why the element wasn't found */
  reason: "not-found" | "not-visible" | "not-interactive" | "off-screen";
  /** Suggested similar selectors */
  suggestions: string[];
  /** Total elements in the tree */
  totalElements: number;
}

/** Analyze why an element wasn't found and suggest alternatives */
export function diagnoseElementNotFound(
  root: Element,
  selector: ExtendedSelector,
): DiagnosticResult {
  const allElements = flattenElements(root);
  const totalElements = allElements.length;
  const suggestions: string[] = [];

  // Extract the simple selector for matching
  const simpleSelector = isRelativeSelector(selector) ? selector.selector : selector;

  // 1. Check if element matches but is not visible
  const matchingButHidden = allElements.filter(
    (el) => matchesSelector(el, simpleSelector) && el.visible === false,
  );
  if (matchingButHidden.length > 0) {
    return {
      reason: "not-visible",
      suggestions: [
        `Element matches selector but has visible=false (${matchingButHidden.length} match(es))`,
      ],
      totalElements,
    };
  }

  // 2. Check if element matches but is off-screen
  const matchingButOffScreen = allElements.filter(
    (el) =>
      matchesSelector(el, simpleSelector) &&
      el.visible !== false &&
      (el.bounds.width <= 0 ||
        el.bounds.height <= 0 ||
        el.bounds.x + el.bounds.width / 2 < 0 ||
        el.bounds.y + el.bounds.height / 2 < 0),
  );
  if (matchingButOffScreen.length > 0) {
    return {
      reason: "off-screen",
      suggestions: [
        `Element matches selector but is off-screen or has zero size (${matchingButOffScreen.length} match(es))`,
      ],
      totalElements,
    };
  }

  // 3. Check if element matches but is not interactive (enabled=false)
  const matchingButDisabled = allElements.filter(
    (el) => matchesSelector(el, simpleSelector) && el.visible !== false && el.enabled === false,
  );
  if (matchingButDisabled.length > 0) {
    return {
      reason: "not-interactive",
      suggestions: [`Element matches selector but is disabled (enabled=false)`],
      totalElements,
    };
  }

  // 4. Suggest similar selectors (fuzzy matching for testID and text)
  if (typeof simpleSelector === "string") {
    // Text selector — find elements with similar text
    const similar = findSimilarByText(allElements, simpleSelector);
    suggestions.push(...similar);
  } else if ("testID" in simpleSelector && simpleSelector.testID) {
    const similar = findSimilarByTestID(allElements, simpleSelector.testID);
    suggestions.push(...similar);
  } else if (
    "text" in simpleSelector &&
    typeof simpleSelector.text === "string" &&
    simpleSelector.text
  ) {
    const similar = findSimilarByText(allElements, simpleSelector.text);
    suggestions.push(...similar);
  }

  return { reason: "not-found", suggestions, totalElements };
}

function findSimilarByTestID(elements: Element[], targetId: string): string[] {
  const lower = targetId.toLowerCase();
  const prefix = lower.slice(0, Math.max(3, Math.floor(lower.length / 2)));
  return elements
    .filter((el) => el.id && el.id.toLowerCase().includes(prefix))
    .slice(0, 3)
    .map((el) => `Did you mean testID "${el.id}"?`);
}

function findSimilarByText(elements: Element[], targetText: string): string[] {
  const lower = targetText.toLowerCase();
  const prefix = lower.slice(0, 3);
  return elements
    .filter((el) => {
      if (!el.text) return false;
      const elLower = el.text.toLowerCase();
      // Check if they share a significant substring
      return elLower.includes(prefix) || lower.includes(elLower.slice(0, 3));
    })
    .filter((el) => el.visible !== false)
    .slice(0, 3)
    .map((el) => `Did you mean text "${el.text}"?`);
}

/** Format diagnostic result into a human-readable suggestion string */
export function formatDiagnostic(diag: DiagnosticResult): string {
  const parts: string[] = [];

  if (diag.reason === "not-visible") {
    parts.push("Element exists but is not visible.");
  } else if (diag.reason === "off-screen") {
    parts.push("Element exists but is off-screen or has zero size. Try scrolling to it.");
  } else if (diag.reason === "not-interactive") {
    parts.push("Element exists but is disabled (not interactive).");
  }

  if (diag.suggestions.length > 0) {
    parts.push(...diag.suggestions);
  }

  parts.push(`(${diag.totalElements} elements in hierarchy)`);

  return parts.join("\n");
}
