import { Schema } from "effect";

export const Bounds = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type Bounds = typeof Bounds.Type;

export const Element = Schema.Struct({
  id: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  textContent: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
  accessibilityLabel: Schema.optional(Schema.String),
  accessibleDescription: Schema.optional(Schema.String),
  resourceId: Schema.optional(Schema.String),
  elementType: Schema.optional(Schema.String),
  bounds: Bounds,
  enabled: Schema.optional(Schema.Boolean),
  visible: Schema.optional(Schema.Boolean),
  clickable: Schema.optional(Schema.Boolean),
  focused: Schema.optional(Schema.Boolean),
  checked: Schema.optional(Schema.Boolean),
  editable: Schema.optional(Schema.Boolean),
  empty: Schema.optional(Schema.Boolean),
  className: Schema.optional(Schema.String),
  attributes: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  children: Schema.optional(Schema.Array(Schema.suspend((): Schema.Schema<any> => Element))),
});
export type Element = typeof Element.Type;

export const ViewHierarchy = Schema.Struct({
  root: Element,
  timestamp: Schema.Number,
});
export type ViewHierarchy = typeof ViewHierarchy.Type;
