# spana Roadmap

## Phase 1 — Stability & Correctness (v0.1.0) ✅

- Fix iOS deep link handling at driver level
- Node.js runtime support (`npx spana-test` works)
- Improve error messages (include selector details)
- Clean up legacy experimental flows

---

## Phase 2 — Developer Experience (v0.2.0)

- ✅ Auto-generate HTML reports
- ✅ Better config discovery
- ✅ Spana Studio — Element Inspector
- ✅ Spana Studio — Test Runner Dashboard
- ✅ `spana init` scaffolding command
- Pre-flight flow validation (circular dependency detection, missing file checks)
- Conditional flow execution (`when: platform`, `when: visible`)

---

## Phase 3 — Completeness (v0.5.0)

- ✅ Parallel device execution
- ✅ Retry & flake detection (`--retries N`)
- iOS physical device support (WDA re-signing + iproxy)
- `./agent` subpath export for programmatic API
- Relative selectors (`below`, `above`, `leftOf`, `rightOf`, `childOf`)
- Auto-start emulator flag for CI
- JavaScript scripting in flows (`evalScript`, `runScript` for custom logic)

---

## Phase 4 — Ecosystem (v1.0.0)

- GitHub Action integration
- VS Code extension
- CI examples (GitHub Actions, GitLab CI, CircleCI)
- Allure reporter support
- Cloud provider support — Appium integration (BrowserStack, Sauce Labs, etc.)
- WebView CDP support (JS execution inside mobile WebViews)
- Network mocking/control (`mockNetwork`, `blockNetwork`, `setNetworkConditions`)
- Cookie/auth state management (`saveCookies`, `loadAuthState`)
