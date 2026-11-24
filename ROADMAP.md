# spana Roadmap

All items from the original v1 roadmap are complete.

This roadmap resets around the next set of improvements surfaced by recent comparison work against WebdriverIO and maestro-runner, plus gaps in Spana's own docs and demo coverage.

Reference notes:

- `docs/superpowers/plans/2026-04-06-maestro-runner-comparison.md`
- `demo-roadmap.md`

## Guardrails

- Stay **TypeScript-native** and **E2E-first**
- Prefer fixing **real product gaps** over chasing every competitor checkbox
- Treat **README/demo gaps** as serious product work when they hide shipped features
- Borrow from WebdriverIO and maestro-runner selectively, without turning Spana into a clone of either

---

## Phase 5 — Visibility & Showcase (v1.1.0) [complete]

Spana now has more capability than the top-level README and demo suite communicate. Close the gap between what ships and what users immediately understand.

- [x] Update the top-level README to surface already-shipped features:
  - Allure reporter
  - relative selectors
  - `validate-config`, `init`, Studio, `--device`, `--shard`, `--bail`
  - app auto-install via `appPath`
  - WebView / hybrid context APIs
  - cloud helper services for BrowserStack and Sauce Labs
- [x] Refresh quick start and configuration examples so the main docs reflect the current product
- [x] Execute `demo-roadmap.md` so the native demo suite visibly showcases richer interactions and artifacts
- [x] Add one concise feature matrix showing what is supported locally vs in Appium cloud mode vs on web

### Success criteria

- A new user can understand Spana's real feature surface from the README alone
- The demo suite proves more than route checks and simple taps
- Future comparisons do not misclassify shipped capabilities as missing

### Remaining example-app showcase gaps

- [x] Add a visual-regression example flow that uses `toMatchScreenshot()` and `--update-baselines`, not just ad hoc screenshot capture
- [x] Add a relative-selector showcase flow so `below`, `rightOf`, and `childOf` show up in runnable example suites instead of docs only
- [x] Add accessibility showcase coverage: `toPassAccessibilityAudit()` on web plus cross-platform element-level accessibility assertions
- [ ] Add a multi-device showcase run for the framework app that explicitly demonstrates `--parallel`, `--device`, and `--devices`
- [ ] Expand Studio coverage further into artifact drill-in and deeper inspector interactions
- [ ] Add one provider-backed showcase smoke using the framework app plus the example BrowserStack/Sauce capabilities

---

## Phase 6 — Parallel Execution & Runner UX (v1.2.0) [complete]

maestro-runner is still ahead on end-to-end multi-device execution. Spana already has most of the internal pieces; the next step is wiring them into the real CLI path.

- [x] Wire `packages/spana/src/core/parallel.ts` into `spana test` via a `--parallel` flag
- [x] Auto-discover all available devices per platform and distribute flows via work-stealing queue
- [x] Run platforms concurrently (web + android + ios in parallel)
- [x] Preserve retries, bail, hooks, artifacts, and per-platform filtering under parallel execution
- [x] Upgrade console output to be worker-aware and device-aware with device-prefixed lines and worker stats summary
- [x] Add focused unit and integration test coverage for parallel scheduling, bail propagation, and retry behavior

Design spec: `docs/superpowers/specs/2026-04-06-parallel-execution-design.md`

### Success criteria

- `spana test --parallel` auto-discovers devices and runs flows across them concurrently
- Output remains readable and trustworthy under concurrency
- Parallel runs feel like a polished product feature, not an internal experiment

---

## Phase 6.5 — Advanced Parallel Configuration (v1.2.1) [complete]

Follow-up to Phase 6. Adds explicit control knobs for users who need more than auto-discovery defaults.

- [x] `--workers <n>` to cap the number of concurrent workers per platform
- [x] `--devices <id1>,<id2>` to select a specific subset of devices instead of auto-discovery
- [x] Web multi-context parallelism (multiple browser contexts as workers for Playwright)
- [x] Per-platform worker count configuration in `spana.config.ts` (e.g., `defaults.workers.android: 2`)

