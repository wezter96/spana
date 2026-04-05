/** Pure tree operations on Element-like plain objects. No Effect dependency. */

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Element {
  elementType?: string;
  resourceId?: string;
  text?: string;
  accessibilityLabel?: string;
  bounds?: Bounds;
  children?: readonly Element[];
}

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
  let current: Element = root;
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
      if (!el.bounds) return false;
      const { x: bx, y: by, width, height } = el.bounds;
      return x >= bx && x <= bx + width && y >= by && y <= by + height;
    })
    .reverse(); // deepest first
}
