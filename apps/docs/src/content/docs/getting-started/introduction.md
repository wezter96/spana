---
title: Introduction
description: What spana is, why it exists, its dual-channel web-first engine, and its core principles.
---

**spana** (`spana-test`) is a web-first, TypeScript-native end-to-end testing framework across **Web, Android (Capacitor/WebView & React Native), iOS (WKWebView & React Native), Electron, and Electrobun** — one `{ testID }` selector model, zero Appium required locally.

## Why spana

Existing E2E tools force a painful split:

- **Web-only tools** (Playwright, Cypress) are fast on desktop browsers but cannot drive native mobile WebViews, OS sheets (`SFSafariViewController`, Chrome Custom Tabs, permission dialogs), or native mobile gestures.
- **Mobile-first runners** (Appium/WebdriverIO, Maestro) add heavy middleware, JVM/YAML layers, or brittle full-tree XML dumps on every single tap.

Spana bridges both worlds with a **Dual-Channel Web-First Engine**:

1. **Fast DOM Lane:** `{ testID }` queries pierce Shadow DOM and same-origin `<iframe>`s via the built-in Playwright DOM channel, the direct CDP engine (`execution.web.engine: "cdp"` or `"auto"`), `spana-bridge`, Android CDP, Lightpanda CDP, iOS WebKit Inspector, or Apple `webinspectord`, paired with `MutationObserver` reactive waits.
2. **Native & System UI Lane:** Real OS touches and out-of-process native sheets (`systemUI()`) go directly to persistent warm UiAutomator2 / WebDriverAgent daemons (with session reuse) — or to BrowserStack / Sauce Labs in Appium cloud mode.

## Key principles

- **Pure TypeScript (plus optional Gherkin / BDD).** Full autocomplete, imports, composable lazy fixtures (`createFlowWithFixtures`), and named setups (`defineSetup`). Works with both Bun and Node.js 20+.
- **Zero-setup fast path, opt-in superpowers.** Works with zero app modification out of the box, and supports an opt-in `spana-bridge` WebSocket package for instant storage injection, fast reset, network mocking, and lazy idle detection across hybrid mobile and desktop shells.
- **Agent-native from day one.** Ships a model-free stdio MCP server (`spana mcp`), a Verified Replay Cache for agentic steps (`.spana/cache/`), pluggable CI Filters (`filters` + `--changed-since`, including an optional LLM decision judge), and versioned `--json` envelopes on agent-facing commands.
- **Engineered for raw speed.** Speculative CLI browser pre-launch, an opt-in direct CDP web engine (no Playwright pipe), persistent warm Chromium/WDA/UA2 daemons, multi-context browser worker pools, `app.fill()` one-call form fills, `MutationObserver` reactive waits + optional `failFastWhenIdle`, `instantAnimations`, `blockResources`, and auto-persisted longest-first `--parallel` scheduling.

## Platform support

| Platform      | Driver / DOM Channel                                                                  | Notes                                                      |
| ------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Web / RN Web  | Playwright (default), direct CDP (`engine: "cdp"` / `"auto"`), or Lightpanda          | Also supports `wsEndpoint` for BrowserStack Automate Web   |
| Android       | Direct UiAutomator2 + Android CDP / `spana-bridge` (`adb reverse`)                    | Bundled APK server, persistent warm daemon                 |
| iOS Simulator | Direct WDA (warm session reuse) + WebKit Inspector / `webinspectord` / `spana-bridge` | Bundled unsigned XCTest bundle                             |
| iOS Device    | Same WDA bundle + `iproxy` + WebKit / `spana-bridge`                                  | Re-signed via `codesign`; requires `iproxy`                |
| Electron      | Electron CDP (`--remote-debugging-port`) + `spana-bridge`                             | Launches entry/binary or attaches via `cdpUrl` / `cdpPort` |
| Electrobun    | CEF / WebView2 CDP / WebKit Inspector + `spana-bridge`                                | Supports native & CEF renderers                            |
| Appium Cloud  | Direct W3C Appium client (no WebdriverIO required)                                    | First-class BrowserStack & Sauce Labs helpers              |

## Monorepo structure

- `packages/spana` (`spana-test`) — core library, drivers, smart coordinator, MCP server, CI filters, Studio server, and CLI
- `packages/spana-bridge` (`spana-bridge`) — optional in-app WebSocket bridge for hybrid/desktop targets
- `apps/docs` — documentation & landing page (`https://spana.antonwester.se`)
- `apps/studio` — Spana Studio web UI (embedded into `spana-test`)
- `benchmarks/` — reproducible head-to-head framework and MCP agent benchmarks
