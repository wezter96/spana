import type { Element } from "../../schemas/element.js";

export interface FlatElement {
  element: Element;
  depth: number;
  path: number[];
}

/** Flatten an Element tree into a list with depth and path info. */
export function flattenTree(root: Element, depth = 0, path: number[] = []): FlatElement[] {
  const result: FlatElement[] = [{ element: root, depth, path }];
  if (root.children) {
    for (let i = 0; i < root.children.length; i++) {
      result.push(...flattenTree(root.children[i], depth + 1, [...path, i]));
    }
  }
  return result;
}

/** Find an element by path indices in the tree. */
export function getElementByPath(root: Element, path: number[]): Element | undefined {
  let current = root;
  for (const index of path) {
    if (!current.children?.[index]) return undefined;
    current = current.children[index];
  }
  return current;
}

/** Find elements whose bounds contain the given point. Returns deepest match first. */
export function elementsAtPoint(root: Element, x: number, y: number): FlatElement[] {
  return flattenTree(root)
    .filter(({ element: el }) => {
      const { x: bx, y: by, width, height } = el.bounds;
      return x >= bx && x <= bx + width && y >= by && y <= by + height;
    })
    .reverse(); // deepest first
}

/** Search elements by text, resourceId, accessibilityLabel, or elementType (case-insensitive substring). */
export function searchElements(root: Element, query: string): FlatElement[] {
  const q = query.toLowerCase();
  return flattenTree(root).filter(({ element: el }) => {
    return (
      el.text?.toLowerCase().includes(q) ||
      el.resourceId?.toLowerCase().includes(q) ||
      el.accessibilityLabel?.toLowerCase().includes(q) ||
      el.elementType?.toLowerCase().includes(q)
    );
  });
}
