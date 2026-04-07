import type { Element } from "../../schemas/element.js";
import { tokenizeXML, type RawNode } from "../common/xml-tokenizer.js";

/**
 * Parses Android UiAutomator2 bounds string "[x1,y1][x2,y2]" into {x, y, width, height}.
 */
function parseBounds(s: string): Element["bounds"] {
  // "[x1,y1][x2,y2]" → "x1,y1,x2,y2"
  const normalized = s.replace("][", ",").replaceAll(/[[\]]/g, "");
  const parts = normalized.split(",");
  if (parts.length !== 4) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const x1 = parseInt(parts[0]!, 10);
  const y1 = parseInt(parts[1]!, 10);
  const x2 = parseInt(parts[2]!, 10);
  const y2 = parseInt(parts[3]!, 10);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * Strips the package prefix from a resource-id.
 * "com.app:id/login_btn" → "login_btn"
 * "login_btn" → "login_btn"
 */
function stripResourceIdPrefix(resourceId: string): string {
  const colonSlash = resourceId.indexOf(":id/");
  if (colonSlash !== -1) {
    return resourceId.slice(colonSlash + 4);
  }
  return resourceId;
}

/**
 * Post-processes RawNodes from the shared tokenizer for Android.
 * Sets attrs["class"] from tagName if not already present (Appium <node class="..."> pattern).
 */
function prepareAndroidNode(node: RawNode): void {
  if (!node.attrs["class"]) {
    node.attrs["class"] = node.tagName;
  }
  for (const child of node.children) {
    prepareAndroidNode(child);
  }
}

function rawNodeToElement(node: RawNode): Element {
  const a = node.attrs;

  const rawId = a["resource-id"] ?? "";
  const id = rawId ? stripResourceIdPrefix(rawId) : undefined;
  const text = a["text"] || undefined;
  const accessibilityLabel = a["content-desc"] || undefined;
  const elementType = a["class"] || undefined;
  const boundsStr = a["bounds"] ?? "[0,0][0,0]";
  const bounds = parseBounds(boundsStr);
  const enabled = a["enabled"] !== undefined ? a["enabled"] === "true" : undefined;
  const focused = a["focused"] !== undefined ? a["focused"] === "true" : undefined;
  const clickable = a["clickable"] !== undefined ? a["clickable"] === "true" : undefined;

  // For input elements, text is the current value
  const isInput =
    elementType === "android.widget.EditText" ||
    elementType === "android.widget.AutoCompleteTextView";
  const value = isInput ? text : undefined;

  // Pass through raw attributes for getAttribute() introspection
  const attributes: Record<string, string> = {};
  for (const [key, val] of Object.entries(a)) {
    if (key !== "bounds") attributes[key] = val;
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
    ...(focused !== undefined ? { focused } : {}),
    ...(clickable !== undefined ? { clickable } : {}),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(children !== undefined ? { children } : {}),
  };
}

/**
 * Parses Android UiAutomator2 page source XML into the unified Element tree.
 *
 * Supports both formats:
 * - Appium: `<hierarchy><node class="..." ...>...</node></hierarchy>`
 * - UIAutomator dump: `<hierarchy><android.widget.FrameLayout ...>...</android.widget.FrameLayout></hierarchy>`
 *
 * @throws Error if the XML contains no hierarchy element or no root nodes
 */
export function parseAndroidHierarchy(xml: string): Element {
  const roots = tokenizeXML(xml, "hierarchy");
  for (const root of roots) {
    prepareAndroidNode(root);
  }

  if (roots.length === 0) {
    throw new Error("parseAndroidHierarchy: no root elements found in hierarchy");
  }

  if (roots.length === 1) {
    return rawNodeToElement(roots[0]!);
  }

  // Multiple roots — wrap in a synthetic root with zero bounds
  return {
    elementType: "hierarchy",
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    children: roots.map(rawNodeToElement),
  };
}
