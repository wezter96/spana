import { Schema } from "effect";

export type Platform = "android" | "ios" | "web" | "electron" | "electrobun";

export type TapMode = "native" | "dom";

/**
 * Composable narrowing / scoping modifiers supported on any object selector.
 * Mirrors Playwright's locator composition (`locator(a).locator(b)`, `.nth()`, `.first()`,
 * `.filter({ hasText })`, `frameLocator(...)`) in plain serializable selector objects.
 */
export interface SelectorModifiers<T extends string = string> {
  /** Scope search inside elements matching this parent selector (`locator(parent).locator(child)`). */
  within?: Selector<T>;
  /** Scope search inside an `<iframe>` matching this selector (`frameLocator(frame)`). */
  frame?: Selector<T>;
  /** Keep only matches whose text contains this string or matches this RegExp (`.filter({ hasText })`). */
  hasText?: string | RegExp;
  /** Exclude matches whose text contains this string or matches this RegExp (`.filter({ hasNotText })`). */
  hasNotText?: string | RegExp;
  /** Keep only matches containing a descendant matching this selector (`.filter({ has })`). */
  has?: Selector<T>;
  /** Exclude matches containing a descendant matching this selector (`.filter({ hasNot })`). */
  hasNot?: Selector<T>;
  /** Select the 0-based Nth match (negative values count from the end, e.g. `-1` for last). */
  nth?: number;
  /** Shorthand for `nth: 0` (`.first()`). */
  first?: boolean;
  /** Shorthand for `nth: -1` (`.last()`). */
  last?: boolean;
}

// Runtime schema definitions — used for Schema.decode / .parse on config-time
// selector payloads. The TypeScript types below are generic over a testID
// string union `T` so projects can pass a typed set of testIDs and get
// autocomplete + misspelling protection at the call site.
const _TestIDSelectorSchema = Schema.Struct({ testID: Schema.String });
const _TextSelectorSchema = Schema.Struct({
  text: Schema.String,
  systemUI: Schema.optional(Schema.Boolean),
});
const _AccessibilityLabelSelectorSchema = Schema.Struct({
  accessibilityLabel: Schema.String,
  systemUI: Schema.optional(Schema.Boolean),
});
const _RoleSelectorSchema = Schema.Struct({
  role: Schema.String,
  name: Schema.optional(Schema.String),
  exact: Schema.optional(Schema.Boolean),
  level: Schema.optional(Schema.Number),
  includeHidden: Schema.optional(Schema.Boolean),
});
const _CssSelectorSchema = Schema.Struct({
  css: Schema.String,
});
const _PointSelectorSchema = Schema.Struct({
  point: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
});

export const SelectorSchema = Schema.Union([
  Schema.String,
  _TestIDSelectorSchema,
  _TextSelectorSchema,
  _AccessibilityLabelSelectorSchema,
  _RoleSelectorSchema,
  _CssSelectorSchema,
  _PointSelectorSchema,
]);

export type ObjectSelector<T extends string = string> =
  | ({ testID: T } & SelectorModifiers<T>)
  | ({ text: string; systemUI?: boolean; exact?: boolean } & SelectorModifiers<T>)
  | ({ accessibilityLabel: string; systemUI?: boolean } & SelectorModifiers<T>)
  | ({ label: string | RegExp; exact?: boolean } & SelectorModifiers<T>)
  | ({ placeholder: string | RegExp; exact?: boolean } & SelectorModifiers<T>)
  | ({ altText: string | RegExp; exact?: boolean } & SelectorModifiers<T>)
  | ({ title: string | RegExp; exact?: boolean } & SelectorModifiers<T>)
  | ({
      role: string;
      name?: string | RegExp;
      exact?: boolean;
      level?: number;
      includeHidden?: boolean;
    } & SelectorModifiers<T>)
  | ({ css: string } & SelectorModifiers<T>)
  | ({ anyOf: Selector<T>[] } & SelectorModifiers<T>)
  | ({ allOf: Selector<T>[] } & SelectorModifiers<T>)
  | { point: { x: number; y: number } };

/**
 * Selector types. Generic parameter `T` lets projects pin a union of known
 * testIDs so `{ testID: "bogus-id" }` becomes a type error.
 *
 * Supports composable Playwright-grade locators:
 * - `{ testID: "submit" }`
 * - `{ role: "button", name: /save/i }`
 * - `{ css: "form.checkout input[name='email']" }`
 * - `{ text: "Continue" }` / `{ accessibilityLabel: "Close" }`
 * - Modifiers: `within`, `frame`, `hasText`, `hasNotText`, `nth`, `first`, `last`
 * - Helpers: `byRole()`, `byCss()`, `within()`, `inFrame()`, `nth()`, `first()`, `last()`, `filterSelector()`
 *
 * Use `systemUI: true` (or the `systemUI(...)` helper) on `{ text }` /
 * `{ accessibilityLabel }` selectors that intentionally target out-of-process
 * OS UI (SFSafariViewController, ASWebAuthenticationSession, Chrome Custom Tabs,
 * permission dialogs) where DOM `data-testid` cannot reach.
 */
