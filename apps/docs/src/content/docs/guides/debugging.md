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
- The REPL requires an interactive terminal (TTY on both stdin and stdout) -- it's skipped automatically when there is none, as in most CI environments
- Type `.exit` or press `Ctrl+D` to leave the REPL and continue the test run

## Failure artifacts and `--verbose`

Every failed flow writes artifacts to `spana-output/<flow>-<platform>/` (by default `artifacts.captureOnFailure` is on): a screenshot, `hierarchy.json`, and `failure-bundle.json` with the failing selector and nearby alternatives. Web runs also capture console logs and JS errors (`artifacts.consoleLogs` / `artifacts.jsErrors`, on by default).

Pass `--verbose` to print the failure category, message, suggestion, diagnostic sections, and stack trace in the terminal:

```bash
spana test --verbose
```

## Visual Playback & Video Recording

Enable visual playback or video recording in `spana.config.ts` so anyone can visually scrub through every step in `report.html` (Play/Pause, 0.5×/1×/2× speed, timeline scrubber, red click-ripple indicator, synchronized step list, and embedded `<video>`). Both are off by default:

```ts
export default defineConfig({
  artifacts: {
    playback: true, // Interactive timeline player in report.html
    video: "retain-on-failure", // "off" (default) | "on" | "retain-on-failure"
  },
  reporters: ["console", "html"],
});
```

How video is captured depends on the target:

- **Web** -- CDP screencast (`Page.startScreencast`). This needs the direct CDP engine (`execution.web.engine: "cdp"`, or `"auto"` when it resolves to `cdp`). The frames are muxed to `.mp4` only when `ffmpeg` is on `PATH`.
- **Android** -- `adb shell screenrecord`.
- **iOS Simulator** -- `xcrun simctl io <udid> recordVideo`.

Where no screencast is available (for example the `playwright` web engine), `playback: true` builds the timeline from step screenshots, so also set `artifacts.captureSteps: true`.

## Common Pitfalls Spana Protects Against & How to Fix Your App

Spana catches both test flakiness and real application bugs. When a test fails, fix the root cause rather than adding `sleep()` calls:

| Pitfall                                             | How Spana protects you automatically                                                                                                                                                               | Recommended fix in your app or config                                                                                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hydration / loading overlay swallows clicks**     | Single-RTT in-page actionability verifies the target is visible, enabled, unobstructed via deep `elementFromPoint`, and stable for 2 animation frames before tapping.                              | Expose `window.__SPANA_APP_READY__ = true` once your SPA finishes initial hydration/auth boot; Spana automatically waits for it before interacting.                        |
| **Stale async fetches clobber UI state**            | Fast Direct CDP interactions can expose out-of-order `fetch()` responses when users switch tabs or type rapidly.                                                                                   | Guard async UI updates with an `AbortController` or monotonic request sequence ID (`if (seq !== latestSeq) return`) in your app components.                                |
| **Missing or brittle selectors**                    | Failure bundles list the exact attempted selector plus nearby visible alternatives.                                                                                                                | Add stable `data-testid` / `testID` attributes to interactive elements instead of matching localized copy or fragile CSS paths.                                            |
| **Cross-origin `<iframe>` (Stripe, OAuth)**         | With the direct CDP engine (`engine: "cdp"` or `"auto"`), Spana auto-attaches to out-of-process iframes (`Target.setAutoAttach`) and translates element coordinates into top-level viewport space. | Ensure elements inside your own embedded frames expose `data-testid` or accessible labels.                                                                                 |
| **Flaky animations & layout shift**                 | 2-rAF stability check waits for moving buttons to settle before clicking.                                                                                                                          | Enable `execution.web.instantAnimations: true` in `spana.config.ts` to collapse CSS transitions to 0.001 ms during E2E runs.                                               |
| **Accessibility regressions**                       | `await expect().toPassAccessibilityAudit()` (and `spana_assert_accessible` in MCP) runs `axe-core` and reports WCAG rules, severity, and offending nodes.                                          | Fix missing `aria-label`, heading order, color contrast, and form `<label>` associations directly in the component rather than disabling rules.                            |
| **Visual diff noise from timestamps/avatars**       | `toMatchScreenshot()` (Rust-accelerated when the native library is available) supports dynamic region masks and a `layout-tolerant` compare mode.                                                  | Pass `{ mask: [{ testID: "live-clock" }] }` to `toMatchScreenshot()`, set `visualRegression.mode: "layout-tolerant"` in config, or freeze clock/seed data in your fixture. |
| **Slow repeated UI login & cross-test state leaks** | `freshContextPerFlow: true` isolates cookies/storage per flow while pre-warming the next context in the background.                                                                                | Use `definePersona()` + `PersonaAuthCache` or `createApiFixture()` to seed state via API instead of clicking through login in every test.                                  |
