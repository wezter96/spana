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

| Platform | Attribute                             |
| -------- | ------------------------------------- |
| Web      | `data-testid` (or `testID`) attribute |
| Android  | `resource-id` (last segment matched)  |
| iOS      | `accessibilityIdentifier`             |

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

Matches against the visible label text of an element. Matching is a case-insensitive substring match — the element text only needs to contain the provided string.

Use this when a `testID` is not available, such as for dynamic or third-party content.

### accessibilityLabel

```ts
{
  accessibilityLabel: "Close dialog";
}
```

Matches the OS-level accessibility label exactly (on web, the `aria-label` attribute). Useful for elements that have a label distinct from their visible text (e.g. icon buttons).

### System UI

```ts
import { systemUI } from "spana-test";

await app.tap(systemUI({ text: "Allow" }));
// equivalent to:
await app.tap({ text: "Allow", systemUI: true });
```

Add `systemUI: true` to a `text` or `accessibilityLabel` selector when it targets out-of-process OS UI, such as permission dialogs, `SFSafariViewController`, `ASWebAuthenticationSession`, or Chrome Custom Tabs. spana then skips the DOM channel and uses the native driver.

### point

```ts
{ point: { x: 150, y: 340 } }
```

Taps at absolute screen coordinates. Use as a last resort — coordinates are device-specific and break across screen sizes.

### String shorthand

A plain string is treated as a `text` selector (case-insensitive substring match), not as a `testID`:

```ts
await app.tap("Sign In");
// matches the same elements as:
await app.tap({ text: "Sign In" });
```

Use `{ testID: "..." }` explicitly when you mean a test ID.

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

Relative selectors work with the selector-based interaction methods (`tap`, `doubleTap`, `longPress`, etc.) and assertions (`expect().toBeVisible()`, etc.).

## Selector priority

When spana builds a suggested selector (e.g. in `spana selectors` output), it uses this priority:

1. `testID` — most stable, preferred
2. `accessibilityLabel`
3. `text`

## WaitOptions

All selector-based methods accept an optional `WaitOptions` object to override the global defaults for that specific call:

```ts
await app.tap({ testID: "slow-element" }, { timeout: 10000 });
await expect({ testID: "result" }).toBeVisible({ timeout: 15000, pollInterval: 500 });
```

| Option                | Type                | Description                                                                  |
| --------------------- | ------------------- | ---------------------------------------------------------------------------- |
| `timeout`             | `number`            | ms to wait before failing                                                    |
| `pollInterval`        | `number`            | ms between hierarchy polls                                                   |
| `settleTimeout`       | `number`            | ms the element must be stable before matching                                |
| `initialPollInterval` | `number`            | first poll interval before adaptive backoff                                  |
| `tapMode`             | `"native" \| "dom"` | for taps resolved via a DOM channel: real touch or synthetic click           |
| `failFastWhenIdle`    | `boolean`           | on web, fail early when the page is idle instead of waiting the full timeout |
