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

## Phase 6 — Parallel Execution & Runner UX (v1.2.0)

maestro-runner is still ahead on end-to-end multi-device execution. Spana already has most of the internal pieces; the next step is wiring them into the real CLI path.

- Wire `packages/spana/src/core/parallel.ts` into `spana test`
- Add a first-class `--parallel <n>` execution model for multi-device / multi-worker runs
- Use dynamic work distribution so faster workers naturally pick up more flows
- Preserve retries, bail, hooks, artifacts, and per-platform filtering under parallel execution
- Upgrade console output to be worker-aware and device-aware, with better summaries for concurrent runs
- Add focused E2E coverage for mixed-speed worker scheduling and artifact correctness under concurrency

### Success criteria

- `spana test` can run real device/browser work in parallel, not just serially by platform
- Output remains readable and trustworthy under concurrency
- Parallel runs feel like a polished product feature, not an internal experiment

---

## Phase 7 — Mobile Interaction Ergonomics (v1.3.0)

The next quality frontier is making common mobile flows easier and more reliable to express.

- Add a first-class `scrollUntilVisible()`-style helper for off-screen element discovery
- Improve text input reliability, especially for Unicode and special characters on Android
- Improve smart target resolution for nested/clickable container patterns
- Add clearer gesture ergonomics around long press, double tap, keyboard dismissal, and back navigation
- Expand failure suggestions and diagnostics for scroll/input/gesture failures
- Add showcase/demo coverage for these interactions so they stay visible and protected

### Success criteria

- Writing mobile-heavy flows requires fewer ad hoc scroll/retry loops
- Text input behavior is boringly reliable
- The smart layer feels meaningfully more helpful than raw-driver automation

---

## Phase 8 — Web Workflow Depth (v1.4.0)

WebdriverIO and maestro-runner both present a broader web workflow story than Spana currently markets or supports.

- Add browser workflow APIs for uploads/downloads, tabs/windows, console log capture, and JS error assertions
- Expand diagnostics and artifacts for web runs
- Make existing network/auth/cookie helpers more visible through docs and example flows
- Add at least one example suite that demonstrates web-only power features without weakening the cross-platform story
- Clarify which web features are local-Playwright-only vs available through broader execution modes

### Success criteria

- Spana's web story is clearly stronger than "basic browser support"
- Advanced browser workflows are part of the documented, example-backed product surface

---

## Phase 9 — Ecosystem & Integration Surface (v1.5.0)

WebdriverIO's biggest advantage is breadth: more official extension points, more integrations, and a larger ecosystem surface. Spana should grow selectively here.

- Stabilize and document a public custom reporter API
- Decide on an extension model for reporters first, then services/integrations if needed
- Add first-class helper coverage for additional cloud providers such as LambdaTest and TestingBot if demand justifies it
- Ship more reusable CI examples for cloud, hybrid, and multi-device execution
- Improve machine-readable output and agent-facing docs so AI-driven automation remains a clear Spana strength

### Success criteria

- Teams can extend reporting and integrations without patching Spana internals
- Cloud and CI adoption do not depend on reading implementation code
- Spana grows an ecosystem story without losing focus

---

## Strategic bets — Explore, don't commit yet

These are real areas where WebdriverIO is broader, but they are product-direction decisions rather than obvious next roadmap items.

- Component and unit/browser-runner style test modes
- Additional framework adapters beyond native TypeScript flows and Gherkin support
- Broader protocol/runtime coverage closer to WebdriverIO's WebDriver/BiDi ecosystem
- A larger plugin/service marketplace model

Pursue these only if Spana deliberately expands beyond its current position as a TypeScript-native cross-platform E2E framework.
