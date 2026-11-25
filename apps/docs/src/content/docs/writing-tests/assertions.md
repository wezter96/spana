---
title: Assertions
description: The full expect() API, including text/state checks, screenshots, accessibility, and auto-wait behavior.
---

Assertions are made with the `expect` function from `FlowContext`. It takes a selector and returns a `PromiseExpectation` with chainable assertion methods.

```ts
const { expect } = ctx;

await expect({ testID: "welcome-banner" }).toBeVisible();
```

## API

### `expect(selector)`

```ts
expect: (selector: ExtendedSelector) => PromiseExpectation;
```

Returns a `PromiseExpectation` bound to the given selector. Any [selector](/writing-tests/selectors/), including relative selectors, works here.

### Core visibility, text, and state assertions

| Method            | Signature                                                             | Description                                        |
| ----------------- | --------------------------------------------------------------------- | -------------------------------------------------- |
| `toBeVisible`     | `(opts?: WaitOptions) => Promise<void>`                               | Assert that the element exists and is visible      |
| `toBeHidden`      | `(opts?: WaitOptions) => Promise<void>`                               | Assert that the element is missing or hidden       |
| `toHaveText`      | `(expected: string, opts?: WaitOptions) => Promise<void>`             | Assert an exact text match                         |
| `toContainText`   | `(expected: string, opts?: WaitOptions) => Promise<void>`             | Assert a case-insensitive substring match          |
| `toMatchText`     | `(pattern: RegExp, opts?: WaitOptions) => Promise<void>`              | Assert a regular-expression text match             |
| `toHaveValue`     | `(expected: string \| number, opts?: WaitOptions) => Promise<void>`   | Assert an exact form value match                   |
| `toHaveAttribute` | `(name: string, value?: string, opts?: WaitOptions) => Promise<void>` | Assert that an attribute exists or matches a value |
| `toBeEnabled`     | `(opts?: WaitOptions) => Promise<void>`                               | Assert that the element is enabled                 |
| `toBeDisabled`    | `(opts?: WaitOptions) => Promise<void>`                               | Assert that the element is disabled                |

```ts
await expect({ testID: "success-message" }).toBeVisible();
await expect({ text: "Welcome" }).toBeVisible({ timeout: 8000 });
await expect({ testID: "user-greeting" }).toHaveText("Hello, Alice");
await expect({ testID: "status" }).toContainText("saved");
await expect({ testID: "price" }).toMatchText(/^\$\d+\.\d{2}$/);
await expect({ testID: "email" }).toHaveValue("demo@example.com");
await expect({ testID: "primary-button" }).toHaveAttribute("aria-busy", "false");
await expect({ testID: "submit" }).toBeEnabled();
```

Use `toHaveText()` for exact text, `toContainText()` for partial copy, and `toMatchText()` when you need more flexible matching.

### Visual regression

```ts
toMatchScreenshot(
  name: string,
  options?: {
    threshold?: number;
    maxDiffPixelRatio?: number;
  },
): Promise<void>
```

Capture the current element and compare it against a named baseline image. When no baseline exists yet, spana writes the current screenshot as the baseline and the assertion passes.

```ts
await expect({ testID: "avatar" }).toMatchScreenshot("profile-avatar");
await expect({ testID: "receipt" }).toMatchScreenshot("receipt", {
  threshold: 0.2,
  maxDiffPixelRatio: 0.01,
});
```

Create or refresh baselines with `spana test --update-baselines`. For suite-wide defaults, configure `visualRegression` in `spana.config.ts`.

### Accessibility assertions

| Method                     | Signature                                                                                                                              | Description                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `toPassAccessibilityAudit` | `(options?: { severity?: "critical" \| "serious" \| "moderate" \| "minor"; rules?: string[]; exclude?: Selector[] }) => Promise<void>` | Run an axe-core audit of the current web page                                     |
| `toHaveAccessibilityLabel` | `(expected?: string) => Promise<void>`                                                                                                 | Assert that an element has an accessibility label, optionally with an exact value |
| `toBeFocusable`            | `() => Promise<void>`                                                                                                                  | Assert that the element can receive focus                                         |
| `toHaveRole`               | `(expected: string) => Promise<void>`                                                                                                  | Assert a semantic role such as `button` or `link`                                 |
| `toHaveMinTouchTarget`     | `(size?: number) => Promise<void>`                                                                                                     | Assert a minimum touch target size, default `44`                                  |

```ts
await expect("body").toPassAccessibilityAudit({
  severity: "serious",
  rules: ["color-contrast", "button-name"],
});

await expect({ testID: "login-button" }).toHaveAccessibilityLabel("Log in");
await expect({ testID: "login-button" }).toHaveRole("button");
await expect({ testID: "login-button" }).toBeFocusable();
await expect({ testID: "login-button" }).toHaveMinTouchTarget(48);
```

`toPassAccessibilityAudit()` is web-only. The other accessibility assertions are element-level checks that work across supported platforms.

## Auto-wait behavior

All assertions auto-wait. spana does not require manual `sleep()` calls.

On web, when the DOM channel is connected, spana first waits inside the page with a `MutationObserver`, so most assertions resolve in a single round trip. Otherwise (native screens, relative selectors, `systemUI` selectors) it uses this loop:

1. Dump the element hierarchy from the platform driver.
2. Search the tree for the selector.
3. Check the assertion condition.
4. If the condition is not met, wait and retry using adaptive polling.
5. If `timeout` is exceeded, fail with a descriptive error including the selector and last known state.

`WaitOptions` lets you tune assertion behavior:

```ts
type WaitOptions = {
  timeout?: number;
  pollInterval?: number;
  initialPollInterval?: number;
  settleTimeout?: number;
};
```

- `timeout`: maximum time to wait before failing
- `pollInterval`: maximum poll interval once backoff ramps up
- `initialPollInterval`: first poll interval before backoff grows
- `settleTimeout`: how long the element must remain present before the lookup passes

`initialPollInterval` and `settleTimeout` apply to element lookups (`toBeVisible()` and actions). Text, value, attribute, and state assertions poll at a fixed `pollInterval` and ignore them.

`settleTimeout` is useful for transitions and animations where the element briefly appears and disappears.

## Timeout configuration

Timeouts are resolved in this order (highest priority first):

1. `opts.timeout` passed directly to the assertion method
2. `flow(..., { defaults: { waitTimeout } })` on the containing flow
3. `defaults.waitTimeout` in `spana.config.ts`
4. Built-in default: 5000 ms

```ts
// Global default in config
export default defineConfig({
  defaults: { waitTimeout: 8000 },
});

// Per-flow override for waits and polling
export default flow(
  "slow screen test",
  {
    defaults: {
      waitTimeout: 12000,
      pollInterval: 250,
      settleTimeout: 300,
    },
  },
  async ({ expect }) => {
    // Per-assertion override
    await expect({ testID: "result" }).toBeVisible({ timeout: 15000 });
  },
);
```

`FlowConfig.timeout` is a separate overall flow timeout. It does not replace assertion wait settings.
