# Phase 3 Remaining Quick Wins: Config Hooks, Port Isolation, Auto-Start

Three focused improvements to close remaining structural reliability gaps.

---

## 1. Config Hooks Invocation

### Problem

`ProvConfig.hooks` defines `beforeAll`/`beforeEach`/`afterEach`/`afterAll` in the schema, but they're never called. Users see them in config but they do nothing.

### Design

**Orchestrator** (`core/orchestrator.ts`):

- Before running flows on a platform: call `hooks.beforeAll({ app, platform })`
- After all flows on a platform complete: call `hooks.afterAll({ app, platform, summary })`

**Engine** (`core/engine.ts`):

- Before each flow: call `hooks.beforeEach({ app, platform })`
- After each flow (always, even on failure): call `hooks.afterEach({ app, platform, result })`

**Plumbing:**

- Add `hooks?: ProvConfig['hooks']` to `PlatformConfig`
- Add `hooks?: ProvConfig['hooks']` to `EngineConfig`
- `test-command.ts` passes `config.hooks` to both

**Error handling:**

- `beforeAll` failure: skip all flows on that platform, log error
- `beforeEach` failure: skip that flow, mark as failed
- `afterEach`/`afterAll` failure: log warning, don't affect test results

**HookContext** already defined in `schemas/config.ts` (lines 36-42). The `app` field is typed as `unknown` — we'll pass the `PromiseApp` instance.

### Files Modified

- `core/orchestrator.ts` — call beforeAll/afterAll
- `core/engine.ts` — call beforeEach/afterEach, accept hooks in EngineConfig
- `cli/test-command.ts` — pass config.hooks through

---

## 2. Port/Resource Isolation

### Problem

Ports are allocated with `Math.random()` which can collide. UIA2 installer calls `adb forward --remove-all` which nukes forwards from other sessions.

### Design

**Port allocator** (`core/port-allocator.ts`):

- `allocatePort(base: number): number` — returns next available port starting from base
- `releasePort(port: number): void` — marks port as available
- Tracks allocated ports in a module-level `Set<number>`
- Simple incrementing counter per base, skips ports already in the set

**Per-session cleanup:**

- `uiautomator2/installer.ts`: Replace `adb forward --remove-all` with `adb forward --remove tcp:<hostPort>` targeting only our allocated port
- Store the allocated port and return a cleanup function

**Cleanup contract:**

- `setupUiAutomator2` and `setupWDA` return `{ host, port, cleanup }` (WDA physical already does this)
- `test-command.ts` calls `cleanup()` in the teardown section (currently just `killApp`)

### Files Modified

- New: `core/port-allocator.ts`
- `drivers/uiautomator2/installer.ts` — use allocator, per-port cleanup
- `drivers/wda/installer.ts` — use allocator for simulator port
- `cli/test-command.ts` — use allocator, call cleanup functions
- `agent/session.ts` — use allocator

---

## 3. Auto-Start Emulator Flag

### Problem

iOS simulators aren't auto-booted when none are running. Android already auto-starts via `ensureAndroidDevice()`, but iOS just returns null and skips the platform.

### Design

**`--auto-start` CLI flag:**

- When set and no iOS simulator is booted: call `ensureIOSSimulator()` which already boots a shutdown simulator
- Android: no change needed — `ensureAndroidDevice()` already auto-starts

**Current behavior analysis:**

- `ensureAndroidDevice()` already starts an AVD if none connected — this stays as-is
- `ensureIOSSimulator()` already boots a shutdown simulator if it finds one — but it's only called in the simulator fallback path, not when a physical device check fails first
- The real gap: when no physical device AND no booted simulator, the code calls `ensureIOSSimulator(bundleId)` which returns the first available (possibly shutdown) simulator and boots it. This actually already works.

**Revised analysis:** Looking more carefully, `ensureIOSSimulator` on line 250 of test-command.ts IS already called as a fallback. It boots shutdown simulators. So iOS auto-start already works.

The actual gap is for CI environments where you want to be explicit about auto-starting. The `--auto-start` flag would:

1. Be documented for CI usage
2. In future, control whether emulators/simulators are started (right now they always are)

**Simplest approach:** Add the flag to CLI parsing and help text. For now it's a no-op (behavior already exists). In a future cleanup, gate auto-start behind this flag and make the default "don't auto-start" for explicit CI control.

Actually, this means there's no code change needed beyond adding the flag. Let me reconsider what's actually useful here.

**Better approach:** Skip the `--auto-start` flag for now. The behavior already exists. Instead, focus the effort on the hooks and port isolation which are real gaps. Mark "Auto-start emulator flag" as done on the roadmap since `ensureAndroidDevice` and `ensureIOSSimulator` already handle it.

---

## Summary

| Item                | Status                               | Effort              |
| ------------------- | ------------------------------------ | ------------------- |
| Config hooks        | Real gap — needs implementation      | Medium              |
| Port isolation      | Real gap — needs implementation      | Medium              |
| Auto-start emulator | Already works via ensure\* functions | None (mark as done) |
