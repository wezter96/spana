---
title: Run it the fastest way
description: The order to try Spana's run modes in, fastest first, and when to fall back to a slower one.
---

Spana can run the same tests in several ways. Use the first option that fits your case. Fall back
to the next one only when the "Does not apply when" column matches you.

## Running a test suite

| #   | Use this                                                 | How                                                                                                                  | Does not apply when                                                                                                                          |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `spana test` with `.flow.ts` or Gherkin `.feature` files | `npx spana test`                                                                                                     | Your team needs [Varar](/writing-tests/varar/) Markdown specs. They run in Vitest, so options 2–6 do not apply.                              |
| 2   | Only the flows a change can affect                       | Local: `spana test --changed` or `--last-failed`. CI: `--changed-since origin/main` **and** a `filters` list         | No `filters` in `spana.config.ts`: then `--changed-since` runs every flow. A config or lockfile change runs every flow.                      |
| 3   | Web: shared browser pool                                 | `spana test --platform web --workers 4` (or `defaults.workers: 4`). Flows reuse warm browser contexts.               | Flows must not share any browser state: use #3b. `engine: "lightpanda"` (one worker only). `--parallel` without `--workers` uses one worker. |
| 3b  | Web, fully isolated flows                                | `execution.web.engine: "auto"` (direct CDP for Chromium) plus `execution.web.freshContextPerFlow: true`              | You need `wsEndpoint`, a browser `channel`, HAR artifacts or a non-Chromium browser: `"auto"` then falls back to Playwright.                 |
| 4   | Hybrid, Electron or Electrobun: spana-bridge             | `execution.bridge.enabled: true` in config, and call `initSpanaBridge()` from `spana-bridge` in the app's test build | You cannot change the app. Pure native React Native screens (no WebView DOM). Multi-worker web runs (use #3).                                |
| 5   | Skip UI sign-in                                          | Web: `execution.web.storageState: "./auth/user.json"`                                                                | Not web. On mobile and desktop, use the bridge (#4) to inject sign-in state.                                                                 |
| 6   | Keep drivers warm between runs                           | Web: `execution.web.warmBrowser: true` (Chromium only). Mobile: `execution.warmDaemons.enabled: true`                | Not Chromium. `cdpUrl` or `wsEndpoint` is set.                                                                                               |
| 7   | Local devices, cold start                                | `spana test --platform android,ios`                                                                                  | You need real devices you do not have locally.                                                                                               |
| 8   | Appium server or device cloud (slowest)                  | `--driver appium --appium-url <url>`, or [BrowserStack / Sauce Labs](/guides/cloud-providers/)                       | —                                                                                                                                            |

Measured on the 20-flow web benchmark: shared pool with 4 workers 3.04 s, bridge with 1 worker
3.92 s, direct CDP with a fresh context per flow and 4 workers 7.66 s, Playwright with 4 workers
10.74 s. See the [comparison page](/compare/) for the method.

Example CI command that combines #2 and #3:

```bash
spana test --platform web --workers 4 --changed-since origin/main
```

The [CI/CD guide](/guides/ci-integration/) shows the `filters` config that `--changed-since`
needs.

## Tuning options

These options make each flow faster. Each one is safe to turn on unless your tests check the thing
it turns off.

| Option                                                     | What it does                                                                                          | Leave it off when                                     |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `execution.web.instantAnimations: true`                    | Sets CSS transitions and animations to almost zero time.                                              | You test animations.                                  |
| `execution.web.blockResources: ["image", "font", "media"]` | Stops heavy downloads during web runs.                                                                | You test images, fonts, media or visual snapshots.    |
| `execution.web.waitUntil: "domcontentloaded"`              | Continues as soon as the HTML is parsed, not after every asset loads (default `"load"`).              | Your app needs all assets before it can respond.      |
| `defaults.failFastWhenIdle: true`                          | Fails a web element wait early when the page is idle and loaded, instead of waiting the full timeout. | Elements appear late without network or DOM activity. |
| `defaults.tapMode: "dom"`                                  | Taps found in the DOM use a synthetic click instead of a real native touch.                           | You need real touch events (gestures, native sheets). |
| `execution.web.maxContextsPerBrowser`                      | Contexts that share one browser process under parallel runs (default 1 with `engine: "cdp"`, else 2). | —                                                     |

In your app, set `window.__SPANA_APP_READY__ = false` at start and `true` when the app is ready
(a function that returns a boolean also works). When this value is defined, Spana waits for it
before each DOM action, instead of acting on a loading screen. See [Debugging](/guides/debugging/).

## Coding agents: exploring a screen and writing tests

| #   | Use this                                               | Why                                                                                     | Does not apply when                                                                  |
| --- | ------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | `spana mcp`                                            | One live session for all tool calls. The agent does not start a new browser each time.  | Your agent has no MCP support.                                                       |
| 2   | `spana selectors`, `spana hierarchy`, `spana validate` | Plain CLI. Works in any agent.                                                          | You call them many times in a row: each call starts a new browser or driver session. |
| 3   | `connect()` from `spana-test/agent`                    | Custom scripts, or other test runners such as [Varar](/writing-tests/varar/) in Vitest. | You want speed: no shared pool, no warm browser, no bridge.                          |

When the agent has a working flow, save it as a `.flow.ts` file and run it with `spana test`
(suite option #1).
