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

- [x] Structured failure bundles with selector alternatives, repro commands, and artifact references (`failure-bundle.json`)
- [x] Runtime selector guardrails — advisory warnings for coordinate taps, text-heavy flows, and bare string selectors
- [x] Auto-generated `llms-full.txt` with all documentation inlined for agent context packaging

### Success criteria

- Agents can use Spana's CLI and diagnostics without scraping human-oriented output
- A new user can run one command to understand whether their environment is ready and how to fix it if not
- Writing the first reliable flow takes fewer manual setup and discovery steps
- Failure reports are rich enough to support an efficient fix-and-rerun loop for both humans and agents

---

## Strategic bets — Explore, don't commit yet

These are real areas where WebdriverIO is broader, but they are product-direction decisions rather than obvious next roadmap items.

- Component and unit/browser-runner style test modes
- Additional framework adapters beyond native TypeScript flows and Gherkin support
- Broader protocol/runtime coverage closer to WebdriverIO's WebDriver/BiDi ecosystem
- A larger plugin/service marketplace model

Pursue these only if Spana deliberately expands beyond its current position as a TypeScript-native cross-platform E2E framework.
