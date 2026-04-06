# Maestro-runner comparison handoff

## Scope

Compare the sibling repo `/Users/anton/.superset/projects/maestro-runner` with Spana (`/Users/anton/.superset/projects/spana`) and identify ideas Spana should consider borrowing.

This note currently contains:

1. A completed comparison of app/device/browser lifecycle handling.
2. An in-progress broader survey of other maestro-runner features worth studying.

## Lifecycle comparison: current conclusions

### 1. Resource ownership and teardown are much stronger in maestro-runner

- **Maestro-runner**
  - Driver creation returns cleanup functions and the CLI registers them for normal exit and signal cleanup.
  - Relevant files:
    - `maestro-runner/pkg/cli/test.go`
    - `maestro-runner/pkg/cli/web.go`
    - `maestro-runner/pkg/cli/android.go`
    - `maestro-runner/pkg/cli/ios.go`
- **Spana**
  - Platform setup is inline in `spana/packages/spana/src/cli/test-command.ts`.
  - `RawDriverService` has no cleanup/dispose contract.
  - Playwright, WDA, adb forwarding, and physical-device tunnel cleanup are not owned centrally.
  - Relevant files:
    - `spana/packages/spana/src/cli/test-command.ts`
    - `spana/packages/spana/src/drivers/raw-driver.ts`
    - `spana/packages/spana/src/drivers/playwright.ts`
    - `spana/packages/spana/src/drivers/wda/installer.ts`
    - `spana/packages/spana/src/device/ios.ts`
- **Recommendation**
  - Introduce a runtime handle abstraction like `{ driver, cleanup, metadata }`.
  - Make CLI, Studio, and agent sessions always dispose owned resources.

### 2. Startup is manager-driven in maestro-runner but ad hoc in Spana

- **Maestro-runner**
  - Tracks emulators/simulators it started and can shut them down later.
  - Uses dedicated managers and a per-device WDA runner.
  - Relevant files:
    - `maestro-runner/pkg/emulator/manager.go`
    - `maestro-runner/pkg/simulator/manager.go`
    - `maestro-runner/pkg/driver/wda/runner.go`
- **Spana**
  - Uses helper functions directly during `spana test`.
  - WDA startup is backed by a module-global `wdaProcess`.
  - Relevant files:
    - `spana/packages/spana/src/device/android.ts`
    - `spana/packages/spana/src/device/ios.ts`
    - `spana/packages/spana/src/drivers/uiautomator2/installer.ts`
    - `spana/packages/spana/src/drivers/wda/installer.ts`
- **Recommendation**
  - Replace inline startup with explicit Android/iOS runtime managers.
  - Avoid module-global WDA process state.

### 3. Device discovery and actual selection are inconsistent in Spana

- **Maestro-runner**
  - Supports explicit `--device`.
  - Validates device availability and tries to avoid devices already in use.
  - Relevant files:
    - `maestro-runner/pkg/cli/cli.go`
    - `maestro-runner/pkg/cli/test.go`
    - `maestro-runner/pkg/cli/android.go`
    - `maestro-runner/pkg/cli/ios.go`
- **Spana**
  - No explicit device-targeting flag in the CLI.
  - `discoverDevices()` only lists booted iOS simulators, but the test path actually prefers a connected physical iOS device first and can boot a shutdown simulator.
  - Studio uses the same incomplete discovery API.
  - Relevant files:
    - `spana/packages/spana/src/device/discover.ts`
    - `spana/packages/spana/src/cli/index.ts`
    - `spana/packages/spana/src/cli/test-command.ts`
    - `spana/packages/spana/src/studio/routers/devices.ts`
- **Recommendation**
  - Unify discovery, selection, and execution targeting.
  - Add explicit device targeting and make Studio/device listing reflect reality.

### 4. Maestro-runner is safer about port allocation and instance isolation

- **Maestro-runner**
  - Uses deterministic per-device WDA ports and busy-device checks.
  - Relevant files:
    - `maestro-runner/pkg/driver/wda/runner.go`
    - `maestro-runner/pkg/cli/test.go`
    - `maestro-runner/pkg/device/android.go`
- **Spana**
  - Picks random ports in `test-command.ts`.
  - `setupUiAutomator2()` clears all adb forwards for the device with `forward --remove-all`.
  - Relevant files:
    - `spana/packages/spana/src/cli/test-command.ts`
    - `spana/packages/spana/src/drivers/uiautomator2/installer.ts`
- **Recommendation**
  - Move to deterministic or tracked port allocation.
  - Clean up only the forwards Spana created.
  - Add busy-resource detection before starting drivers.

### 5. Spana's documented launch options are ahead of its implementation

