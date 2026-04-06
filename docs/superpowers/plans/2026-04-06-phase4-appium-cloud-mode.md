# Phase 4: Appium / Cloud Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `spana test` run existing Spana `.flow.ts` and `.feature` suites against Appium-compatible clouds (BrowserStack, Sauce Labs, LambdaTest, TestingBot, self-hosted Appium) using a maestro-runner-style Appium mode. This is the path to BrowserStack support for Spana.

**Architecture:** Keep local execution as the default, but add a second execution mode that connects to an external Appium hub with merged capabilities from config + CLI. Extract runtime setup out of `test-command.ts` into runtime builders that return `{ driver, cleanup, metadata }`. Add Appium-backed Android and iOS raw drivers that avoid `adb`, `simctl`, and `iproxy` assumptions. Keep provider integrations thin like `maestro-runner`: detect the provider from the hub URL, extract session metadata, and optionally report final pass/fail to the provider, but do not own app upload or device provisioning.

**Tech Stack:** TypeScript, Effect, Bun test runner, W3C WebDriver/Appium protocol, Playwright (unchanged for web)

---

## Scope

### In scope

- `spana test` support for `local` and `appium` execution modes
- Generic Appium hub support for Android and iOS
- BrowserStack-first compatibility, with the same architecture usable for Sauce Labs and other Appium clouds
- Config + CLI support for Appium URL and capabilities
- Runtime cleanup / metadata abstraction reusable by later Studio + agent work
- Optional provider result reporting after the run completes

### Explicitly out of scope for this plan

- BrowserStack's Maestro-specific upload/build API
- Studio cloud device UX
- `agent/session.ts` cloud mode
- Provider-managed app upload wrappers in v1
- Cloud browser/web execution
- Automatic BrowserStack Local / Sauce Connect process management in v1

### Key product decision

BrowserStack does support Maestro, but that support is for Maestro YAML suites uploaded through BrowserStack's Maestro API. Spana should target **BrowserStack Appium support**, not BrowserStack's Maestro API, because Spana needs to run its own TypeScript/Gherkin flow format.

---

## Proposed config + CLI surface

### Config shape

Add an execution section to `spana.config.ts`:

```typescript
export default defineConfig({
  execution: {
    mode: "appium",
    appium: {
      serverUrl: process.env.APPIUM_URL,
      capabilitiesFile: "./cloud/browserstack.android.json",
      capabilities: {
        "appium:app": "bs://<app-id>",
      },
      reportToProvider: true,
    },
  },
});
```

Recommended schema shape:

```typescript
export interface AppiumExecutionConfig {
  serverUrl?: string;
  capabilities?: Record<string, unknown>;
  capabilitiesFile?: string;
  reportToProvider?: boolean;
}

export interface ExecutionConfig {
  mode?: "local" | "appium";
  appium?: AppiumExecutionConfig;
}
```

### CLI additions

- `--driver local|appium`
- `--appium-url <url>`
- `--caps <path>`
- `--caps-json '<json>'`
- `--no-provider-reporting`

### Precedence rules

1. CLI flags
2. `spana.config.ts`
3. Built-in defaults

`--device` should continue to override the target device when local mode is active. In Appium mode it should only override capabilities if that mapping is explicitly supported (`appium:deviceName`, `appium:udid`).

---

## File Structure

All source paths below are relative to `packages/spana/`.

| File                            | Responsibility                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `src/schemas/config.ts`         | Add `execution.mode` and `execution.appium` config types                             |
| `src/cli/index.ts`              | Parse `--driver`, `--appium-url`, `--caps`, `--caps-json`, `--no-provider-reporting` |
| `src/cli/test-command.ts`       | Stop doing inline platform setup; use runtime builders and centralized cleanup       |
| `src/runtime/types.ts`          | New runtime handle abstraction: `{ driver, cleanup, metadata }`                      |
| `src/runtime/local.ts`          | Wrap current web/android/iOS local setup in reusable builders                        |
| `src/runtime/appium.ts`         | Create runtimes from external Appium URL + capabilities                              |
| `src/runtime/capabilities.ts`   | Load/merge config caps, file caps, and CLI JSON caps                                 |
| `src/drivers/appium/client.ts`  | Shared W3C/Appium client for session lifecycle and generic requests                  |
| `src/drivers/appium/android.ts` | Android raw driver implemented on top of Appium session APIs                         |
| `src/drivers/appium/ios.ts`     | iOS raw driver implemented on top of Appium session APIs                             |
| `src/cloud/provider.ts`         | Provider registry/detection and result reporting interface                           |
| `src/cloud/browserstack.ts`     | BrowserStack detection + metadata/result reporting                                   |
| `src/cloud/saucelabs.ts`        | Sauce Labs detection + metadata/result reporting                                     |
| `src/report/types.ts`           | Optional provider/session metadata if reports should link back to cloud runs         |
| `apps/docs/...` or `README.md`  | User docs and examples for BrowserStack/Sauce Appium mode                            |

---

## Execution model

### Runtime handle

Introduce a shared runtime abstraction:

```typescript
export interface RuntimeHandle {
  driver: RawDriverService;
  cleanup: () => Promise<void>;
  metadata: {
    platform: Platform;
    mode: "local" | "appium";
    deviceId?: string;
    sessionId?: string;
    provider?: string;
    sessionCaps?: Record<string, unknown>;
  };
}
```

### Why this is required first

Cloud mode is hard to add cleanly while `test-command.ts` directly owns adb installs, WDA startup, and raw driver construction. The runtime handle becomes the seam for:

- local vs appium setup
- centralized cleanup
- provider result reporting
- future Studio/agent reuse

---

## Task 1: Add execution config, CLI flags, and capability merging

**Files:**

- Modify: `src/schemas/config.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/cli/test-command.ts`
- Create: `src/runtime/capabilities.ts`
- Test: `src/cli/test-command.test.ts`

- [ ] **Step 1: Add `execution` and `appium` config types**

Add `execution?: { mode?: "local" | "appium"; appium?: ... }` to `ProvConfig`.

- [ ] **Step 2: Add CLI flags**

Parse:

- `--driver`
- `--appium-url`
- `--caps`
- `--caps-json`
- `--no-provider-reporting`

Wire them through `TestCommandOptions`.

- [ ] **Step 3: Add capabilities merge helper**

Create `src/runtime/capabilities.ts` to:

- load a capabilities file when present
- parse inline JSON caps
- merge config caps + file caps + CLI caps
- apply CLI overrides last

- [ ] **Step 4: Define failure rules**

Fail early when:

- `mode === "appium"` but no Appium URL is set
- both `--caps` and malformed `--caps-json` are passed
- local-only options are requested in Appium mode and cannot be honored

- [ ] **Step 5: Test parsing + merging**

Run:

```bash
cd packages/spana && bun test src/cli/test-command.test.ts
```

---

## Task 2: Extract runtime builders and centralize cleanup

**Files:**

- Create: `src/runtime/types.ts`
- Create: `src/runtime/local.ts`
- Modify: `src/cli/test-command.ts`
- Modify: `src/drivers/raw-driver.ts`
- Test: `src/cli/test-command.test.ts`

- [ ] **Step 1: Add `RuntimeHandle`**

Create `src/runtime/types.ts` with `{ driver, cleanup, metadata }`.

- [ ] **Step 2: Move current local setup into builders**

Extract:

- web runtime builder
- local Android runtime builder
- local iOS simulator runtime builder
- local iOS physical-device runtime builder

from `test-command.ts` into `src/runtime/local.ts`.

- [ ] **Step 3: Make cleanup explicit**

`runTestCommand()` should register every runtime cleanup and always dispose them in a final cleanup block, even if orchestration/reporting fails.

- [ ] **Step 4: Add driver cleanup contract only if needed**

If runtime-level cleanup is sufficient, keep `RawDriverService` unchanged. If driver-owned sessions need explicit disconnect, add a narrow cleanup method instead of leaking process ownership back into the CLI.

- [ ] **Step 5: Keep behavior identical in local mode**

This refactor should not change current local test behavior beyond cleanup correctness.

- [ ] **Step 6: Run tests**

Run:

```bash
cd packages/spana && bun test src/cli/test-command.test.ts
```

---

## Task 3: Add generic Appium client and Android Appium mode

**Files:**

- Create: `src/drivers/appium/client.ts`
- Create: `src/drivers/appium/android.ts`
- Create: `src/drivers/appium/client.test.ts`
- Create: `src/drivers/appium/android.test.ts`
- Modify: `src/runtime/appium.ts`

- [ ] **Step 1: Create a shared Appium session client**

The client should:

- create/delete sessions
- expose `sessionId`
- expose merged session capabilities
- make generic W3C requests
- support Appium extension endpoints used by Android/iOS drivers

- [ ] **Step 2: Implement Android raw driver on top of Appium**

Support at minimum:

- hierarchy/source
- screenshot
- window size / device info
- tap/double tap/long press/swipe
- text input
- back / hide keyboard
- activate / terminate app

- [ ] **Step 3: Remove adb assumptions in Appium mode**

Do **not** use:

- `adbInstall`
- `adbClearApp`
- `adbLaunchApp`
- `adbOpenLink`
- adb port forwarding

when the execution mode is `appium`.

- [ ] **Step 4: Handle Android launch options explicitly**

Define Appium-mode behavior for:

- `clearState`
- `deepLink`
- `launchArguments`

If Appium/cloud support is incomplete for a given option, fail explicitly with a mode-specific error instead of silently ignoring it.

- [ ] **Step 5: Add mock-server tests**

Use a mocked Appium HTTP server to verify:

- capability payload shape
- session creation
- gesture/action requests
- app lifecycle calls
- error propagation

- [ ] **Step 6: Run tests**

Run:

```bash
cd packages/spana && bun test src/drivers/appium/client.test.ts src/drivers/appium/android.test.ts
```

---

## Task 4: Add iOS Appium mode

**Files:**

- Create: `src/drivers/appium/ios.ts`
- Create: `src/drivers/appium/ios.test.ts`
- Modify: `src/runtime/appium.ts`