export type Selector<T extends string = string> = T | ObjectSelector<T>;

/** Relative selector — find element relative to an anchor element's position. */
export interface RelativeSelector<T extends string = string> {
  selector: Selector<T>;
  below?: Selector<T>;
  above?: Selector<T>;
  leftOf?: Selector<T>;
  rightOf?: Selector<T>;
  childOf?: Selector<T>;
}

/** Extended selector that supports both simple and relative selectors. */
export type ExtendedSelector<T extends string = string> = Selector<T> | RelativeSelector<T>;

export function isRelativeSelector<T extends string = string>(
  sel: ExtendedSelector<T>,
): sel is RelativeSelector<T> {
  return typeof sel === "object" && sel !== null && "selector" in sel;
}

function toObjectSelector<T extends string = string>(sel: Selector<T>): ObjectSelector<T> {
  if (typeof sel === "string") {
    return { text: sel };
  }
  return sel;
}

/** Build an ARIA role selector (`getByRole(role, { name, exact, level, includeHidden })` or shorthand `byRole(role, name, opts)`). */
export function byRole<T extends string = string>(
  role: string,
  opts?: {
    name?: string | RegExp;
    exact?: boolean;
    level?: number;
    includeHidden?: boolean;
  } & SelectorModifiers<T>,
): ObjectSelector<T>;
export function byRole<T extends string = string>(
  role: string,
  name: string | RegExp,
  opts?: { exact?: boolean; level?: number; includeHidden?: boolean } & SelectorModifiers<T>,
): ObjectSelector<T>;
export function byRole<T extends string = string>(
  role: string,
  nameOrOpts?:
    | string
    | RegExp
    | ({
        name?: string | RegExp;
        exact?: boolean;
        level?: number;
        includeHidden?: boolean;
      } & SelectorModifiers<T>),
  opts?: { exact?: boolean; level?: number; includeHidden?: boolean } & SelectorModifiers<T>,
): ObjectSelector<T> {
  if (typeof nameOrOpts === "string" || nameOrOpts instanceof RegExp) {
    return { role, name: nameOrOpts, ...opts };
  }
  return { role, ...nameOrOpts };
}

/** Build a CSS selector (`locator(css)`), piercing Shadow DOM and same-origin iframes. */
export function byCss<T extends string = string>(
  css: string,
  opts?: SelectorModifiers<T>,
): ObjectSelector<T> {
  return { css, ...opts };
}

/** Find a form control by its associated `<label>`, `aria-labelledby`, or `aria-label` (Playwright `getByLabel`). */
export function byLabel<T extends string = string>(
  label: string | RegExp,
  opts?: { exact?: boolean } & SelectorModifiers<T>,
): ObjectSelector<T> {
  return { label, ...opts };
}

/** Find an input/textarea by its `placeholder` attribute (Playwright `getByPlaceholder`). */
export function byPlaceholder<T extends string = string>(
  placeholder: string | RegExp,
  opts?: { exact?: boolean } & SelectorModifiers<T>,
): ObjectSelector<T> {
  return { placeholder, ...opts };
}

/** Find an element by its `alt` attribute (Playwright `getByAltText`). */
export function byAltText<T extends string = string>(
  altText: string | RegExp,
  opts?: { exact?: boolean } & SelectorModifiers<T>,
): ObjectSelector<T> {
  return { altText, ...opts };
}

/** Find an element by its `title` attribute (Playwright `getByTitle`). */
export function byTitle<T extends string = string>(
  title: string | RegExp,
  opts?: { exact?: boolean } & SelectorModifiers<T>,
): ObjectSelector<T> {
  return { title, ...opts };
}

/** Match elements satisfying ALL of the provided selectors (Playwright `locatorA.and(locatorB)`). */
export function and<T extends string = string>(...selectors: Selector<T>[]): ObjectSelector<T> {
  const flat: Selector<T>[] = [];
  for (const s of selectors) {
    if (
      typeof s === "object" &&
      s !== null &&
      "allOf" in s &&
      Array.isArray(s.allOf) &&
      !("within" in s && s.within) &&
      !("frame" in s && s.frame) &&
      !("hasText" in s && s.hasText !== undefined) &&
      !("hasNotText" in s && s.hasNotText !== undefined) &&
      !("has" in s && s.has !== undefined) &&
      !("hasNot" in s && s.hasNot !== undefined) &&
      !("first" in s && s.first) &&
      !("last" in s && s.last) &&
      !("nth" in s && s.nth !== undefined)
    ) {
      flat.push(...s.allOf);
    } else {
      flat.push(s);
    }
  }
  return { allOf: flat };
}