- **Spana**
  - `LaunchOptions` and docs advertise `clearState`, `clearKeychain`, `deepLink`, and `launchArguments`.
  - `app.launch()` currently only exposes `{ deepLink?: string }`.
  - `engine.ts` auto-launches with no launch options.
  - Android and iOS drivers only really implement deep-link handling.
  - Relevant files:
    - `spana/packages/spana/src/schemas/config.ts`
    - `spana/apps/docs/src/content/docs/getting-started/configuration.md`
    - `spana/packages/spana/src/api/app.ts`
    - `spana/packages/spana/src/core/engine.ts`
    - `spana/packages/spana/src/drivers/uiautomator2/driver.ts`
    - `spana/packages/spana/src/drivers/wda/driver.ts`
- **Maestro-runner**
  - Implements richer launch behavior at the driver layer, including clear-state handling, arguments/env, and session-aware relaunch logic.
  - Relevant files:
    - `maestro-runner/pkg/driver/uiautomator2/commands.go`
    - `maestro-runner/pkg/driver/wda/commands.go`
- **Recommendation**
  - Wire LaunchOptions through the whole stack.
  - Highest-value items: `clearState`, `launchArguments`, and iOS/Android launch parity.

### 6. Browser lifecycle/config is much more mature in maestro-runner

- **Maestro-runner**
  - Supports headed mode, browser selection, one-time browser ensure/download, and explicit close.
  - Relevant files:
    - `maestro-runner/pkg/cli/test.go`
    - `maestro-runner/pkg/cli/web.go`
    - `maestro-runner/pkg/driver/browser/cdp/driver.go`
- **Spana**
  - Always launches Playwright Chromium headless from the test command.
  - No cleanup contract around browser lifetime.
  - Relevant files:
    - `spana/packages/spana/src/cli/test-command.ts`
    - `spana/packages/spana/src/drivers/playwright.ts`
- **Recommendation**
  - Add browser runtime config and teardown, especially if web is a first-class platform for Spana.

## Priority order for Spana follow-up

1. **Introduce runtime ownership + cleanup**
   - This is the biggest structural gap and improves correctness across CLI, Studio, and agent use.
2. **Fix port/resource isolation**
   - Deterministic ports, no broad adb forward removal, and busy-resource checks.
3. **Unify device discovery and explicit targeting**
   - Current listing and actual execution behavior do not match.
4. **Implement LaunchOptions end-to-end**
   - The docs already promise more than the runtime currently delivers.
5. **Improve browser runtime management**
   - Headed mode, browser selection, and proper disposal are likely the best first web improvements.

## Broader maestro-runner inspiration survey

The items below exclude the startup/cleanup/device-selection lifecycle topics covered above.

### High-value inspiration areas

1. **Advanced web/browser workflow APIs**
   - **Maestro-runner**
     - Exposes first-class browser steps for cookies/auth state, uploads/downloads, tabs, console logs, JS error assertions, and network mocking/blocking/throttling.
     - Relevant files:
       - `maestro-runner/pkg/flow/step.go`
       - `maestro-runner/pkg/driver/browser/cdp/commands.go`
   - **Spana**
     - The Playwright driver currently covers navigation, actions, screenshots, and `evaluate()`, but repo search found no equivalents for cookies, auth-state persistence, downloads, tab APIs, console capture, or network mocking.
     - Relevant files:
       - `spana/packages/spana/src/drivers/playwright.ts`
   - **Why it matters**
     - This is the clearest non-lifecycle feature gap between the two repos for web testing.

2. **Driver-level stability knobs**
   - **Maestro-runner**
     - Threads `waitForIdleTimeout` and `typingFrequency` from workspace config/CLI/flow config down into platform drivers.
     - Relevant files:
       - `maestro-runner/pkg/config/config.go`
       - `maestro-runner/pkg/executor/flow_runner.go`
       - `maestro-runner/pkg/driver/wda/driver.go`
       - `maestro-runner/pkg/driver/uiautomator2/driver.go`
   - **Spana**
     - Has generic wait/poll defaults, but no comparable per-flow driver tuning surface.
     - WDA currently hardcodes idle-related settings inside the client/session layer.
     - Relevant files:
       - `spana/packages/spana/src/core/engine.ts`
       - `spana/packages/spana/src/schemas/config.ts`
       - `spana/packages/spana/src/drivers/wda/client.ts`
   - **Why it matters**
     - These settings are practical flake-reduction tools, especially for animated or slower mobile apps.

3. **Reporting pipeline and richer failure model**
   - **Maestro-runner**
     - Adds Allure output and a richer error schema with typed failures plus optional suggestions.
     - Relevant files:
       - `maestro-runner/pkg/report/allure.go`
       - `maestro-runner/pkg/report/types.go`
   - **Spana**
     - Already has console/json/junit/html reporters, but the report model is simpler and does not carry typed failure categories or suggestions.
     - Relevant files:
       - `spana/packages/spana/src/report/types.ts`
       - `spana/packages/spana/src/report/html.ts`
   - **Why it matters**
     - Better CI/dashboard integrations and more actionable failure analysis.

