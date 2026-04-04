import type { Element } from "../../schemas/element.js";

/**
 * Parses Android UiAutomator2 bounds string "[x1,y1][x2,y2]" into {x, y, width, height}.
 */
function parseBounds(s: string): Element["bounds"] {
  // "[x1,y1][x2,y2]" → "x1,y1,x2,y2"
  const normalized = s.replace("][", ",").replace(/[\[\]]/g, "");
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

interface ParsedAttr {
  [key: string]: string;
}

/**
 * Extracts all XML attributes from a tag string as a key→value map.
 * Works on the raw text of an opening tag (after stripping the tag name).
 */
function parseAttributes(tagContent: string): ParsedAttr {
  const attrs: ParsedAttr = {};
  // Match: key="value" — value may contain escaped quotes
  const re = /([\w-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagContent)) !== null) {
    attrs[m[1]!] = m[2]!;
  }
  return attrs;
}

interface RawNode {
  attrs: ParsedAttr;
  children: RawNode[];
}

/**
 * Parses Android hierarchy XML using a position-based tokenizer.
 * Handles both <node ...> (Appium) and <ClassName ...> (UIAutomator dump) formats.
 */
function tokenizeXML(xml: string): RawNode[] {
  let pos = 0;

  function skipWhitespace() {
    while (pos < xml.length && /\s/.test(xml[pos]!)) pos++;
  }

  function parseNode(): RawNode | null {
    skipWhitespace();
    if (pos >= xml.length) return null;

    // Expect '<'
    if (xml[pos] !== "<") return null;
    pos++; // consume '<'

    // Skip XML declaration, comments, processing instructions
    if (xml[pos] === "?" || xml[pos] === "!") {
      const close = xml.indexOf(">", pos);
      if (close === -1) return null;
      pos = close + 1;
      return null; // signal to caller to retry
    }

    // Closing tag?
    if (xml[pos] === "/") {
      const close = xml.indexOf(">", pos);
      if (close === -1) return null;
      pos = close + 1;
      return null; // signals end of current parent
    }

    // Read tag name
    const tagStart = pos;
    while (pos < xml.length && !/[\s\/>]/.test(xml[pos]!)) pos++;
    const tagName = xml.slice(tagStart, pos);

    // Read until end of opening tag
    const tagBodyStart = pos;
    let selfClosing = false;
    // Find the closing '>' (may span chars including quoted strings)
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

    // If element has a "class" attribute, prefer it as the element name
    // (Appium <node class="android.widget.Button"> pattern)
    if (!attrs["class"]) {
      attrs["class"] = tagName;
    }

    const node: RawNode = { attrs, children: [] };

    if (!selfClosing) {
      // Parse children until we get a closing tag signal
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

  // Top-level: skip <hierarchy> wrapper and collect root children
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

    if (peekName === "hierarchy") {
      // Skip the <hierarchy ...> opening tag
      const close = xml.indexOf(">", pos);
      if (close === -1) break;
      pos = close + 1;
      continue;
    }

    if (peekName === "/hierarchy") {
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

  const children =
    node.children.length > 0 ? node.children.map(rawNodeToElement) : undefined;

  return {
    ...(id !== undefined ? { id } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(accessibilityLabel !== undefined ? { accessibilityLabel } : {}),
    ...(elementType !== undefined ? { elementType } : {}),
    bounds,
    ...(enabled !== undefined ? { enabled } : {}),
    ...(focused !== undefined ? { focused } : {}),
    ...(clickable !== undefined ? { clickable } : {}),
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
  const roots = tokenizeXML(xml);

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