/** Match elements satisfying ANY of the provided selectors (Playwright `locatorA.or(locatorB)`). */
export function or<T extends string = string>(...selectors: Selector<T>[]): ObjectSelector<T> {
  const flat: Selector<T>[] = [];
  for (const s of selectors) {
    if (
      typeof s === "object" &&
      s !== null &&
      "anyOf" in s &&
      Array.isArray(s.anyOf) &&
      !("within" in s && s.within) &&
      !("frame" in s && s.frame) &&
      !("hasText" in s && s.hasText !== undefined) &&
      !("hasNotText" in s && s.hasNotText !== undefined) &&
      !("has" in s && s.has !== undefined) &&
      !("hasNot" in s && s.hasNot !== undefined) &&
      !("first" in s && s.first) &&
      !("last" in s && s.last) &&
      !("nth" in s && s.nth !== undefined)
    ) {
      flat.push(...s.anyOf);
    } else {
      flat.push(s);
    }
  }
  return { anyOf: flat };
}

/** Scope `child` inside elements matching `parent` (`locator(parent).locator(child)`). */
export function within<T extends string = string>(
  parent: Selector<T>,
  child: Selector<T>,
): ObjectSelector<T> {
  const obj = toObjectSelector(child);
  if ("point" in obj) return obj;
  const chainedWithin = obj.within ? within(parent, obj.within) : parent;
  return { ...obj, within: chainedWithin };
}

/** Scope `child` inside an `<iframe>` matching `frame` (`frameLocator(frame).locator(child)`). */
export function inFrame<T extends string = string>(
  frame: Selector<T>,
  child: Selector<T>,
): ObjectSelector<T> {
  const obj = toObjectSelector(child);
  if ("point" in obj) return obj;
  return { ...obj, frame };
}

/** Narrow a selector to the 0-based `index`-th match (negative counts from the end). */
export function nth<T extends string = string>(sel: Selector<T>, index: number): ObjectSelector<T> {
  const obj = toObjectSelector(sel);
  if ("point" in obj) return obj;
  return { ...obj, nth: index, first: undefined, last: undefined };
}

/** Narrow a selector to its first match (`.first()`). */
export function first<T extends string = string>(sel: Selector<T>): ObjectSelector<T> {
  const obj = toObjectSelector(sel);
  if ("point" in obj) return obj;
  return { ...obj, first: true, last: undefined, nth: undefined };
}

/** Narrow a selector to its last match (`.last()`). */
export function last<T extends string = string>(sel: Selector<T>): ObjectSelector<T> {
  const obj = toObjectSelector(sel);
  if ("point" in obj) return obj;
  return { ...obj, last: true, first: undefined, nth: undefined };
}

/** Filter a selector's matches by text or descendant selector (`locator.filter({ hasText, hasNotText, has, hasNot })`). */
export function filterSelector<T extends string = string>(
  sel: Selector<T>,
  filter: {
    hasText?: string | RegExp;
    hasNotText?: string | RegExp;
    has?: Selector<NoInfer<T>>;
    hasNot?: Selector<NoInfer<T>>;
  },
): ObjectSelector<T> {
  const obj = toObjectSelector(sel);
  if ("point" in obj) return obj;
  return { ...obj, ...filter };
}

/**
 * Marks a label/text selector as targeting out-of-process system UI
 * (e.g. SFSafariViewController, ASWebAuthenticationSession, Chrome Custom Tabs,
 * OS permission alerts). Skips the DOM channel and suppresses brittle-text warnings.
 */
export function systemUI(
  selector: { text: string } | { accessibilityLabel: string },
): { text: string; systemUI: true } | { accessibilityLabel: string; systemUI: true } {
  return { ...selector, systemUI: true };
}

export function isSystemUISelector<T extends string = string>(sel: ExtendedSelector<T>): boolean {
  if (typeof sel !== "object" || sel === null) return false;
  if (isRelativeSelector(sel)) {
    return isSystemUISelector(sel.selector);
  }
  return "systemUI" in sel && sel.systemUI === true;
}

export function isTestIDSelector<T extends string = string>(
  sel: ExtendedSelector<T>,
): sel is { testID: T } {
  return typeof sel === "object" && sel !== null && "testID" in sel && !isRelativeSelector(sel);
}

/** True when a selector uses web/DOM-specific composition (role, css, anyOf, within, frame, nth, filter). */
export function isComposableDomSelector<T extends string = string>(
  sel: ExtendedSelector<T>,
): boolean {
  if (typeof sel !== "object" || sel === null || isRelativeSelector(sel)) return false;
  return (
    "role" in sel ||
    "css" in sel ||
    "label" in sel ||
    "placeholder" in sel ||
    "altText" in sel ||
    "title" in sel ||
    "anyOf" in sel ||
    "allOf" in sel ||
    "within" in sel ||
    "frame" in sel ||
    "hasText" in sel ||
    "hasNotText" in sel ||
    "has" in sel ||
    "hasNot" in sel ||
    "nth" in sel ||
    "first" in sel ||
    "last" in sel
  );
}
