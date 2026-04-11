import { Schema } from "effect";

export type Platform = "android" | "ios" | "web";

// Runtime schema definitions — used for Schema.decode / .parse on config-time
// selector payloads. The TypeScript types below are generic over a testID
// string union `T` so projects can pass a typed set of testIDs and get
// autocomplete + misspelling protection at the call site.
const _TestIDSelectorSchema = Schema.Struct({ testID: Schema.String });
const _TextSelectorSchema = Schema.Struct({ text: Schema.String });
const _AccessibilityLabelSelectorSchema = Schema.Struct({ accessibilityLabel: Schema.String });
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
 */
export type Selector<T extends string = string> =
  | T
  | { testID: T }
  | { text: string }
  | { accessibilityLabel: string }
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
