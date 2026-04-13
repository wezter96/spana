# Cross-Platform Network Conditions

Extend `setNetworkConditions` from web-only to all platforms: Android emulator/device, iOS simulator/device, and Appium cloud providers. Unified API with graceful degradation per platform.

## Motivation

Mobile network simulation is a gap users can't work around from test code. Web already has `setNetworkConditions` via CDP, but mobile drivers have nothing. Users need to test offline fallback, slow network degraded UX, and reconnection flows on mobile — the most common environment for flaky networks.

## Type Changes

Rename `BrowserNetworkConditions` → `NetworkConditions`. Add preset `profile` field. Fully backwards compatible.

```typescript
export type NetworkProfile =
  | "wifi" // ~30Mbps down, 15Mbps up, 2ms latency
  | "4g" // ~20Mbps down, 10Mbps up, 20ms latency
  | "3g" // ~1.5Mbps down, 750Kbps up, 100ms latency
  | "2g" // ~280Kbps down, 256Kbps up, 300ms latency
  | "edge" // ~240Kbps down, 200Kbps up, 400ms latency
  | "offline"; // Sugar for { offline: true }

export interface NetworkConditions {
  /** Preset profile. Overrides latency/throughput fields if both provided. */
  profile?: NetworkProfile;
  offline?: boolean;
  latencyMs?: number;
  downloadThroughputKbps?: number;
  uploadThroughputKbps?: number;
}
```

`BrowserNetworkConditions` becomes a deprecated type alias for `NetworkConditions`.

### Resolution Rules

1. `profile` set → resolve to preset values from lookup table
2. Custom values only → use directly with defaults (offline=false, latency=0, throughput=unlimited)
3. Both `profile` and custom values → `profile` wins

## Profile Resolution (Shared)

New file `drivers/network-profiles.ts`. Single `resolveNetworkConditions()` function used by all drivers.

```typescript
export interface ResolvedNetworkConditions {
  offline: boolean;
  latencyMs: number;
  downloadThroughputKbps: number;
  uploadThroughputKbps: number;
}

const PROFILES: Record<NetworkProfile, ResolvedNetworkConditions> = {
  wifi: {
    offline: false,
    latencyMs: 2,
    downloadThroughputKbps: 30_000,
    uploadThroughputKbps: 15_000,
  },
  "4g": {
    offline: false,
    latencyMs: 20,
    downloadThroughputKbps: 20_000,
    uploadThroughputKbps: 10_000,
  },
  "3g": {
    offline: false,
    latencyMs: 100,
    downloadThroughputKbps: 1_500,
    uploadThroughputKbps: 750,
  },
  "2g": { offline: false, latencyMs: 300, downloadThroughputKbps: 280, uploadThroughputKbps: 256 },
  edge: { offline: false, latencyMs: 400, downloadThroughputKbps: 240, uploadThroughputKbps: 200 },
  offline: { offline: true, latencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 },
};
```

Platform-specific mapping tables (Spana profile → ADB preset, Spana profile → BrowserStack profile) live in their respective driver files.

## Driver Interface

No new methods on `RawDriverService`. `setNetworkConditions` stays optional, same signature — accepts the wider `NetworkConditions` type (superset of old `BrowserNetworkConditions`).

## Platform Implementations

### Web (Playwright) — already implemented

Existing CDP path. Add profile resolution before passing to CDP. No behavioral changes.

- Profile → resolve to values → existing `applyNetworkConditions()` flow
- Chromium: full latency/throughput control
- Firefox/WebKit: offline only (existing behavior)

### Android Emulator (UiAutomator2)

Uses `serial` already available in the driver constructor. New helpers in `device/android.ts`:

- **Offline**: `adb -s {serial} shell svc wifi disable && svc data disable`
- **Online**: reverse
- **Profiles**: `adb -s {serial} emu network speed {preset}` + `adb emu network delay {preset}`
  - ADB preset mapping: `"2g"→"gprs"`, `"edge"→"edge"`, `"3g"→"umts"`, `"4g"→"lte"`, `"wifi"→"full"`
  - Custom values: `adb emu network speed {down}:{up}` (kbps), `adb emu network delay {min}:{max}` (ms)
- **Detection**: `serial.startsWith("emulator-")` — if true, throttling supported

### Android Real Device (UiAutomator2)

- **Offline**: `adb -s {serial} shell cmd connectivity airplane-mode enable`
- **Online**: `airplane-mode disable`
- **Profiles**: Throw `DriverError` — throttling not supported on physical devices without root