4. **Multi-device parallel execution wired end-to-end**
   - **Maestro-runner**
     - Uses a device-worker work queue and wires it into the CLI plus device-aware output/reporting.
     - Relevant files:
       - `maestro-runner/pkg/executor/parallel.go`
       - `maestro-runner/pkg/cli/test.go`
       - `maestro-runner/pkg/cli/test_unified_output.go`
   - **Spana**
     - Already has a generic queue-based parallel runner, but it is not currently wired into `spana test` device/browser execution.
     - Relevant files:
       - `spana/packages/spana/src/core/parallel.ts`
       - `spana/packages/spana/src/core/orchestrator.ts`
       - `spana/packages/spana/src/cli/test-command.ts`
   - **Why it matters**
     - Spana already has some of the internal structure, so this is a realistic next step rather than a greenfield idea.

5. **Hybrid/WebView support**
   - **Maestro-runner**
     - The DeviceLab driver can connect into Android WebViews over CDP and bridge native + web contexts.
     - Relevant files:
       - `maestro-runner/pkg/driver/devicelab/webview.go`
       - `maestro-runner/pkg/cli/android.go`
   - **Spana**
     - Currently has separate native and web drivers with no WebView/hybrid bridge.
     - Repo search found no equivalent support under `packages/spana/src`.
   - **Why it matters**
     - Strategically valuable if Spana wants React Native apps with embedded web surfaces to be first-class.

### Medium-value / selective borrowing

6. **Implemented flow hooks and runtime variable helpers**
   - **Maestro-runner**
     - Supports parsed and executed `onFlowStart` / `onFlowComplete` hooks plus `defineVariables`, `runScript`, `evalScript`, and `assertCondition`.
     - Relevant files:
       - `maestro-runner/pkg/flow/flow.go`
       - `maestro-runner/pkg/flow/parser.go`
       - `maestro-runner/pkg/executor/flow_runner.go`
       - `maestro-runner/pkg/executor/scripting.go`
   - **Spana**
     - The config schema declares `beforeAll`, `beforeEach`, `afterEach`, and `afterAll`, but the current test command does not invoke them.
     - Relevant files:
       - `spana/packages/spana/src/schemas/config.ts`
       - `spana/packages/spana/src/cli/test-command.ts`
   - **Why it matters**
     - Good inspiration for implementing hooks.
     - The full YAML/JS scripting DSL is probably **not** a direct fit for Spana’s TypeScript-native direction.

7. **Workspace execution config and precedence**
   - **Maestro-runner**
     - Has a dedicated workspace config with execution settings (`appId`, env, platform, device, include/exclude tags, wait-for-idle) and explicitly documented precedence in the executor.
     - Relevant files:
       - `maestro-runner/pkg/config/config.go`
       - `maestro-runner/pkg/executor/flow_runner.go`
       - `maestro-runner/pkg/validator/validator.go`
   - **Spana**
     - `spana.config.ts` handles app/reporter/defaults/artifacts/platforms, but not the same breadth of execution-level settings or precedence docs.
     - Relevant files:
       - `spana/packages/spana/src/schemas/config.ts`
       - `spana/packages/spana/src/cli/test-command.ts`
   - **Why it matters**
     - Better predictability for CI usage and shared team defaults.

8. **Unified device-aware CLI output**
   - **Maestro-runner**
     - Uses structured report data to print detailed per-flow output and per-device summaries.
     - Relevant files:
       - `maestro-runner/pkg/cli/test_unified_output.go`
   - **Spana**
     - The console reporter is clean but simpler and not tied to device-worker execution.
     - Relevant files:
       - `spana/packages/spana/src/report/console.ts`
   - **Why it matters**
     - Lower priority by itself, but becomes more valuable once Spana gains true multi-device execution.

### Probably not worth copying directly

- **Full Appium capabilities / cloud-provider surface**
  - Relevant maestro-runner areas:
    - `maestro-runner/pkg/driver/appium`
    - `maestro-runner/pkg/cloud`
  - Only worth copying if Spana explicitly decides to support BrowserStack/SauceLabs-style remote execution.

- **The full YAML/JS scripting DSL**
  - Spana’s TypeScript-native flow model is a differentiator.
  - Borrow the good ideas (hooks, variable precedence, condition helpers), not the whole syntax surface.

### Suggested sequence after lifecycle work

1. Advanced web/browser APIs
2. Driver-level stability knobs
3. Reporting/error-model upgrades
4. End-to-end multi-device parallel wiring
5. Hook implementation inspired by maestro-runner’s flow hooks
6. Hybrid/WebView support
