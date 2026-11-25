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
  let baseMatch = false;
  if ("testID" in selector) {
    baseMatch = element.id === selector.testID;
  } else if ("text" in selector) {
    baseMatch = selector.exact
      ? element.text === selector.text
      : (element.text?.toLowerCase().includes(selector.text.toLowerCase()) ?? false);
  } else if ("accessibilityLabel" in selector) {
    baseMatch = element.accessibilityLabel === selector.accessibilityLabel;
  } else if ("role" in selector) {
    const elRole = (element.attributes?.role ?? element.elementType ?? "").toLowerCase();
    const roleMatch = elRole === selector.role.toLowerCase();
    if (!roleMatch) return false;
    if (selector.name === undefined) {
      baseMatch = true;
    } else {
      const candidateName = element.accessibilityLabel ?? element.text ?? "";
      baseMatch =
        selector.name instanceof RegExp
          ? selector.name.test(candidateName)
          : selector.exact
            ? candidateName === selector.name
            : candidateName.toLowerCase().includes(selector.name.toLowerCase());
    }
  } else if ("css" in selector) {
    // Native hierarchy fallback cannot evaluate arbitrary CSS; DOM channel handles `{ css }`.
    baseMatch = false;
  } else if ("anyOf" in selector && Array.isArray(selector.anyOf)) {
    baseMatch = selector.anyOf.some((branch) => matchesSelector(element, branch));
  } else if ("point" in selector) {
    const { x, y } = selector.point;
    const b = element.bounds;
    baseMatch = x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
  }

  if (!baseMatch) return false;

  if (!("point" in selector)) {
    const text = element.text ?? element.accessibilityLabel ?? "";
    if (selector.hasText !== undefined) {
      const ok =
        selector.hasText instanceof RegExp
          ? selector.hasText.test(text)
          : text.toLowerCase().includes(selector.hasText.toLowerCase());
      if (!ok) return false;
    }
    if (selector.hasNotText !== undefined) {
      const bad =
        selector.hasNotText instanceof RegExp
          ? selector.hasNotText.test(text)
          : text.toLowerCase().includes(selector.hasNotText.toLowerCase());
      if (bad) return false;
    }
    if (selector.has !== undefined) {
      const descendants = flattenElements(element).slice(1);
      if (!descendants.some((d) => matchesSelector(d, selector.has!))) return false;
    }
    if (selector.hasNot !== undefined) {
      const descendants = flattenElements(element).slice(1);
      if (descendants.some((d) => matchesSelector(d, selector.hasNot!))) return false;
    }
  }

  return true;
}

/** Find all elements matching a selector */
export function findElements(root: Element, selector: Selector): Element[] {
  const matched = flattenElements(root).filter((el) => matchesSelector(el, selector));
  if (typeof selector === "object" && selector !== null && !("point" in selector)) {
    if (selector.first) return matched.length > 0 ? [matched[0]!] : [];
    if (selector.last) return matched.length > 0 ? [matched[matched.length - 1]!] : [];
    if (selector.nth !== undefined) {
      const idx = selector.nth < 0 ? matched.length + selector.nth : selector.nth;
      return idx >= 0 && idx < matched.length ? [matched[idx]!] : [];
    }
  }
  return matched;
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
  let base: string;
  if ("testID" in sel) base = `testID: "${sel.testID}"`;
  else if ("text" in sel) base = `text: "${sel.text}"`;
  else if ("accessibilityLabel" in sel) base = `accessibilityLabel: "${sel.accessibilityLabel}"`;
  else if ("role" in sel) {
    const parts = [`role: "${sel.role}"`];
    if (sel.name !== undefined) {
      parts.push(
        `name: ${sel.name instanceof RegExp ? sel.name.toString() : JSON.stringify(sel.name)}`,
      );
    }
    if (sel.level !== undefined) parts.push(`level: ${sel.level}`);
    base = parts.join(", ");
  } else if ("css" in sel) base = `css: "${sel.css}"`;
  else if ("anyOf" in sel) base = `or(${sel.anyOf.map(formatSimpleSelector).join(", ")})`;
  else if ("point" in sel) return `point: (${sel.point.x}, ${sel.point.y})`;
  else return JSON.stringify(sel);

  const mods: string[] = [];
  if (sel.frame) mods.push(`inFrame(${formatSimpleSelector(sel.frame)})`);
  if (sel.within) mods.push(`within(${formatSimpleSelector(sel.within)})`);
  if (sel.hasText !== undefined) {
    mods.push(
      `hasText(${sel.hasText instanceof RegExp ? sel.hasText.toString() : JSON.stringify(sel.hasText)})`,
    );
  }
  if (sel.hasNotText !== undefined) {
    mods.push(
      `hasNotText(${sel.hasNotText instanceof RegExp ? sel.hasNotText.toString() : JSON.stringify(sel.hasNotText)})`,
    );
  }
  if (sel.has !== undefined) mods.push(`has(${formatSimpleSelector(sel.has)})`);
  if (sel.hasNot !== undefined) mods.push(`hasNot(${formatSimpleSelector(sel.hasNot)})`);
  if (sel.first) mods.push("first");
  else if (sel.last) mods.push("last");
  else if (sel.nth !== undefined) mods.push(`nth(${sel.nth})`);

  return mods.length > 0 ? `${base} [${mods.join(", ")}]` : base;
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