### Success criteria

- Users with many devices can limit resource usage via `--workers`
- Users can target specific devices without disabling parallelism
- Web-heavy suites can benefit from multi-context parallelism

---

## Phase 6.75 — Assertion & Element API Expansion (v1.2.5) [complete]

Fill critical API gaps that affect both mobile and web workflows.

### Assertions expansion

- [x] Add `toHaveValue(expected: string | number)` for input elements
- [x] Add `toBeEnabled()` and `toBeDisabled()` for interactive element state
- [x] Add `toHaveAttribute(name: string, value?: string)` for element properties
- [x] Add partial text matching via `toContainText()` method
- [x] Add regex support for text assertions via `toMatchText(pattern: RegExp)`

### Element introspection

- [x] Add `app.getText(selector)` — read element text content
- [x] Add `app.getAttribute(selector, name)` — read element attribute/value
- [x] Add `app.isEnabled(selector)` — check interactive state without assertion
- [x] Add `app.isVisible(selector)` — check visibility without assertion

### Gesture APIs

- [x] Add `app.pinch(selector, opts?)` — pinch zoom gesture (Android + iOS)
- [x] Add `app.zoom(selector, opts?)` — zoom in gesture (Android + iOS)
- [x] Add `app.multiTouch(sequences: TouchSequence[])` — arbitrary multi-touch sequences (Android + iOS)

### Success criteria

- Users can express common assertions without workarounds
- Element state inspection is available for conditional logic
- Pinch/zoom gestures work on Android and iOS

---

## Phase 6.85 — Error Messages & Diagnostics (v1.2.6) [complete]

Improve failure messages to be actionable and guide users toward solutions.

- Include selector alternatives when element not found (e.g., "Did you mean testID 'xyz' instead of 'abc'?")
- Add retry suggestions in failure messages ("Consider increasing waitTimeout from 5000 to 10000")
- Show element hierarchy snapshot on failure for debugging
- Distinguish between "element not found" vs "element not visible" vs "element not interactive"
- Add `--verbose` flag to dump full driver logs on failure

### Success criteria

- 80%+ of failures include actionable guidance without docs lookup
- Users can diagnose issues from failure message alone in most cases

---

## Phase 7 — Mobile Interaction Ergonomics (v1.3.0) [complete]

The next quality frontier is making common mobile flows easier and more reliable to express.

- Improve text input reliability, especially for Unicode and special characters on Android
- Improve smart target resolution for nested/clickable container patterns
- Add clearer gesture ergonomics around keyboard dismissal and back navigation
- Expand failure suggestions and diagnostics for scroll/input/gesture failures
- Add showcase/demo coverage for these interactions so they stay visible and protected

### Success criteria

- Writing mobile-heavy flows requires fewer ad hoc scroll/retry loops
- Text input behavior is boringly reliable
- The smart layer feels meaningfully more helpful than raw-driver automation

---

## Phase 8 — Web Workflow Depth (v1.4.0) [complete]

WebdriverIO and maestro-runner both present a broader web workflow story than Spana currently markets or supports.

### Expand existing web APIs (already shipped but not visible)

- Add `app.downloadFile(path)` — download file to local path
- Add `app.uploadFile(selector, path)` — upload file via input element
- Add `app.getConsoleLogs()` — capture browser console logs
- Add `app.getJSErrors()` — capture JavaScript errors

### Tab/window management

- Add `app.newTab(url?)` — open new browser tab
- Add `app.switchToTab(index)` — switch by index
- Add `app.closeTab()` — close current tab
- Add `app.getTabIds()` — list open tab IDs

### Diagnostics and artifacts

- Add per-flow HAR export for network recording
- Add console log capture to HTML reporter
- Add verbose driver logging toggle for debugging

### Documentation and examples

- Make existing network/auth/cookie helpers more visible through docs
- Add at least one example suite that demonstrates web-only power features
- Clarify which web features are local-Playwright-only vs available through broader execution modes

