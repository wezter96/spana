# All-Clients Playwright / e2e → Spana Direct CDP Migration & Benchmark Report

**Generated:** 2026-11-28  
**Spana HEAD:** `52ebb7d` (`origin/main`, Wave-1 through Wave-4 zero-bug + 960/960 8-config × 120-scenario stress matrix + 17/17 CLI & wave-cap checks, 0 flakes, 0 orphan Chromium processes)  
**Scope:** All 7 active personal product repositories migrated directly to `main` (`master` for `lingo`), with serialized (`flock /tmp/spana-bench.lock`) BEFORE vs AFTER benchmarks on Linux headless Chromium (`gpu: "disabled"` / SwiftShader where WebGL2 required).

---

## Executive Summary — BEFORE vs AFTER Across All 7 Active Clients (8 Suites)

| Client / Suite | Commit (`origin/main` or `master`) | Host | Scope | BEFORE (Playwright / `e2e`) | AFTER (Spana Direct CDP) | Speedup | Notes |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| **`lingo`** (`apps/web`) | `912372f` (`master`) | `minipc` | 138 flows (+ 9 a11y + 15 showcase) | 340.1 s (1w) | **83.9 s** (4w `hot-cache`) / **247.1 s** (1w `hot-cache`) / **280.7 s** (`fresh`) | **4.06×** (4w) / **1.38×** (1w) | `a11y`: `33.3s → 16.6s` (**2.01×**); `showcase`: `4.55s → 1.26s` (**3.62×**) |
| **`htig`** | `2f7380d` (`main`) | `minipc` | 60 flows (`desktop` + `mobil`, 20 axe) | 33.18 s (8w clean; 69.45 s cold w/ flake) | **11.31 s** (`hot-cache`) / **16.79 s** (`fresh`) | **2.93×** (`hot-cache`) / **1.98×** (`fresh`) | 60/60 pass, 0 flakes |
| **`collie`** | `6ded903cf7` (`main`) | `jarvis-linux` | 126 scenarios (15-scen & 10-core locked bench) | 418.01 s (10/15) · 136.56 s (10/10 core) | **172.92 s** (**12/15**) · **55.68 s** (10/10 core) | **2.42×–2.45×** (up to **8.59×** per scenario) | `fresh`: `359.22s` (1.16×) / `90.68s` core (1.51×) |
| **`wez-outreach` (`apps/studio`)** | `f14253b` (`main`) | `jarvis-linux` | 25 suites / 98 steps (5w) | 179.1 s (98/98, 1 flaky retry) | **87.0 s** (`hot-cache`) / **87.1 s** (`fresh`) | **2.06×** (`2.07×` post-build) | 98/98 pass, **0 retries** |
| **`monotirith` (`apps/bolagy` + 3 apps)** | `724859c1` (`main`) | `jarvis-linux` | 135 Bolagy + 16 other flows (10-file / 11-test 4w bench) | 49.6 s wall / 43.9 s runner (11/11 ×3) | **28.5 s** wall / **22.4 s** runner (`fresh`) · **29.2 s** (`hot-cache`) | **1.74×** wall / **1.96×** runner | 151/151 valid; full Bolagy 209/216 matches Playwright parity |
| **`wez-outreach` (`packages/generator`)** | `910272e` (`main`) | `minipc` | 7 browser test files (106 tests, 3,875 expects) | 276.34 s (7 browser files) · 160.68 s (full 36-file suite) | **158.33 s** (7 files) · **135.18 s** (full) | **1.75×** (up to **2.51×** on `search.test.ts`) | 232/232 full pass, 0 orphans |
| **`sokhem`** (Wave-4 `52ebb7d`) | `fe074fbb7` (`main`) + Wave-4 proof | `minipc` | **32 specs / 499 flows** across 5 projects (4w) | 201.18 s full · 49.24 s a11y · 9.72 s smoke | **172.90 s** full (1× concurrent, 470/29/0) · **36.61 s** a11y · **7.44 s** smoke | **1.16×** full · **1.35×** a11y · **1.31×** smoke | `0.15.0` seq was `176.15 s` (**1.14×**); Wave-4 dynamic pool cut W3 `430.15 s → 172.90 s` (**2.49×**) & fixed 4 dialog fails |
| **`wez`** (`e2e/` + `e2e-army/`) | `14d24362` (`main`) | `jarvis-linux` | 53 specs (2,287 checks, 279 features) + `e2e-army/` | 466.74 s (3 shards) | **447.43 s** (100% check/feature parity) · `e2e-army` **1.3 s** (2/2) | **1.04×** (PTY/LSP-bound) | Zero Playwright imports remain in `e2e/` |

---

## Spana Zero-Bug Evolution Across 4 Hardening Waves (`minipc`)

| Wave | Commit | Key Fixes Shipped | Stress Matrix | Extra CLI/Wave Checks |
| --- | --- | --- | --- | --- |
| **Wave 1** | `c991539` | Node 22 ESM `createRequire` (`pngjs`), Linux AppArmor `--no-sandbox` & 108B `TMPDIR`, hover `--blink-settings`, `@base-ui` `buttons: 1`, multi-node `{ text }`, `<fieldset>`/`<legend>`, visibility-aware `first()`/`nth()`, scaled iframes & 47× OOPIF stall fix, `fresh`-mode `Fetch.enable` leak, `route.fallback()`/`unroute()`, `setup` tag exemption | **800 / 800** (100 × 8) · `12.25s` 4w hot | 11 / 11 |
| **Wave 2** | `7799ca2` | `assertEnabledState` (`toBeDisabled()`), per-flow `addInitScript` isolation, multi-project `--workers` cap, `{ force: true }` `scrollIntoView()`, `\u00a0` NBSP normalization, sandboxed no-`allow-scripts` iframes, `app.evaluate` `undefined` args, default Chrome UA sanitization, late-OOPIF & popup `waitForResponse` races | **880 / 880** (110 × 8) | 13 / 13 |
| **Wave 3** | `e2e0e1f` | `setEmulation({ locale })` UA preservation + first-class `userAgent`, `axe-core` caching (**4.13×** repeated audits), runtime `ctx.skip()`, root Promise-only Direct CDP API (`createCdpApp`/`launchDirectCdpPage`), mobile viewport schema, `httpCredentials` (`Fetch.authRequired`), CORS `OPTIONS` in `route()`, console wall time, plus **`monotirith` / `0.16.0` regressions**: `opacity: 0` & `inert`, cross-nav `evaluate()`, lexical `hasTopLevelReturn()`, `getClippedViewportBox()`, `RegExp` upload, subdomain cookies | **960 / 960** (120 × 8) · `8.38s` 4w hot | 15 / 15 |
| **Wave 4** | `52ebb7d` | Scrollable `position: fixed` dialog clipping (`dom-channel.ts` — fixed 4 Sökhem `chromium` failures), **true dynamic shared cross-project worker pool** (`test-command.ts` — Sökhem 5-project `--workers 4` dropped `430.15s → 172.90s`, **2.49×**), dirty-tracked zero-overhead `hot-cache` resets | **960 / 960** (120 × 8) · `10.12s` 4w hot · **Sökhem 470/499 (0 fail)** | **17 / 17** |

---

## Per-Client Detailed Ledgers (`minipc:~/spana-migration-ledger/`)
- `lingo.md` · `htig.md` · `collie.md` · `wez.md` · `wez-outreach.md` · `wez-outreach-generator.md` · `sokhem.md` · `sokhem-wave3-minipc.md` · `sokhem-wave4-minipc.md` · `monotirith.md` · `monotirith-issues.md` · `spana-zerobug-profile.md`
