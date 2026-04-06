# spana Roadmap

## Phase 1 — Stability & Correctness (v0.1.0) ✅

- Fix iOS deep link handling at driver level
- Node.js runtime support (`npx spana-test` works)
- Improve error messages (include selector details)
- Clean up legacy experimental flows

---

## Phase 2 — Developer Experience (v0.2.0) ✅

- ✅ Auto-generate HTML reports
- ✅ Better config discovery
- ✅ Spana Studio — Element Inspector
- ✅ Spana Studio — Test Runner Dashboard
- ✅ `spana init` scaffolding command
- ✅ Pre-flight flow validation (duplicate names, platform checks, empty directory)
- ✅ Conditional flow execution (`when: { platform, env }`)

---

## Phase 3 — Completeness & Reliability (v0.5.0)

### Already done

- ✅ Parallel device execution
- ✅ Retry & flake detection (`--retries N`)

### Structural reliability

Inspired by maestro-runner (`/Users/anton/.superset/projects/maestro-runner`). Full comparison: `docs/superpowers/plans/2026-04-06-maestro-runner-comparison.md`.

- ✅ Runtime ownership + cleanup — setup returns `{ driver, cleanup }`, CLI/Studio/agent dispose on exit and signals
- ✅ Port/resource isolation — deterministic port allocation, per-session cleanup
- ✅ Unified device discovery + `--device <id>` targeting — consistent across CLI, Studio, and agent
- ✅ Wire LaunchOptions end-to-end — `clearState`, `launchArguments`, `clearKeychain` implemented in all drivers
- ✅ Invoke config hooks — `beforeAll`/`beforeEach`/`afterEach`/`afterAll` now invoked in orchestrator and engine

### Features

- ✅ iOS physical device support (WDA re-signing + iproxy)
- ✅ `./agent` subpath export for programmatic API
- ✅ Relative selectors (`below`, `above`, `leftOf`, `rightOf`, `childOf`)
- ✅ Auto-start emulator/simulator for CI (handled by `ensureAndroidDevice`/`ensureIOSSimulator`)
- ✅ JavaScript scripting — `app.evaluate()` for web; TS flows provide full scripting for all platforms

### Runner & CI ergonomics

Additional inspiration from WebdriverIO (`/Users/anton/.superset/projects/webdriverio`).

- ✅ Config ergonomics — `defineConfig()`, schema validation, relative-path resolution, capability precedence handling, and `--validate-config`
- ✅ Interactive debugging — pause into a live session / REPL with bound `app` and driver context
- ✅ CI sharding & fail-fast — `--shard <current>/<total>` and `--bail <N>`

---

## Phase 4 — Ecosystem (v1.0.0)

### Platform & integration

- ✅ GitHub Action integration (reusable composite action)
- ✅ CI examples (GitHub Actions, GitLab CI)
- ✅ Cloud provider support — Appium integration for BrowserStack, Sauce Labs, and generic Appium hubs, with provider result reporting and cloud docs. Plan: `docs/superpowers/plans/2026-04-06-phase4-appium-cloud-mode.md`
- ✅ Provider helper services for cloud mode — managed app upload references, BrowserStack Local / Sauce Connect lifecycle, and provider-specific capability augmentation

### Web testing

- ✅ WebView / hybrid support — context discovery, targeted switching, and JS execution inside mobile WebViews
- ✅ Browser runtime config (headed mode, browser selection, proper disposal)
- ✅ Network mocking/control (`mockNetwork`, `blockNetwork`, `setNetworkConditions`)
- ✅ Cookie/auth state management (`saveCookies`, `loadAuthState`)

### Reporting & diagnostics

- ✅ Allure reporter support
- ✅ Typed failure model — categorized errors with suggestions
- ✅ Driver stability knobs (`waitForIdleTimeout`, `typingDelay` per-flow)
- ✅ Real-time console reporting — progress updates, `--quiet` mode, and grouped output by platform
- ✅ Log masking / redaction for secrets in console and artifact logs