### Success criteria

- Spana's web story is clearly stronger than "basic browser support"
- Advanced browser workflows are part of the documented, example-backed product surface

---

## Phase 9 — Ecosystem & Integration Surface (v1.5.0) [complete]

spana now supports custom reporters and cloud providers via config-path loading, per-platform progress in both CLI and Studio, result filtering in Studio UI, and improved JSDoc coverage for AI tooling.

- [x] Stabilize and document a public custom reporter API
- [x] Custom reporters loadable via module path in `spana.config.ts`
- [x] Export all Reporter and CloudProvider types from the main `spana` package
- [x] Custom cloud provider support via `cloudProvider` config field
- [x] Per-platform progress display in console reporter and Studio UI
- [x] Platform and status filtering in Studio runner results
- [x] JSDoc on all public API exports for AI-driven automation
- [x] Custom reporters documentation with examples
- [ ] ~~Full plugin/service extension model~~ — deferred (hooks cover current use cases)
- [ ] ~~LambdaTest / TestingBot cloud helpers~~ — dropped (no demand)

### Success criteria

- Teams can write and load custom reporters without patching spana internals
- Teams can add custom cloud providers without patching spana internals
- Console and Studio show per-platform progress during test runs
- Studio results are filterable by platform and status
- AI tools get rich inline documentation from JSDoc

---

## Phase 10 — Agent & Developer Experience (v1.6.0)

Spana's raw capability is now broad enough that the next big win is tightening the day-to-day loop: setup, discovery, authoring, iteration, and failure repair should feel deterministic, fast, and equally friendly to humans and AI agents.

### Stable machine interfaces

- Add `--json` output mode to all relevant CLI commands, including `devices`, `validate`, `validate-config`, `selectors`, `hierarchy`, and future diagnostics commands
- Version all structured CLI output with a `schemaVersion` field so agent integrations can rely on stable contracts
- Include structured `errorCode`, `suggestedFix`, and `docsUrl` fields in machine-readable failures instead of forcing tools to scrape human text

### Environment readiness

- Add `spana doctor` to validate config, local runtime dependencies, connected devices/simulators, app installability, iOS signing, and Appium/cloud configuration before a run starts
- Emit both human-readable and machine-readable diagnostics with concrete remediation steps

### Faster authoring and iteration

- Generate starter `.flow.ts` files from Studio or the current screen state using best-available selectors and placeholder assertions
- Add reusable named setup states / fixtures for common starting points like authenticated sessions, seeded carts, or deep-linked screens
- Add fast rerun modes such as `spana test --last-failed`, `--changed`, and `--watch`
- Add opinionated config presets for common setups like local web, local React Native, BrowserStack, and Sauce Labs

### Reliability guardrails

- Add selector linting or strict validation to warn on brittle patterns like coordinate taps, ambiguous text selectors, and flows that over-rely on raw visible text
- Surface clearer recommendations when apps should add stable `testID` / accessibility identifiers for long-term test reliability

### Richer failure bundles

- Write a single structured failure artifact that includes the failed step, last successful step, attempted selector, nearby selector alternatives, hierarchy snippet, screenshot/log artifact paths, and a repro command
- Make failure output self-contained enough that both a human and an agent can attempt a repair loop without reopening multiple tools or docs pages

### Agent-facing docs and context packaging

- Build on the new `llms.txt` support with cleaner markdown exports or generated `llms-ctx` bundles for high-signal documentation ingestion
- Document structured CLI output schemas so external agents and tools can integrate against Spana intentionally rather than heuristically

### Delivered

