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

- Runtime ownership + cleanup — drivers return `{ driver, cleanup }`, CLI/Studio/agent dispose on exit and signals
  - Reference: `maestro-runner/pkg/cli/test.go`, `pkg/cli/web.go`, `pkg/cli/android.go`, `pkg/cli/ios.go`
  - Spana gap: `src/drivers/raw-driver.ts` has no cleanup contract, `src/cli/test-command.ts` has inline setup
- Port/resource isolation — deterministic port allocation, per-session cleanup (no `forward --remove-all`)
  - Reference: `maestro-runner/pkg/driver/wda/runner.go`, `pkg/device/android.go`
  - Spana gap: `src/cli/test-command.ts` picks random ports, `src/drivers/uiautomator2/installer.ts` clears all forwards
- Unified device discovery + `--device <id>` targeting — consistent across CLI, Studio, and agent
  - Reference: `maestro-runner/pkg/cli/cli.go`, `pkg/cli/test.go`
  - Spana gap: `src/device/discover.ts` vs `src/cli/test-command.ts` vs `src/studio/routers/devices.ts` behave differently
- Wire LaunchOptions end-to-end — `clearState`, `launchArguments`, `clearKeychain` (documented but not implemented)
  - Reference: `maestro-runner/pkg/driver/uiautomator2/commands.go`, `pkg/driver/wda/commands.go`
  - Spana gap: `src/api/app.ts` only exposes `{ deepLink }`, `src/schemas/config.ts` and docs advertise more
- Invoke config hooks — `beforeAll`/`beforeEach`/`afterEach`/`afterAll` (in schema, not called)
  - Reference: `maestro-runner/pkg/flow/flow.go`, `pkg/executor/flow_runner.go`
  - Spana gap: `src/schemas/config.ts` defines hooks, `src/cli/test-command.ts` never invokes them

### Features

- iOS physical device support (WDA re-signing + iproxy)
- `./agent` subpath export for programmatic API
- Relative selectors (`below`, `above`, `leftOf`, `rightOf`, `childOf`)
- Auto-start emulator flag for CI
- JavaScript scripting in flows (`evalScript`, `runScript` for custom logic)

---

## Phase 4 — Ecosystem (v1.0.0)

### Platform & integration

- GitHub Action integration
- VS Code extension
- CI examples (GitHub Actions, GitLab CI, CircleCI)
- Cloud provider support — Appium integration (BrowserStack, Sauce Labs, etc.)

### Web testing

- WebView CDP support (JS execution inside mobile WebViews)
- Browser runtime config (headed mode, browser selection, proper disposal)
- Network mocking/control (`mockNetwork`, `blockNetwork`, `setNetworkConditions`)
- Cookie/auth state management (`saveCookies`, `loadAuthState`)

### Reporting & diagnostics

- Allure reporter support
- Typed failure model — categorized errors with suggestions
- Driver stability knobs (`waitForIdleTimeout`, `typingFrequency` per-flow)
