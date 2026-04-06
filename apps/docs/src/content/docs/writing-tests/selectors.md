---
title: Selectors
description: All selector types, how to use them, and how they map across platforms.
---

A selector tells spana which element to interact with or assert on. Selectors are used by all `app` interaction methods and `expect()`.

## Selector types

### testID (recommended)

```ts
{
  testID: "login-button";
}
```

The preferred selector. Maps to the platform's primary element identifier:

| Platform | Attribute                            |
| -------- | ------------------------------------ |
| Web      | `data-testid` attribute              |
| Android  | `resource-id` (last segment matched) |
| iOS      | `accessibilityIdentifier`            |

Add `testID` props to your React Native components:

```tsx
<Pressable testID="login-button">Sign In</Pressable>
```

On web, this renders as `data-testid="login-button"`.

### text

```ts
{
  text: "Sign In";
}
```

Matches against the visible label text of an element. Partial matching is supported — the element text only needs to contain the provided string.

Use this when a `testID` is not available, such as for dynamic or third-party content.

### accessibilityLabel

```ts
{
  accessibilityLabel: "Close dialog";
}
```

Matches the OS-level accessibility label. Useful for elements that have a label distinct from their visible text (e.g. icon buttons).

### point

```ts
{ point: { x: 150, y: 340 } }
```

Taps at absolute screen coordinates. Use as a last resort — coordinates are device-specific and break across screen sizes.

### String shorthand

A plain string is treated as a `testID`:

```ts
await app.tap("login-button");
// equivalent to:
await app.tap({ testID: "login-button" });
```

## Relative selectors

When multiple elements match the same selector, use relative positioning to disambiguate. A relative selector wraps a base selector with directional constraints:

```ts
// Tap the "Edit" button below the "Email" label
await app.tap({ selector: { text: "Edit" }, below: { text: "Email" } });

// Tap the button to the right of the "Username" label
await app.tap({ selector: { testID: "action-btn" }, rightOf: { text: "Username" } });

// Find an element inside a specific container
await app.tap({ selector: { text: "Submit" }, childOf: { testID: "login-form" } });
```

| Constraint | Description                                         |
| ---------- | --------------------------------------------------- |
| `below`    | Element must be below the anchor (closest first)    |
| `above`    | Element must be above the anchor (closest first)    |
| `leftOf`   | Element must be left of the anchor (closest first)  |
| `rightOf`  | Element must be right of the anchor (closest first) |
| `childOf`  | Element must be a descendant of the anchor          |

Constraints can be combined — all must match:

```ts
// Button below the header AND to the right of the label
await app.tap({
  selector: { testID: "btn" },
  below: { text: "Header" },
  rightOf: { text: "Label" },
});
```

Relative selectors work with all interaction methods (`tap`, `doubleTap`, `longPress`) and assertions (`expect().toBeVisible()`, etc.).

## Selector priority

When spana builds a suggested selector (e.g. in `spana selectors` output), it uses this priority:

1. `testID` — most stable, preferred
2. `accessibilityLabel`
3. `text`
4. `point` — last resort

## WaitOptions

All selector-based methods accept an optional `WaitOptions` object to override the global defaults for that specific call:

```ts
await app.tap({ testID: "slow-element" }, { timeout: 10000 });
await expect({ testID: "result" }).toBeVisible({ timeout: 15000, pollInterval: 500 });
```

| Option          | Type     | Description                                   |
| --------------- | -------- | --------------------------------------------- |
| `timeout`       | `number` | ms to wait before failing                     |
| `pollInterval`  | `number` | ms between hierarchy polls                    |
| `settleTimeout` | `number` | ms the element must be stable before matching |