- [x] `spana doctor` environment readiness diagnostics (config, Android/iOS WebView inspection, WDA/UiAutomator2, Electron/Electrobun, `spana-bridge`)
- [x] Opinionated `spana init` presets including `capacitor-web-first`
- [x] Fast rerun modes: `spana test --last-failed`, `--changed`, `--changed-since <ref>`, and `--watch`
- [x] Versioned `--json` machine envelopes (`schemaVersion`, `errorCode`, `suggestedFix`, `docsUrl`) across `devices`, `validate`, `validate-config`, `selectors`, `hierarchy`, and `doctor`
- [x] Reusable named setup states & composable lazy fixtures (`defineSetup`, `createFlowWithFixtures`)
- [x] Structured failure bundles with selector alternatives, inline runtime diagnostics (`consoleLogs` / `jsErrors`), repro commands, and artifact references (`failure-bundle.json`)
- [x] Runtime selector guardrails — advisory warnings for coordinate taps, text-heavy flows, and bare string selectors (with `systemUI()` exemption)
- [x] Auto-generated `llms-full.txt` with all documentation inlined for agent context packaging

### Remaining in Phase 10

- [ ] Studio visual starter `.flow.ts` generation from live screen state (CLI/MCP flow generation already ships via `spana mcp`)

### Success criteria

- Agents can use Spana's CLI and diagnostics without scraping human-oriented output
- A new user can run one command to understand whether their environment is ready and how to fix it if not
- Writing the first reliable flow takes fewer manual setup and discovery steps
- Failure reports are rich enough to support an efficient fix-and-rerun loop for both humans and agents

---

## Phase 11 — Web-First Cross-Platform Engine (v1.7.0) [complete]

One `{ testID }` + `systemUI()` selector model across **Web, Android (Capacitor/WebView & native), iOS (WKWebView & native), Electron, and Electrobun** — without Appium.

### Delivered

- [x] Dual-channel smart resolver (`resolveElementAcrossChannels`) routing `{ testID }` to ~1 ms DOM channels and `systemUI()` / native fallbacks to direct WDA / UiAutomator2 with WebView-frame + DPR coordinate mapping
- [x] Shadow DOM (`el.shadowRoot`) and same-origin `<iframe>` piercing plus automatic offscreen `scrollIntoView` before native coordinate taps
- [x] Opt-in `spana-bridge` workspace package (`packages/spana-bridge`) over WebSocket with DOM queries, lazy `waitForIdle()`, storage injection (`setStorage`/`clearStorage`/`resetFast`), network mocking, console/error capture, and automatic Android `adb reverse`
- [x] Direct mobile DOM channels without Appium: Android CDP over ADB, iOS WebKit Inspector (`ios_webkit_debug_proxy`), and zero-dependency Apple `webinspectord` Unix-socket XML-plist client fallback
- [x] Desktop targets: Electron (`ELECTRON_CDP_PORT` / `--remote-debugging-port`) and Electrobun (CEF / WebView2 / WKWebView / WebKitGTK + `spana-bridge`)
- [x] Performance infrastructure: persistent warm WDA/UiAutomator2 daemons (`spana daemon`), WDA `sessionId` reuse, single-browser multi-context `buildWebRuntimePool`, and lazy `bridge.idle()` on miss
- [x] Reproducible head-to-head benchmark harness (`benchmarks/framework-comparison/`) comparing Spana vs Playwright vs WebdriverIO on the same application

---

## Phase 12 — Agent-Native Workflows, CI Filters & Deep Inspection (v1.8.0)

