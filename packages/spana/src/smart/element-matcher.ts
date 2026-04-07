import type { Element } from "../schemas/element.js";
import type { Selector, ExtendedSelector, RelativeSelector } from "../schemas/selector.js";
import { isRelativeSelector } from "../schemas/selector.js";

/** Flatten an element tree into a list (iterative DFS — avoids recursive spread allocation) */
export function flattenElements(root: Element): Element[] {
  const result: Element[] = [];
  const stack: Element[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    result.push(node);
    if (node.children) {
      // Push in reverse so left-most children are visited first (preserves DFS order)
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]!);
      }
    }
  }
  return result;
}

/** Check if an element matches a selector */
export function matchesSelector(element: Element, selector: Selector): boolean {
  if (typeof selector === "string") {
    // String shorthand = text match (case-insensitive)
    return element.text?.toLowerCase().includes(selector.toLowerCase()) ?? false;
  }
  if ("testID" in selector) {
    return element.id === selector.testID;
  }
  if ("text" in selector) {
    return element.text?.toLowerCase().includes(selector.text.toLowerCase()) ?? false;
  }
  if ("accessibilityLabel" in selector) {
    return element.accessibilityLabel === selector.accessibilityLabel;
  }
  if ("point" in selector) {
    const { x, y } = selector.point;
    const b = element.bounds;
    return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
  }
  return false;
}

/** Find all elements matching a selector */
export function findElements(root: Element, selector: Selector): Element[] {
  return flattenElements(root).filter((el) => matchesSelector(el, selector));
}

interface ElementPath {
  element: Element;
  ancestors: Element[];
}

function isProbablyOnScreen(element: Element): boolean {
  const centerX = element.bounds.x + element.bounds.width / 2;
  const centerY = element.bounds.y + element.bounds.height / 2;

  return element.bounds.width > 0 && element.bounds.height > 0 && centerX >= 0 && centerY >= 0;
}

function findPathToElement(root: Element, target: Element): ElementPath | undefined {
  const stack: ElementPath[] = [{ element: root, ancestors: [] }];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.element === target) {
      return current;
    }

    const children = current.element.children;
    if (!children) {
      continue;
    }

    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]!;
      stack.push({
        element: child,
        ancestors: [...current.ancestors, current.element],
      });
    }
  }

  return undefined;
}

function isActionable(element: Element): boolean {
  return (
    element.visible !== false &&
    element.enabled !== false &&
    element.clickable === true &&
    isProbablyOnScreen(element)
  );
}

function resolveActionTarget(root: Element, element: Element): Element {
  const path = findPathToElement(root, element);
  if (!path) {
    return element;
  }

  const candidates = [path.element, ...path.ancestors.toReversed()];
  return candidates.find(isActionable) ?? element;
}

/** Find the best matching element — prefer clickable, then deepest */
export function findElement(root: Element, selector: Selector): Element | undefined {
  const matches = findElements(root, selector).filter((el) => el.visible !== false);
  if (matches.length === 0) return undefined;

  const visibleMatches = matches.filter(isProbablyOnScreen);
  if (visibleMatches.length === 0) return undefined;

  // Prefer clickable elements
  const clickable = visibleMatches.filter((el) => el.clickable);
  if (clickable.length > 0) return clickable[clickable.length - 1]!; // deepest clickable
  return visibleMatches[visibleMatches.length - 1]!; // deepest match
}

/** Find the best actionable target for touch-style interactions. */
export function findActionElement(root: Element, selector: Selector): Element | undefined {
  const match = findElement(root, selector);
  return match ? resolveActionTarget(root, match) : undefined;
}

/** Calculate the center point of an element's bounds */
export function centerOf(element: Element): { x: number; y: number } {
  return {
    x: Math.round(element.bounds.x + element.bounds.width / 2),
    y: Math.round(element.bounds.y + element.bounds.height / 2),
  };
}