### iOS Simulator (WDA)

iOS simulators share the host Mac's network stack — there's no per-simulator network isolation.

- **Offline**: `networksetup -setairportpower en0 off` toggles WiFi on the host. Broad but reliable. Alternative: `pfctl` anchor rule to drop all outbound traffic — affects the whole Mac but is reversible and doesn't require Wi-Fi hardware. Best approach TBD during implementation based on CI compatibility testing.
- **Profiles**: `dnctl pipe 1 config bw {kbps}Kbit/s delay {ms}ms` + `pfctl` anchor to route all traffic through the pipe. Affects entire Mac network (acceptable in CI, less so for local dev). Requires sudo.
- **Fallback**: If not running with sudo/elevated permissions, throw clear error explaining the requirement. No partial offline-only fallback — better to fail clearly than silently affect the host machine.

### iOS Real Device (WDA)

- **Offline/Profiles**: Throw `DriverError` with guidance to use cloud providers. No reliable programmatic network control on physical iOS devices.

### Appium Cloud (Android + iOS)

- **BrowserStack**: `driver.execute('browserstack_executor', { action: 'setNetworkProfile', arguments: { profile } })`
  - Mapping: `"2g"→"2g-lossy"`, `"3g"→"3g-lossy"`, `"4g"→"4g-lossy"`, `"wifi"→"reset"`, `"offline"→"airplane-mode"`
- **SauceLabs**: `mobile:setNetworkConditions` with `{ downloadSpeed, uploadSpeed, latency }`
- **Generic**: W3C-standard `mobile:setNetworkConditions` if available
- **Detection**: Optional `cloudProvider?: "browserstack" | "saucelabs" | "generic"` in Appium driver config

## Capability Matrix

| Platform             | Offline    | Profiles   | Custom values | Mechanism                  |
| -------------------- | ---------- | ---------- | ------------- | -------------------------- |
| Web (Chromium)       | Yes        | Yes        | Yes           | CDP                        |
| Web (Firefox/WebKit) | Yes        | No         | No            | context.setOffline()       |
| Android emulator     | Yes        | Yes        | Yes           | adb emu network            |
| Android real device  | Yes        | No         | No            | adb shell airplane-mode    |
| iOS simulator        | Yes (sudo) | Yes (sudo) | Yes (sudo)    | pfctl/dnctl on host Mac    |
| iOS real device      | No         | No         | No            | Not supported              |
| Appium cloud         | Yes        | Yes        | Varies        | Provider executor commands |

## Error Handling

Three error scenarios, all include actionable guidance:

1. **Platform doesn't support throttling**: Tell user to use emulator or cloud provider. Mention offline toggle works.
2. **iOS simulator without elevated permissions**: Explain pfctl requires sudo. Offline toggle available.
3. **Cloud provider doesn't recognize profile**: List supported profiles.

## Reset & Cleanup

- `setNetworkConditions({ profile: "wifi" })` or `setNetworkConditions({})` restores normal connectivity
- Android emulator: `adb emu network speed full` + `adb emu network delay none`
- Drivers restore network state automatically on disconnect — prevents test isolation leaks

## Files Changed

| File                             | Change                                                        |
| -------------------------------- | ------------------------------------------------------------- |
| `drivers/raw-driver.ts`          | Rename type, add `NetworkProfile`, update `NetworkConditions` |
| `drivers/network-profiles.ts`    | New — shared profile resolution                               |
| `drivers/playwright.ts`          | Add profile resolution before existing CDP path               |
| `drivers/uiautomator2/driver.ts` | Add `setNetworkConditions` implementation                     |
| `drivers/wda/driver.ts`          | Add `setNetworkConditions` implementation                     |
| `drivers/appium/android.ts`      | Add `setNetworkConditions` implementation                     |
| `drivers/appium/ios.ts`          | Add `setNetworkConditions` implementation                     |
| `device/android.ts`              | Add network control helpers (adb wifi/data/airplane/emu)      |
| `device/ios.ts`                  | Add pfctl/dnctl helpers for simulator network control         |
| `api/app.ts`                     | No changes — optionalMethod already handles it                |
| `agent/session.ts`               | No changes — already delegates to driver                      |

## Testing

- Unit tests for `resolveNetworkConditions()` — profile resolution, custom values, precedence
- Unit tests per driver — mock adb/simctl/appium calls, verify correct commands issued
- Integration tests where feasible — Android emulator offline toggle in CI