Selective inspiration from AI-first E2E and agent tooling (`e2e-inc/e2e` and Software Mansion's `argent`), while keeping Spana's deterministic, zero-Appium, web-first speed advantage.

### Delivered

- [x] **Pluggable Filters API + `--changed-since <ref>`** — composable `{ name, filter(flows, ctx) }` hooks (`decisionFilter`, `pathRuleFilter`, `applyTestFilters`) with fail-open defaults (always runs changed test files, config/lockfile changes, diffs >60 kB, `alwaysRunTags`, and judge errors)
- [x] **`spana mcp` stdio MCP server** — model-free MCP server letting coding agents drive live web, iOS, Android, Electron, and Electrobun sessions, inspect DOM/native + console/JS-error diagnostics, capture screenshots, run flows, and emit verified `.flow.ts` files
- [x] **Verified Replay Cache (`.spana/cache/`) + `--strict-cache`** — `ReplaySession` & `ReplayCacheStore` replaying deterministic actions with zero LLM calls, verifying writes only after real assertions pass, and supporting self-healing handoff in `read-write` mode
- [x] **Composable lazy fixtures & named setups** — `createFlowWithFixtures` + `defineSetup` (`{ session: "admin" }`) with lazy destructured dependency graphs, LIFO teardown, and automatic `spana-bridge` / Playwright storage injection
- [x] **Inline failure-bundle runtime diagnostics, layout-tolerant visual diffing & GitHub PR reporter** — `runtimeDiagnostics` in `failure-bundle.json`, `mode: "layout-tolerant"` in `compareScreenshots`, and built-in `--reporter github` (`github-pr-summary.md` + `$GITHUB_STEP_SUMMARY`)
- [x] **Performance pack & lightweight CDP/Lightpanda adapter** — built-in zero-setup `PlaywrightDomChannel` (1–2 ms DOM queries + fast non-input clicks without 48 ms rAF sleep), `webViewFrame` caching + 0-dump web viewport fast-path, warm persistent Chromium daemon (`warmBrowser`), CDP-direct `makeLightweightCdpDriver` (`engine: "cdp" | "lightpanda"`), native 1-token logprob decision judge (`createLogprobDecisionJudge`) with KV-cache prefix sharing, and Flashwright-inspired `instantAnimations`, `blockResources`, and longest-first parallel scheduling (`orderFlowsLongestFirst`)

### Remaining in Phase 12

- [ ] Optional Perfetto / Xcode Instruments / Hermes profiling hooks for mobile render-regression diagnostics
- [ ] Hosted cloud sandbox providers (e.g. remote Lightpanda / Browserless / E2B managed pools)

---

## Phase 24 — Environment-Based Config (v1.17.3) [complete]

Auto-load environment-specific configs (`spana.config.development.ts`, hostname variants).
Already shipped in config-loader with layered config merging.

---

## Phase 30 — Flow Scaffolding (v1.19.0) [complete]

`spana init-flow <name>` generates starter `.flow.ts` files with preset templates (blank, smoke, auth).

---

## Removed phases

The following phases were removed after competitive analysis showed they were unnecessary — either already covered by existing features, not present in any competing E2E framework (WebdriverIO, Maestro, Detox), or overengineered for the problem they solve:

- **Phase 21** (Method chaining) — No E2E framework chains assertions. Saves one line of code.
- **Phase 22** (Timing tiers) — Valid concept but too small for a phase; can be a config tweak.
- **Phase 23** (Config presets) — Redundant with `spana init` which already generates the right config.
- **Phase 25** (Typed config inference) — TypeScript already catches undefined access.
- **Phase 26** (--since) — No competitor has this. `--changed` and `--last-failed` already cover incremental runs.
- **Phase 27** (Watch mode improvements) — Current watch mode works. No competitor has advanced watch features.
- **Phase 28** (Flake detection) — `--retries` already handles flakes. Quarantine is a CI dashboard concern.
- **Phase 29** (--repro) — Failure bundles already include repro commands, selectors, and screenshots.
- **Phase 31** (Selector validation) — Runtime selector guardrails already ship. Static validation can't work without a running app.
- **Phase 32** (Enhanced error messages) — Already covered by failure-bundle.ts and failure-diagnostics.ts.

---

## Strategic bets — Explore, don't commit yet

These are real areas where WebdriverIO is broader, but they are product-direction decisions rather than obvious next roadmap items.

- Component and unit/browser-runner style test modes
- Additional framework adapters beyond native TypeScript flows and Gherkin support
- Broader protocol/runtime coverage closer to WebdriverIO's WebDriver/BiDi ecosystem
- A larger plugin/service marketplace model

Pursue these only if Spana deliberately expands beyond its current position as a TypeScript-native cross-platform E2E framework.
