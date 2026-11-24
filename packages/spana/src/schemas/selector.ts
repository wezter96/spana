import { Schema } from "effect";

export type Platform = "android" | "ios" | "web" | "electron" | "electrobun";

export type TapMode = "native" | "dom";

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
const _PointSelectorSchema = Schema.Struct({
  point: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
});

export const SelectorSchema = Schema.Union(
  Schema.String,
  _TestIDSelectorSchema,
  _TextSelectorSchema,
  _AccessibilityLabelSelectorSchema,
  _PointSelectorSchema,
);

/**
 * Selector types. Generic parameter `T` lets projects pin a union of known
 * testIDs so `{ testID: "bogus-id" }` becomes a type error.
 *
 * Use `systemUI: true` (or the `systemUI(...)` helper) on `{ text }` /
 * `{ accessibilityLabel }` selectors that intentionally target out-of-process
 * OS UI (SFSafariViewController, ASWebAuthenticationSession, Chrome Custom Tabs,
 * permission dialogs) where DOM `data-testid` cannot reach.
 */
export type Selector<T extends string = string> =
  | T
  | { testID: T }
  | { text: string; systemUI?: boolean }
  | { accessibilityLabel: string; systemUI?: boolean }
  | { point: { x: number; y: number } };

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
