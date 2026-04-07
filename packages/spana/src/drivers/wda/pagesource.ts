import type { Element } from "../../schemas/element.js";
import { tokenizeXML, type RawNode } from "../common/xml-tokenizer.js";

/**
 * iOS element types that are considered clickable/interactive.
 * Mirrors isClickableType in the Go WDA driver.
 */
const CLICKABLE_TYPES = new Set([
  "XCUIElementTypeButton",
  "XCUIElementTypeLink",
  "XCUIElementTypeTextField",
  "XCUIElementTypeSecureTextField",
  "XCUIElementTypeSearchField",
  "XCUIElementTypeSwitch",
  "XCUIElementTypeSlider",
  "XCUIElementTypeStepper",
  "XCUIElementTypeSegmentedControl",
  "XCUIElementTypeCell",
  "XCUIElementTypeTab",
  "XCUIElementTypeTabBar",
  "XCUIElementTypeMenu",
  "XCUIElementTypeMenuItem",
  "XCUIElementTypePickerWheel",
  "XCUIElementTypeDatePicker",
  "XCUIElementTypeToggle",
  "XCUIElementTypePageIndicator",
]);

/**
 * Post-processes RawNodes from the shared tokenizer for iOS.
 * Resolves tagName from the `type` attribute (iOS WDA includes both the tag
 * and a redundant `type` attr — they're equal; prefer `type` when present).
 */
function prepareIOSNode(node: RawNode): void {
  node.tagName = node.attrs["type"] ?? node.tagName;
  for (const child of node.children) {
    prepareIOSNode(child);
  }
}

function rawNodeToElement(node: RawNode): Element {
  const a = node.attrs;
  const elementType = node.tagName || undefined;

  // `name` is the accessibilityIdentifier — maps to Element.id (testID lives here on iOS)
  const id = a["name"] || undefined;
  // `label` is the human-readable accessibility label
  const accessibilityLabel = a["label"] || undefined;
  // `value` is the current value (text content for text fields, etc.)
  const text = a["value"] || undefined;

  // For text fields, `value` is the input value
  const isTextField =
    elementType === "XCUIElementTypeTextField" ||
    elementType === "XCUIElementTypeSecureTextField" ||
    elementType === "XCUIElementTypeTextView";
  const value = isTextField ? a["value"] || undefined : undefined;

  const x = a["x"] !== undefined ? parseInt(a["x"]!, 10) : 0;
  const y = a["y"] !== undefined ? parseInt(a["y"]!, 10) : 0;
  const width = a["width"] !== undefined ? parseInt(a["width"]!, 10) : 0;
  const height = a["height"] !== undefined ? parseInt(a["height"]!, 10) : 0;
  const bounds = { x, y, width, height };

  const enabled = a["enabled"] !== undefined ? a["enabled"] === "true" : undefined;
  // iOS uses `visible` for display state
  const visible = a["visible"] !== undefined ? a["visible"] === "true" : undefined;
  const focused = a["focused"] !== undefined ? a["focused"] === "true" : undefined;

  // iOS doesn't expose a clickable attribute — infer from element type
  const clickable = elementType !== undefined ? CLICKABLE_TYPES.has(elementType) : undefined;

  // Pass through raw attributes for getAttribute() introspection
  const attributes: Record<string, string> = {};
  for (const [key, val] of Object.entries(a)) {
    attributes[key] = val;
  }

  const children = node.children.length > 0 ? node.children.map(rawNodeToElement) : undefined;

  return {
    ...(id !== undefined ? { id } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(accessibilityLabel !== undefined ? { accessibilityLabel } : {}),
    ...(elementType !== undefined ? { elementType } : {}),
    bounds,
    ...(enabled !== undefined ? { enabled } : {}),
    ...(visible !== undefined ? { visible } : {}),
    ...(focused !== undefined ? { focused } : {}),
    ...(clickable !== undefined ? { clickable } : {}),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(children !== undefined ? { children } : {}),
  };
}

/**
 * Parses iOS WebDriverAgent page source XML into the unified Element tree.
 *
 * iOS WDA wraps everything in `<AppiumAUT>` and uses `XCUIElementType*` tag names.
 * The `name` attribute carries the accessibilityIdentifier (where testID maps to).
 * Clickability is inferred from the element type since iOS doesn't expose a clickable attr.
 *
 * @throws Error if no elements are found in the XML
 */
export function parseIOSHierarchy(xml: string): Element {
  const roots = tokenizeXML(xml, "AppiumAUT");
  for (const root of roots) {
    prepareIOSNode(root);
  }

  if (roots.length === 0) {
    throw new Error("parseIOSHierarchy: no elements found in page source");
  }

  if (roots.length === 1) {
    return rawNodeToElement(roots[0]!);
  }

  // Multiple roots — wrap in a synthetic root
  return {
    elementType: "AppiumAUT",
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    children: roots.map(rawNodeToElement),
  };
}
