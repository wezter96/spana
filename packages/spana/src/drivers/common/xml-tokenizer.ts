/**
 * Shared XML tokenizer for mobile page source parsing.
 * Used by both Android (UiAutomator2) and iOS (WDA) drivers.
 */

export interface ParsedAttr {
  [key: string]: string;
}

export interface RawNode {
  tagName: string;
  attrs: ParsedAttr;
  children: RawNode[];
}

/**
 * Extracts all XML attributes from a tag string as a key→value map.
 * Works on the raw text of an opening tag (after stripping the tag name).
 */
export function parseAttributes(tagContent: string): ParsedAttr {
  const attrs: ParsedAttr = {};
  // Match: key="value" — value may contain escaped quotes
  const re = /([\w-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagContent)) !== null) {
    attrs[m[1]!] = m[2]!;
  }
  return attrs;
}

/**
 * Parses XML into a flat array of root-level RawNode trees using a
 * position-based tokenizer.
 *
 * @param xml       The full XML string to parse
 * @param wrapperTag  The top-level wrapper element to skip (e.g. "hierarchy" or "AppiumAUT")
 */
export function tokenizeXML(xml: string, wrapperTag: string): RawNode[] {
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
    while (pos < xml.length && !/[\s/>]/.test(xml[pos]!)) pos++;
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

    const node: RawNode = { tagName, attrs, children: [] };

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

  // Top-level: skip wrapper tag and collect root children
  const roots: RawNode[] = [];
  const closingWrapper = `/${wrapperTag}`;
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
    while (nameEnd < xml.length && !/[\s/>]/.test(xml[nameEnd]!)) nameEnd++;
    const peekName = xml.slice(peek, nameEnd);

    if (peekName === wrapperTag) {
      // Skip the wrapper opening tag
      const close = xml.indexOf(">", pos);
      if (close === -1) break;
      pos = close + 1;
      continue;
    }

    if (peekName === closingWrapper) {
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
