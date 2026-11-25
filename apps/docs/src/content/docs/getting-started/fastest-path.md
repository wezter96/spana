---
title: Run it the fastest way
description: The order to try Spana's run modes in, fastest first, and when to fall back to a slower one.
---

Spana can run the same tests in several ways. Use the first option that fits your case. Fall back
to the next one only when the "Does not apply when" column matches you.

## Running a test suite

| #   | Use this                                                 | How                                                                                                                  | Does not apply when                                                                                                     |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | `spana test` with `.flow.ts` or Gherkin `.feature` files | `npx spana test`                                                                                                     | Your team needs [Varar](/writing-tests/varar/) Markdown specs. They run in Vitest, so options 2–6 do not apply.         |
| 2   | Only the flows a change can affect                       | Local: `spana test --changed` or `--last-failed`. CI: `--changed-since origin/main` **and** a `filters` list         | No `filters` in `spana.config.ts`: then `--changed-since` runs every flow. A config or lockfile change runs every flow. |
| 3   | Web: shared browser pool                                 | `spana test --platform web --workers 4` (or `defaults.workers: 4`)                                                   | `engine: "lightpanda"` (one worker only). `--parallel` without `--workers` uses one worker.                             |
| 4   | Hybrid, Electron or Electrobun: spana-bridge             | `execution.bridge.enabled: true` in config, and call `initSpanaBridge()` from `spana-bridge` in the app's test build | You cannot change the app. Pure native React Native screens (no WebView DOM). Multi-worker web runs (use #3).           |
| 5   | Skip UI sign-in                                          | Web: `execution.web.storageState: "./auth/user.json"`                                                                | Not web. On mobile and desktop, use the bridge (#4) to inject sign-in state.                                            |
| 6   | Keep drivers warm between runs                           | Web: `execution.web.warmBrowser: true` (Chromium only). Mobile: `execution.warmDaemons.enabled: true`                | Not Chromium. `cdpUrl` or `wsEndpoint` is set.                                                                          |
| 7   | Local devices, cold start                                | `spana test --platform android,ios`                                                                                  | You need real devices you do not have locally.                                                                          |
| 8   | Appium server or device cloud (slowest)                  | `--driver appium --appium-url <url>`, or [BrowserStack / Sauce Labs](/guides/cloud-providers/)                       | —                                                                                                                       |

Example CI command that combines #2 and #3:

```bash
spana test --platform web --workers 4 --changed-since origin/main
```

The [CI/CD guide](/guides/ci-integration/) shows the `filters` config that `--changed-since`
needs.

## Coding agents: exploring a screen and writing tests

| #   | Use this                                               | Why                                                                                     | Does not apply when                                                                  |
| --- | ------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | `spana mcp`                                            | One live session for all tool calls. The agent does not start a new browser each time.  | Your agent has no MCP support.                                                       |
| 2   | `spana selectors`, `spana hierarchy`, `spana validate` | Plain CLI. Works in any agent.                                                          | You call them many times in a row: each call starts a new browser or driver session. |
| 3   | `connect()` from `spana-test/agent`                    | Custom scripts, or other test runners such as [Varar](/writing-tests/varar/) in Vitest. | You want speed: no shared pool, no warm browser, no bridge.                          |

When the agent has a working flow, save it as a `.flow.ts` file and run it with `spana test`
(suite option #1).
