import type { Element } from "../schemas/element.js";

/**
 * Raw JSON node shape emitted by the page.evaluate walk in playwright.ts.
 */
interface RawWebNode {
  tag?: string;
  id?: string;
  text?: string;
  accessibilityLabel?: string;
  role?: string;
  bounds: { x: number; y: number; width: number; height: number };
  enabled?: boolean;
  visible?: boolean;
  clickable?: boolean;
  children?: RawWebNode[];
}

function rawNodeToElement(node: RawWebNode): Element {
  const children =
    node.children && node.children.length > 0
      ? node.children.map(rawNodeToElement)
      : undefined;

  return {
    ...(node.id !== undefined ? { id: node.id } : {}),
    ...(node.text !== undefined ? { text: node.text } : {}),
    ...(node.accessibilityLabel !== undefined
      ? { accessibilityLabel: node.accessibilityLabel }
      : {}),
    // Use role as elementType when present, otherwise fall back to HTML tag name
    ...(node.role !== undefined
      ? { elementType: node.role }
      : node.tag !== undefined
        ? { elementType: node.tag }
        : {}),
    bounds: {
      x: node.bounds.x,
      y: node.bounds.y,
      width: node.bounds.width,
      height: node.bounds.height,
    },
    ...(node.enabled !== undefined ? { enabled: node.enabled } : {}),
    ...(node.visible !== undefined ? { visible: node.visible } : {}),
    ...(node.clickable !== undefined ? { clickable: node.clickable } : {}),
    ...(children !== undefined ? { children } : {}),
  };
}

/**
 * Parses the JSON string produced by Playwright's dumpHierarchy into the unified Element tree.
 *
 * The JSON shape matches what page.evaluate produces in playwright.ts:
 * - `id` comes from data-testid / testID attributes
 * - `accessibilityLabel` comes from aria-label
 * - `role` is preferred over `tag` as the elementType
 * - `bounds` is a {x, y, width, height} object from getBoundingClientRect
 * - `enabled`, `visible`, `clickable` are booleans
 *
 * @throws SyntaxError if the string is not valid JSON
 * @throws Error if the JSON does not have a `bounds` field at the root
 */
export function parseWebHierarchy(json: string): Element {
  const raw = JSON.parse(json) as RawWebNode;
  return rawNodeToElement(raw);
}