- [ ] **Step 1: Implement iOS raw driver via Appium**

Support at minimum:

- hierarchy/source
- screenshot
- window size / device info
- tap/double tap/long press/swipe
- text input
- launch / activate / terminate app
- open URL / deep link when supported by the Appium driver/provider

- [ ] **Step 2: Do not depend on local iOS tooling**

Do **not** call:

- `xcrun simctl`
- `iproxy`
- local WDA build/start helpers

in Appium mode.

- [ ] **Step 3: Define unsupported iOS behaviors**

Document and explicitly reject features that are simulator-only or local-only in v1, for example:

- `clearKeychain`
- simulator privacy reset
- manual WDA re-sign/build workflows

- [ ] **Step 4: Match error quality**

Errors from Appium iOS mode should still surface clean Spana errors, not raw provider payloads only.

- [ ] **Step 5: Run tests**

Run:

```bash
cd packages/spana && bun test src/drivers/appium/ios.test.ts
```

---

## Task 5: Add provider detection + result reporting (maestro-runner style)

**Files:**

- Create: `src/cloud/provider.ts`
- Create: `src/cloud/browserstack.ts`
- Create: `src/cloud/saucelabs.ts`
- Create: `src/cloud/*.test.ts`
- Modify: `src/cli/test-command.ts`
- Optional: `src/report/types.ts`

- [ ] **Step 1: Create provider registry**

Mirror the lightweight `maestro-runner` pattern:

```typescript
interface CloudProvider {
  name(): string;
  extractMeta(sessionId: string, caps: Record<string, unknown>, meta: Record<string, string>): void;
  reportResult(
    appiumUrl: string,
    meta: Record<string, string>,
    result: ProviderRunResult,
  ): Promise<void>;
}
```

- [ ] **Step 2: Detect provider from Appium URL**

Start with:

- BrowserStack
- Sauce Labs

Leave room for:

- LambdaTest
- TestingBot

- [ ] **Step 3: Capture session metadata after session creation**

Store provider/session metadata on the runtime handle so `test-command.ts` can report after orchestration completes.

- [ ] **Step 4: Report final pass/fail after reporter generation**

`test-command.ts` already has the final run result. After local reporters finish, call provider reporting. If provider reporting fails, log a warning but do not fail the local run.

- [ ] **Step 5: Keep provider logic thin**

Provider code should not:

- upload apps
- provision devices
- start tunnels

It should only:

- detect
- extract metadata
- report final result

- [ ] **Step 6: Run tests**

Run:

```bash
cd packages/spana && bun test src/cloud/provider.test.ts src/cloud/browserstack.test.ts src/cloud/saucelabs.test.ts
```

---

## Task 6: BrowserStack-first docs, examples, and validation

**Files:**

- Modify: `README.md`
- Modify: docs under `apps/docs/src/content/docs/`
- Create: example caps JSON files if the repo wants checked-in examples
- Optional: CI example snippets under `docs/`

- [ ] **Step 1: Document the product boundary clearly**

Explain that Spana uses **Appium cloud mode** for BrowserStack/Sauce, not the BrowserStack Maestro upload API.

- [ ] **Step 2: Add BrowserStack example**

Document:

- BrowserStack Appium hub URL
- `bs://...` uploaded app IDs
- sample Android caps
- sample iOS caps
- BrowserStack Local as an external prerequisite when needed

- [ ] **Step 3: Add Sauce Labs example**

Document the same pattern for Sauce Labs to show the mode is generic, not BrowserStack-only.

- [ ] **Step 4: Add manual smoke checklist**

Minimum manual validation:

1. Self-hosted Appium Android session
2. BrowserStack Android real-device session
3. Sauce Labs iOS simulator or real-device session

- [ ] **Step 5: Update roadmap/docs references when shipped**

Close the roadmap item only after the BrowserStack path is documented and manually proven.

---

## Suggested implementation order

1. Task 1 — config + CLI + capability merging
2. Task 2 — runtime extraction + cleanup
3. Task 3 — Android Appium mode
4. Task 4 — iOS Appium mode
5. Task 5 — provider detection/reporting
6. Task 6 — docs/examples/manual validation

### Dependencies

- Task 2 depends on Task 1
- Tasks 3 and 4 depend on Task 2
- Task 5 depends on at least one working Appium runtime
- Task 6 depends on the shipped user-facing behavior

---

## Success criteria

- `spana test` can run existing Spana flows against an external Appium hub
- BrowserStack Appium sessions can run at least one Android Spana smoke flow
- Sauce or equivalent remote iOS Appium session can run at least one iOS Spana smoke flow
- Local mode remains the default and keeps existing behavior
- Cleanup is centralized instead of spread across inline setup branches
- Provider reporting failures never hide local test results

---

## Nice-to-have follow-ups after this plan

- Reuse Appium runtimes in `agent/session.ts`
- Surface cloud session URLs in HTML/JSON reports
- Add LambdaTest and TestingBot provider adapters
- Add automated BrowserStack Local / Sauce Connect lifecycle management
- Add cloud device listing / discovery UX in Studio
