---
title: Debugging
description: Debug failing tests interactively with the built-in REPL.
---

When a test fails, spana can drop you into an interactive REPL connected to the live device session. This lets you inspect the screen, try selectors, and experiment with actions before the session is torn down.

## Enabling the debug REPL

```bash
spana test --debug-on-failure
```

When a flow fails, instead of moving to the next flow, spana pauses and opens a REPL:

```
Entering debug REPL for failed flow "login flow" on android.
Available bindings: app, expect, driver, platform, flowName, error, hierarchy(), selectors(), help()
Use top-level await for async calls, for example: await app.tap({ text: "Login" })

spana:android>
```

## Available bindings

| Binding       | Type     | Description                                          |
| ------------- | -------- | ---------------------------------------------------- |
| `app`         | object   | Full `PromiseApp` API -- tap, inputText, scroll, etc |
| `expect`      | function | Assertion helper, same as in flows                   |
| `driver`      | object   | Raw driver service for low-level access              |
| `platform`    | string   | Current platform (`"web"`, `"android"`, `"ios"`)     |
| `flowName`    | string   | Name of the failed flow                              |
| `error`       | Error    | The error that caused the failure                    |
| `hierarchy()` | async    | Returns the parsed UI element tree                   |
| `selectors()` | async    | Returns suggested selectors for visible elements     |
| `help()`      | function | Print all available bindings                         |

## Example session

```
spana:android> error.message
'Timed out waiting for selector { testID: "welcome-text" }'

spana:android> await selectors()
[
  { suggestedSelector: { testID: 'login-button' }, elementType: 'Button', text: 'Sign In' },
  { suggestedSelector: { text: 'Welcome' }, elementType: 'Text', text: 'Welcome' },
  ...
]

spana:android> await app.tap({ text: "Sign In" })
undefined

spana:android> await expect({ testID: "welcome-text" }).toBeVisible()
undefined

spana:android> .exit
```

## Tips

- Use `await selectors()` to discover what's on screen -- this is the fastest way to find the right selector
- Use `await hierarchy()` for the full element tree with bounds, visibility, and nesting
- All `app` methods use auto-wait, so `await app.tap(...)` will retry until the element appears
- The REPL only activates once per test run (the first failure) to avoid blocking CI
- The REPL requires an interactive terminal (TTY) -- it's skipped automatically in CI environments
- Type `.exit` or press `Ctrl+D` to leave the REPL and continue the test run

## Visual Playback & Video Recording

Enable visual playback or video recording in `spana.config.ts` so anyone can visually scrub through every step in `report.html` (Play/Pause, 0.5×/1×/2× speed, timeline scrubber, red click-ripple indicator, synchronized step list, and embedded `<video>`):

```ts
export default defineConfig({
  artifacts: {
    playback: true, // Interactive timeline player in report.html
    video: "retain-on-failure", // "off" | "on" | "retain-on-failure" (CDP screencast + mp4 / adb / simctl)
  },
  reporters: ["console", "html"],
});
```

## Common Pitfalls Spana Protects Against & How to Fix Your App

Spana catches both test flakiness and real application bugs. When a test fails, fix the root cause rather than adding `sleep()` calls:

| Pitfall                                             | How Spana protects you automatically                                                                                                                                  | Recommended fix in your app or config                                                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hydration / loading overlay swallows clicks**     | Single-RTT in-page actionability verifies the target is visible, enabled, unobstructed via deep `elementFromPoint`, and stable for 2 animation frames before tapping. | Expose `window.__SPANA_APP_READY__ = true` once your SPA finishes initial hydration/auth boot; Spana automatically waits for it before interacting. |
| **Stale async fetches clobber UI state**            | Fast Direct CDP interactions can expose out-of-order `fetch()` responses when users switch tabs or type rapidly.                                                      | Guard async UI updates with an `AbortController` or monotonic request sequence ID (`if (seq !== latestSeq) return`) in your app components.         |
| **Missing or brittle selectors**                    | Failure bundles list the exact attempted selector plus nearby visible alternatives.                                                                                   | Add stable `data-testid` / `testID` attributes to interactive elements instead of matching localized copy or fragile CSS paths.                     |
| **Cross-origin `<iframe>` (Stripe, OAuth)**         | Direct CDP auto-attaches to out-of-process iframes (`Target.setAutoAttach`) and translates element coordinates into top-level viewport space.                         | Ensure elements inside your own embedded frames expose `data-testid` or accessible labels.                                                          |
| **Flaky animations & layout shift**                 | 2-rAF stability check waits for moving buttons to settle before clicking.                                                                                             | Enable `execution.web.instantAnimations: true` in `spana.config.ts` to collapse CSS transitions to 0.001 ms during E2E runs.                        |
| **Accessibility regressions**                       | `await expect().toPassAccessibilityAudit()` (and `spana_assert_accessible` in MCP) runs `axe-core` and reports WCAG rules, severity, and offending nodes.             | Fix missing `aria-label`, heading order, color contrast, and form `<label>` associations directly in the component rather than disabling rules.     |
| **Visual diff noise from timestamps/avatars**       | Rust-accelerated `toMatchScreenshot()` supports `layout-tolerant` mode and dynamic region masks.                                                                      | Pass `{ mask: [{ testID: "live-clock" }], mode: "layout-tolerant" }` or freeze clock/seed data in your fixture.                                     |
| **Slow repeated UI login & cross-test state leaks** | `freshContextPerFlow: true` isolates cookies/storage per flow while pre-warming the next context in the background.                                                   | Use `definePersona()` + `PersonaAuthCache` or `createApiFixture()` to seed state via API instead of clicking through login in every test.           |
