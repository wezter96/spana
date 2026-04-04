import type { Element } from "../../schemas/element.js";

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

interface ParsedAttr {
  [key: string]: string;
}

/**
 * Extracts all XML attributes from a tag body string as a key→value map.
 */
function parseAttributes(tagContent: string): ParsedAttr {
  const attrs: ParsedAttr = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagContent)) !== null) {
    attrs[m[1]!] = m[2]!;
  }
  return attrs;
}

interface RawNode {
  tagName: string;
  attrs: ParsedAttr;
  children: RawNode[];
}

/**
 * Parses iOS WDA XML using a position-based tokenizer.
 * iOS uses XCUIElementType* as element tag names, with an AppiumAUT root wrapper.
 */
function tokenizeXML(xml: string): RawNode[] {
  let pos = 0;

  function skipWhitespace() {
    while (pos < xml.length && /\s/.test(xml[pos]!)) pos++;
  }

  function parseNode(): RawNode | null {
    skipWhitespace();
    if (pos >= xml.length) return null;
    if (xml[pos] !== "<") return null;
    pos++; // consume '<'

    // Skip XML declaration, comments, processing instructions
    if (xml[pos] === "?" || xml[pos] === "!") {
      const close = xml.indexOf(">", pos);
      if (close === -1) return null;
      pos = close + 1;
      return null;
    }

    // Closing tag — signal end of parent
    if (xml[pos] === "/") {
      const close = xml.indexOf(">", pos);
      if (close !== -1) pos = close + 1;
      return null;
    }

    // Read tag name
    const tagStart = pos;
    while (pos < xml.length && !/[\s\/>]/.test(xml[pos]!)) pos++;
    const tagName = xml.slice(tagStart, pos);

    // Read through tag body to find end of opening tag
    const tagBodyStart = pos;
    let selfClosing = false;
    let inQuote = false;
    let quoteChar = "";
    while (pos < xml.length) {
      const ch = xml[pos]!;
      if (inQuote) {
        if (ch === quoteChar) inQuote = false;
      } else {
        if (ch === '"' || ch === "'") {
          inQuote = true;
          quoteChar = ch;
        } else if (ch === "/" && xml[pos + 1] === ">") {
          selfClosing = true;
          pos += 2;
          break;
        } else if (ch === ">") {
          pos++;
          break;
        }
      }
      pos++;
    }

    const tagBody = xml.slice(tagBodyStart, selfClosing ? pos - 2 : pos - 1);
    const attrs = parseAttributes(tagBody);

    // The `type` attribute overrides the tag name for XCUIElementType elements
    // (iOS WDA includes both the tag and a redundant `type` attr — they're equal)
    const resolvedType = attrs["type"] ?? tagName;

    const node: RawNode = { tagName: resolvedType, attrs, children: [] };

    if (!selfClosing) {
      while (pos < xml.length) {
        skipWhitespace();
        if (pos >= xml.length) break;
        if (xml[pos] === "<" && xml[pos + 1] === "/") {
          // Consume closing tag
          const close = xml.indexOf(">", pos);
          if (close !== -1) pos = close + 1;
          break;
        }
        const child = parseNode();
        if (child !== null) {
          node.children.push(child);
        }
      }
    }

    return node;
  }

  // Top-level: skip <AppiumAUT> wrapper and collect root children
  const roots: RawNode[] = [];
  while (pos < xml.length) {
    skipWhitespace();
    if (pos >= xml.length) break;

    if (xml[pos] !== "<") {
      pos++;
      continue;
    }

    // Peek at tag name
    const peek = pos + 1;
    let nameEnd = peek;
    while (nameEnd < xml.length && !/[\s\/>]/.test(xml[nameEnd]!)) nameEnd++;
    const peekName = xml.slice(peek, nameEnd);

    if (peekName === "AppiumAUT") {
      // Skip the <AppiumAUT> opening tag
      const close = xml.indexOf(">", pos);
      if (close === -1) break;
      pos = close + 1;
      continue;
    }

    if (peekName === "/AppiumAUT") {
      const close = xml.indexOf(">", pos);
      if (close !== -1) pos = close + 1;
      break;
    }

    if (peekName.startsWith("?") || peekName.startsWith("!")) {
      const close = xml.indexOf(">", pos);
      if (close !== -1) pos = close + 1;
      continue;
    }

    const node = parseNode();
    if (node !== null) {
      roots.push(node);
    }
  }

  return roots;
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
  const clickable =
    elementType !== undefined ? CLICKABLE_TYPES.has(elementType) : undefined;

  const children =
    node.children.length > 0 ? node.children.map(rawNodeToElement) : undefined;

  return {
    ...(id !== undefined ? { id } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(accessibilityLabel !== undefined ? { accessibilityLabel } : {}),
    ...(elementType !== undefined ? { elementType } : {}),
    bounds,
    ...(enabled !== undefined ? { enabled } : {}),
    ...(visible !== undefined ? { visible } : {}),
    ...(focused !== undefined ? { focused } : {}),
    ...(clickable !== undefined ? { clickable } : {}),
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
  const roots = tokenizeXML(xml);

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