/** Format a selector (simple or extended) as a human-readable string for error messages */
export function formatSelector(sel: ExtendedSelector): string {
  if (isRelativeSelector(sel)) {
    const parts = [formatSimpleSelector(sel.selector)];
    if (sel.below) parts.push(`below ${formatSimpleSelector(sel.below)}`);
    if (sel.above) parts.push(`above ${formatSimpleSelector(sel.above)}`);
    if (sel.leftOf) parts.push(`leftOf ${formatSimpleSelector(sel.leftOf)}`);
    if (sel.rightOf) parts.push(`rightOf ${formatSimpleSelector(sel.rightOf)}`);
    if (sel.childOf) parts.push(`childOf ${formatSimpleSelector(sel.childOf)}`);
    return parts.join(" ");
  }
  return formatSimpleSelector(sel);
}

function formatSimpleSelector(sel: Selector): string {
  if (typeof sel === "string") return `"${sel}"`;
  if ("testID" in sel) return `testID: "${sel.testID}"`;
  if ("text" in sel) return `text: "${sel.text}"`;
  if ("accessibilityLabel" in sel) return `accessibilityLabel: "${sel.accessibilityLabel}"`;
  if ("point" in sel) return `point: (${sel.point.x}, ${sel.point.y})`;
  return JSON.stringify(sel);
}

/** Find an element using an extended selector (simple or relative) */
export function findElementExtended(
  root: Element,
  selector: ExtendedSelector,
): Element | undefined {
  if (!isRelativeSelector(selector)) {
    return findElement(root, selector);
  }

  return findRelativeElement(root, selector);
}

/** Find the best actionable element for a simple or relative selector. */
export function findActionElementExtended(
  root: Element,
  selector: ExtendedSelector,
): Element | undefined {
  const match = findElementExtended(root, selector);
  return match ? resolveActionTarget(root, match) : undefined;
}

function findRelativeElement(root: Element, rel: RelativeSelector): Element | undefined {
  // Find all candidates matching the base selector
  const all = flattenElements(root).filter((el) => el.visible !== false && isProbablyOnScreen(el));
  let candidates = all.filter((el) => matchesSelector(el, rel.selector));

  if (candidates.length === 0) return undefined;

  // Apply each relative constraint
  if (rel.below) {
    const anchor = findElement(root, rel.below);
    if (!anchor) return undefined;
    const anchorBottom = anchor.bounds.y + anchor.bounds.height;
    candidates = candidates.filter((el) => el.bounds.y >= anchorBottom);
    // Sort by proximity (closest below first)
    candidates.sort((a, b) => a.bounds.y - b.bounds.y);
  }

  if (rel.above) {
    const anchor = findElement(root, rel.above);
    if (!anchor) return undefined;
    const anchorTop = anchor.bounds.y;
    candidates = candidates.filter((el) => el.bounds.y + el.bounds.height <= anchorTop);
    // Sort by proximity (closest above first = highest y)
    candidates.sort((a, b) => b.bounds.y - a.bounds.y);
  }

  if (rel.leftOf) {
    const anchor = findElement(root, rel.leftOf);
    if (!anchor) return undefined;
    const anchorLeft = anchor.bounds.x;
    candidates = candidates.filter((el) => el.bounds.x + el.bounds.width <= anchorLeft);
    // Sort by proximity (closest left first = highest x)
    candidates.sort((a, b) => b.bounds.x - a.bounds.x);
  }

  if (rel.rightOf) {
    const anchor = findElement(root, rel.rightOf);
    if (!anchor) return undefined;
    const anchorRight = anchor.bounds.x + anchor.bounds.width;
    candidates = candidates.filter((el) => el.bounds.x >= anchorRight);
    // Sort by proximity (closest right first)
    candidates.sort((a, b) => a.bounds.x - b.bounds.x);
  }

  if (rel.childOf) {
    const parent = findElement(root, rel.childOf);
    if (!parent) return undefined;
    // Filter to elements that are descendants of the parent
    const descendants = flattenElements(parent);
    const descendantSet = new Set(descendants);
    candidates = candidates.filter((el) => descendantSet.has(el) && el !== parent);
  }

  return candidates[0];
}
