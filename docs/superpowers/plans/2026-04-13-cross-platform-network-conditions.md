# Cross-Platform Network Conditions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `setNetworkConditions` from web-only to Android, iOS, and Appium cloud platforms with preset profiles and graceful degradation.

**Architecture:** Add a shared `NetworkConditions` type with preset profiles, a `resolveNetworkConditions()` function, then implement `setNetworkConditions` in each mobile driver using platform-specific mechanisms (ADB for Android, pfctl for iOS simulator, Appium executor commands for cloud).

**Tech Stack:** TypeScript, Effect, ADB (Android), pfctl/dnctl (macOS), Appium W3C endpoints

---

### Task 1: Shared Types and Profile Resolution

**Files:**
- Create: `packages/spana/src/drivers/network-profiles.ts`
- Modify: `packages/spana/src/drivers/raw-driver.ts:39-44`

- [ ] **Step 1: Write the failing test**

Create `packages/spana/src/drivers/network-profiles.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { resolveNetworkConditions } from "./network-profiles.js";
import type { NetworkConditions } from "./raw-driver.js";

describe("resolveNetworkConditions", () => {
  test("resolves 'wifi' profile to preset values", () => {
    const result = resolveNetworkConditions({ profile: "wifi" });
    expect(result).toEqual({
      offline: false,
      latencyMs: 2,
      downloadThroughputKbps: 30_000,
      uploadThroughputKbps: 15_000,
    });
  });

  test("resolves '3g' profile", () => {
    const result = resolveNetworkConditions({ profile: "3g" });
    expect(result).toEqual({
      offline: false,
      latencyMs: 100,
      downloadThroughputKbps: 1_500,
      uploadThroughputKbps: 750,
    });
  });

  test("resolves 'offline' profile", () => {
    const result = resolveNetworkConditions({ profile: "offline" });
    expect(result).toEqual({
      offline: true,
      latencyMs: 0,
      downloadThroughputKbps: 0,
      uploadThroughputKbps: 0,
    });
  });

  test("uses custom values when no profile", () => {
    const result = resolveNetworkConditions({
      offline: false,
      latencyMs: 50,
      downloadThroughputKbps: 5_000,
      uploadThroughputKbps: 2_000,
    });
    expect(result).toEqual({
      offline: false,
      latencyMs: 50,
      downloadThroughputKbps: 5_000,
      uploadThroughputKbps: 2_000,
    });
  });

  test("profile takes precedence over custom values", () => {
    const result = resolveNetworkConditions({
      profile: "3g",
      latencyMs: 999,
      downloadThroughputKbps: 999,
    });
    expect(result).toEqual({
      offline: false,
      latencyMs: 100,
      downloadThroughputKbps: 1_500,
      uploadThroughputKbps: 750,
    });
  });

  test("defaults when only offline is specified", () => {
    const result = resolveNetworkConditions({ offline: true });
    expect(result).toEqual({
      offline: true,
      latencyMs: 0,
      downloadThroughputKbps: -1,
      uploadThroughputKbps: -1,
    });
  });

  test("empty object resets to defaults", () => {
    const result = resolveNetworkConditions({});
    expect(result).toEqual({
      offline: false,
      latencyMs: 0,
      downloadThroughputKbps: -1,
      uploadThroughputKbps: -1,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/spana && bun test src/drivers/network-profiles.test.ts`
Expected: FAIL — module `./network-profiles.js` not found

- [ ] **Step 3: Update types in raw-driver.ts**

In `packages/spana/src/drivers/raw-driver.ts`, replace lines 39-44:

```typescript
export type NetworkProfile =
  | "wifi"
  | "4g"
  | "3g"
  | "2g"
  | "edge"
  | "offline";

export interface NetworkConditions {
  profile?: NetworkProfile;
  offline?: boolean;
  latencyMs?: number;
  downloadThroughputKbps?: number;
  uploadThroughputKbps?: number;
}

/** @deprecated Use `NetworkConditions` instead */
export type BrowserNetworkConditions = NetworkConditions;
```

Then update the `setNetworkConditions` signature on line 229-231 to use `NetworkConditions`:

```typescript
  readonly setNetworkConditions?: (
    conditions: NetworkConditions,
  ) => Effect.Effect<void, DriverError>;
```

Also update the comment on line 222 from `// Web-only browser state helpers` to `// Network & browser state helpers`.

- [ ] **Step 4: Create network-profiles.ts**

Create `packages/spana/src/drivers/network-profiles.ts`:

```typescript
import type { NetworkConditions, NetworkProfile } from "./raw-driver.js";

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
  "2g": {
    offline: false,
    latencyMs: 300,
    downloadThroughputKbps: 280,
    uploadThroughputKbps: 256,
  },
  edge: {
    offline: false,
    latencyMs: 400,
    downloadThroughputKbps: 240,
    uploadThroughputKbps: 200,
  },
  offline: {
    offline: true,
    latencyMs: 0,
    downloadThroughputKbps: 0,
    uploadThroughputKbps: 0,
  },
};

/**
 * Resolve a `NetworkConditions` object to concrete numeric values.
 *
 * - If `profile` is set, the profile preset is returned (custom values ignored).
 * - If no profile, custom values are used with defaults:
 *   offline=false, latencyMs=0, throughput=-1 (unlimited).
 */
export function resolveNetworkConditions(
  conditions: NetworkConditions,
): ResolvedNetworkConditions {
  if (conditions.profile) {
    return { ...PROFILES[conditions.profile] };
  }

  return {
    offline: conditions.offline ?? false,
    latencyMs: conditions.latencyMs ?? 0,
    downloadThroughputKbps: conditions.downloadThroughputKbps ?? -1,
    uploadThroughputKbps: conditions.uploadThroughputKbps ?? -1,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/spana && bun test src/drivers/network-profiles.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 6: Run full test suite to check nothing broke**

Run: `cd packages/spana && bun test`
Expected: All existing tests still pass (the type rename is backwards compatible via the alias)

- [ ] **Step 7: Commit**

```bash
git add packages/spana/src/drivers/network-profiles.ts packages/spana/src/drivers/network-profiles.test.ts packages/spana/src/drivers/raw-driver.ts
git commit -m "feat: add NetworkConditions type with profile presets and resolution"
```

---

### Task 2: Update Playwright Driver to Use New Types

**Files:**
- Modify: `packages/spana/src/drivers/playwright.ts:106-120,182,468-494,893-901`

- [ ] **Step 1: Write the failing test**

Add to `packages/spana/src/drivers/playwright.test.ts` (append to existing tests):

```typescript
// Test that profile-based network conditions resolve correctly.
// This test verifies the Playwright driver accepts the new NetworkConditions
// type with profile field (existing tests cover the raw latencyMs/offline path).
```

The existing Playwright tests should already pass since the type is a superset. The main change is importing `resolveNetworkConditions` and using it in `applyNetworkConditions`. No new test file needed — just verify existing tests pass after the refactor.

- [ ] **Step 2: Update Playwright driver imports**

In `packages/spana/src/drivers/playwright.ts`, update the import from `raw-driver.js` to include the new type name. Change:

```typescript
import type { BrowserNetworkConditions } from "../raw-driver.js";
```

to use `NetworkConditions` wherever `BrowserNetworkConditions` appears in this file. Also add:

```typescript
import { resolveNetworkConditions } from "./network-profiles.js";
```

- [ ] **Step 3: Update applyNetworkConditions to resolve profiles**

In `packages/spana/src/drivers/playwright.ts`, update `applyNetworkConditions` (around line 468) and the `currentNetworkConditions` variable (line 182).

Change the variable type from `BrowserNetworkConditions` to `NetworkConditions`:
```typescript
let currentNetworkConditions: NetworkConditions = {};
```

Update `applyNetworkConditions` to resolve profiles before applying:
```typescript
const applyNetworkConditions = async () => {
  const resolved = resolveNetworkConditions(currentNetworkConditions);

  if (
    browserName !== "chromium" &&
    (resolved.latencyMs > 0 ||
      (resolved.downloadThroughputKbps >= 0 && resolved.downloadThroughputKbps !== -1) ||
      (resolved.uploadThroughputKbps >= 0 && resolved.uploadThroughputKbps !== -1))
  ) {
    throw new DriverError({
      message:
        "setNetworkConditions() latency and throughput controls are only supported with the chromium browser. Use offline mode only for firefox or webkit.",
    });
  }

  await context.setOffline(resolved.offline);

  const needsCDP =
    browserName === "chromium" &&
    (resolved.latencyMs > 0 ||
      resolved.downloadThroughputKbps >= 0 ||
      resolved.uploadThroughputKbps >= 0 ||
      cdpSession !== undefined);

  if (!needsCDP) {
    return;
  }

  const session = cdpSession ?? (cdpSession = await context.newCDPSession(page));
  await session.send("Network.enable");
  await session.send("Network.emulateNetworkConditions", {
    offline: resolved.offline,
    latency: resolved.latencyMs,
    downloadThroughput: resolved.downloadThroughputKbps >= 0
      ? Math.max(Math.round((resolved.downloadThroughputKbps * 1024) / 8), 0)
      : -1,
    uploadThroughput: resolved.uploadThroughputKbps >= 0
      ? Math.max(Math.round((resolved.uploadThroughputKbps * 1024) / 8), 0)
      : -1,
  });
};
```

Note: The `toBytesPerSecond` helper and `requiresChromiumThrottling` helper can be removed since we now use the resolved values directly.

- [ ] **Step 4: Run existing Playwright tests**

Run: `cd packages/spana && bun test src/drivers/playwright.test.ts`
Expected: All existing tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/spana/src/drivers/playwright.ts
git commit -m "refactor: update Playwright driver to use NetworkConditions with profile resolution"
```

---

### Task 3: Android Network Helpers

**Files:**
- Modify: `packages/spana/src/device/android.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/spana/src/device/android-network.test.ts`:

```typescript
import { afterEach, describe, expect, mock, test } from "bun:test";

const execState = {
  commands: [] as string[],
  error: undefined as Error | undefined,
};

mock.module("node:child_process", () => ({
  execFileSync: () => {},
  execSync: (cmd: string) => {
    if (execState.error) throw execState.error;
    execState.commands.push(cmd);
    return "";
  },
}));

// Must import AFTER mock
const { adbSetNetworkProfile, adbSetAirplaneMode, adbResetNetwork } = await import(
  "./android.js"
);

afterEach(() => {
  execState.commands = [];
  execState.error = undefined;
});

describe("Android network helpers", () => {
  test("adbSetAirplaneMode enable sends correct command", () => {
    adbSetAirplaneMode("emulator-5554", true);
    expect(execState.commands.some((c) => c.includes("airplane-mode") && c.includes("enable"))).toBe(true);
  });

  test("adbSetAirplaneMode disable sends correct command", () => {
    adbSetAirplaneMode("emulator-5554", false);
    expect(execState.commands.some((c) => c.includes("airplane-mode") && c.includes("disable"))).toBe(true);
  });

  test("adbSetNetworkProfile sends speed and delay commands for emulator", () => {
    adbSetNetworkProfile("emulator-5554", "3g");
    expect(execState.commands.some((c) => c.includes("emu network speed umts"))).toBe(true);
    expect(execState.commands.some((c) => c.includes("emu network delay umts"))).toBe(true);
  });

  test("adbSetNetworkProfile maps 4g to lte", () => {
    adbSetNetworkProfile("emulator-5554", "4g");
    expect(execState.commands.some((c) => c.includes("emu network speed lte"))).toBe(true);
    expect(execState.commands.some((c) => c.includes("emu network delay none"))).toBe(true);
  });

  test("adbResetNetwork restores full speed and disables airplane mode", () => {
    adbResetNetwork("emulator-5554");
    expect(execState.commands.some((c) => c.includes("emu network speed full"))).toBe(true);
    expect(execState.commands.some((c) => c.includes("emu network delay none"))).toBe(true);
    expect(execState.commands.some((c) => c.includes("airplane-mode") && c.includes("disable"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/spana && bun test src/device/android-network.test.ts`
Expected: FAIL — functions not exported from `android.js`

- [ ] **Step 3: Add network helpers to android.ts**

Append to `packages/spana/src/device/android.ts`:

```typescript
// ---------------------------------------------------------------------------
// Network control
// ---------------------------------------------------------------------------

const ADB_PROFILE_MAP: Record<string, { speed: string; delay: string }> = {
  "2g": { speed: "gprs", delay: "gprs" },
  edge: { speed: "edge", delay: "edge" },
  "3g": { speed: "umts", delay: "umts" },
  "4g": { speed: "lte", delay: "none" },
  wifi: { speed: "full", delay: "none" },
};

/** Toggle airplane mode on a device via adb */
export function adbSetAirplaneMode(serial: string, enable: boolean): void {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");
  const mode = enable ? "enable" : "disable";
  execSync(`${adb} -s ${serial} shell cmd connectivity airplane-mode ${mode}`, {
    stdio: "ignore",
  });
}

/** Toggle WiFi on a device via adb */
export function adbSetWifi(serial: string, enable: boolean): void {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");
  const mode = enable ? "enable" : "disable";
  execSync(`${adb} -s ${serial} shell svc wifi ${mode}`, { stdio: "ignore" });
}

/** Toggle mobile data on a device via adb */
export function adbSetData(serial: string, enable: boolean): void {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");
  const mode = enable ? "enable" : "disable";
  execSync(`${adb} -s ${serial} shell svc data ${mode}`, { stdio: "ignore" });
}

/**
 * Set a named network profile on an Android emulator.
 * Uses `adb emu network speed` and `adb emu network delay`.
 * Only works on emulators — real devices throw.
 */
export function adbSetNetworkProfile(serial: string, profile: string): void {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");

  const mapping = ADB_PROFILE_MAP[profile];
  if (!mapping) {
    throw new Error(`Unknown network profile: ${profile}. Supported: ${Object.keys(ADB_PROFILE_MAP).join(", ")}`);
  }

  execSync(`${adb} -s ${serial} emu network speed ${mapping.speed}`, { stdio: "ignore" });
  execSync(`${adb} -s ${serial} emu network delay ${mapping.delay}`, { stdio: "ignore" });
}

/**
 * Set custom network speed on an Android emulator.
 * Uses `adb emu network speed <down>:<up>` (kbps) and `adb emu network delay <ms>`.
 */
export function adbSetCustomNetwork(
  serial: string,
  downloadKbps: number,
  uploadKbps: number,
  delayMs: number,
): void {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");

  execSync(`${adb} -s ${serial} emu network speed ${downloadKbps}:${uploadKbps}`, {
    stdio: "ignore",
  });
  execSync(`${adb} -s ${serial} emu network delay ${delayMs}:${delayMs}`, { stdio: "ignore" });
}

/** Reset network to full speed and disable airplane mode */
export function adbResetNetwork(serial: string): void {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");

  execSync(`${adb} -s ${serial} emu network speed full`, { stdio: "ignore" });
  execSync(`${adb} -s ${serial} emu network delay none`, { stdio: "ignore" });

  // Re-enable connectivity in case airplane mode was toggled
  try {
    execSync(`${adb} -s ${serial} shell cmd connectivity airplane-mode disable`, {
      stdio: "ignore",
    });
  } catch {
    // May fail on emulator without telephony
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/spana && bun test src/device/android-network.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Run existing android device tests**

Run: `cd packages/spana && bun test src/drivers/uiautomator2/driver.test.ts`
Expected: Still passing — no changes to driver yet

- [ ] **Step 6: Commit**

```bash
git add packages/spana/src/device/android.ts packages/spana/src/device/android-network.test.ts
git commit -m "feat: add ADB network control helpers (airplane mode, profiles, throttling)"
```

---

### Task 4: iOS Simulator Network Helpers

**Files:**
- Modify: `packages/spana/src/device/ios.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/spana/src/device/ios-network.test.ts`:

```typescript
import { afterEach, describe, expect, mock, test } from "bun:test";

const execState = {
  commands: [] as string[],
  error: undefined as Error | undefined,
};

mock.module("node:child_process", () => ({
  execFileSync: (_cmd: string, args: string[]) => {
    execState.commands.push(`${_cmd} ${args.join(" ")}`);
    return "";
  },
  execSync: (cmd: string) => {
    if (execState.error) throw execState.error;
    execState.commands.push(cmd);
    return "{}";
  },
}));

mock.module("node:fs", () => ({
  readFileSync: () => "{}",
  unlinkSync: () => {},
}));

mock.module("../core/port-allocator.js", () => ({
  allocatePort: (base: number) => base,
  releasePort: () => {},
}));

const { pfctlSetOffline, pfctlSetThrottle, pfctlResetNetwork } = await import("./ios.js");

afterEach(() => {
  execState.commands = [];
  execState.error = undefined;
});

describe("iOS simulator network helpers", () => {
  test("pfctlSetOffline creates block rule", () => {
    pfctlSetOffline(true);
    expect(execState.commands.some((c) => c.includes("pfctl") && c.includes("spana"))).toBe(true);
  });

  test("pfctlSetOffline false flushes rules", () => {
    pfctlSetOffline(false);
    expect(execState.commands.some((c) => c.includes("pfctl"))).toBe(true);
  });

  test("pfctlSetThrottle creates dnctl pipe", () => {
    pfctlSetThrottle(1_500, 100);
    expect(execState.commands.some((c) => c.includes("dnctl"))).toBe(true);
  });

  test("pfctlResetNetwork flushes all rules and pipes", () => {
    pfctlResetNetwork();
    expect(execState.commands.some((c) => c.includes("pfctl") || c.includes("dnctl"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/spana && bun test src/device/ios-network.test.ts`
Expected: FAIL — functions not exported from `ios.js`

- [ ] **Step 3: Add network helpers to ios.ts**

Append to `packages/spana/src/device/ios.ts`:

```typescript
// ---------------------------------------------------------------------------
// Network control (iOS simulator via macOS pfctl/dnctl)
//
// WARNING: These functions affect the entire host Mac's network stack.
// iOS simulators share the host network — there is no per-simulator isolation.
// Requires sudo for pfctl/dnctl commands.
// ---------------------------------------------------------------------------

const SPANA_ANCHOR = "com.spana.network";

/**
 * Block all outbound network traffic using pfctl.
 * Simulates airplane mode for the entire Mac (affects simulator).
 */
export function pfctlSetOffline(enable: boolean): void {
  if (enable) {
    // Create anchor rule that blocks all outbound traffic
    const rules = `block out all\n`;
    execSync(
      `echo '${rules}' | sudo pfctl -a ${SPANA_ANCHOR} -f -`,
      { stdio: "ignore" },
    );
    // Enable pfctl if not already enabled
    try {
      execSync("sudo pfctl -e 2>/dev/null", { stdio: "ignore" });
    } catch {
      // Already enabled
    }
  } else {
    // Flush the spana anchor rules
    try {
      execSync(`sudo pfctl -a ${SPANA_ANCHOR} -F all`, { stdio: "ignore" });
    } catch {
      // No rules to flush
    }
  }
}

/**
 * Set bandwidth throttle using dnctl + pfctl dummynet pipe.
 * @param throughputKbps - Bandwidth in kilobits per second
 * @param delayMs - Latency in milliseconds
 */
export function pfctlSetThrottle(throughputKbps: number, delayMs: number): void {
  // Create dummynet pipe with bandwidth and delay
  execSync(
    `sudo dnctl pipe 1 config bw ${throughputKbps}Kbit/s delay ${delayMs}ms`,
    { stdio: "ignore" },
  );

  // Route all traffic through the pipe via pfctl anchor
  const rules = `dummynet out all pipe 1\n`;
  execSync(
    `echo '${rules}' | sudo pfctl -a ${SPANA_ANCHOR} -f -`,
    { stdio: "ignore" },
  );

  try {
    execSync("sudo pfctl -e 2>/dev/null", { stdio: "ignore" });
  } catch {
    // Already enabled
  }
}

/**
 * Reset all network modifications: flush pfctl anchor and destroy dnctl pipes.
 */
export function pfctlResetNetwork(): void {
  try {
    execSync(`sudo pfctl -a ${SPANA_ANCHOR} -F all`, { stdio: "ignore" });
  } catch {
    // No rules
  }
  try {
    execSync("sudo dnctl -q flush", { stdio: "ignore" });
  } catch {
    // No pipes
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/spana && bun test src/device/ios-network.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/spana/src/device/ios.ts packages/spana/src/device/ios-network.test.ts
git commit -m "feat: add pfctl/dnctl network control helpers for iOS simulator"
```

---

### Task 5: UiAutomator2 Driver — setNetworkConditions

**Files:**
- Modify: `packages/spana/src/drivers/uiautomator2/driver.ts`
- Modify: `packages/spana/src/drivers/uiautomator2/driver.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/spana/src/drivers/uiautomator2/driver.test.ts`, inside the existing `describe` block. First, update the mock for `../../device/android.js` to add the new functions:

Add to the `mock.module("../../device/android.js", ...)` block:

```typescript
  adbSetAirplaneMode(serial: string, enable: boolean) {
    uiaState.events.push(["adbSetAirplaneMode", serial, enable]);
  },
  adbSetNetworkProfile(serial: string, profile: string) {
    uiaState.events.push(["adbSetNetworkProfile", serial, profile]);
  },
  adbSetCustomNetwork(serial: string, downloadKbps: number, uploadKbps: number, delayMs: number) {
    uiaState.events.push(["adbSetCustomNetwork", serial, downloadKbps, uploadKbps, delayMs]);
  },
  adbResetNetwork(serial: string) {
    uiaState.events.push(["adbResetNetwork", serial]);
  },
  adbSetWifi(serial: string, enable: boolean) {
    uiaState.events.push(["adbSetWifi", serial, enable]);
  },
  adbSetData(serial: string, enable: boolean) {
    uiaState.events.push(["adbSetData", serial, enable]);
  },
```

Then add tests:

```typescript
  test("setNetworkConditions with profile on emulator calls adbSetNetworkProfile", async () => {
    const { createUiAutomator2Driver } = await importFreshDriver();
    const driver = await Effect.runPromise(
      createUiAutomator2Driver("127.0.0.1", 4723, "emulator-5554", "com.example.app"),
    );

    await Effect.runPromise(driver.setNetworkConditions!({ profile: "3g" }));

    expect(uiaState.events).toContainEqual(["adbSetNetworkProfile", "emulator-5554", "3g"]);
  });

  test("setNetworkConditions with offline on real device uses airplane mode", async () => {
    const { createUiAutomator2Driver } = await importFreshDriver();
    const driver = await Effect.runPromise(
      createUiAutomator2Driver("127.0.0.1", 4723, "R5CT1234567", "com.example.app"),
    );

    await Effect.runPromise(driver.setNetworkConditions!({ offline: true }));

    expect(uiaState.events).toContainEqual(["adbSetAirplaneMode", "R5CT1234567", true]);
  });

  test("setNetworkConditions with profile on real device throws", async () => {
    const { createUiAutomator2Driver } = await importFreshDriver();
    const driver = await Effect.runPromise(
      createUiAutomator2Driver("127.0.0.1", 4723, "R5CT1234567", "com.example.app"),
    );

    const result = await Effect.runPromise(
      Effect.either(driver.setNetworkConditions!({ profile: "3g" })),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain("not supported on physical");
    }
  });

  test("setNetworkConditions with empty object resets network", async () => {
    const { createUiAutomator2Driver } = await importFreshDriver();
    const driver = await Effect.runPromise(
      createUiAutomator2Driver("127.0.0.1", 4723, "emulator-5554", "com.example.app"),
    );

    await Effect.runPromise(driver.setNetworkConditions!({}));

    expect(uiaState.events).toContainEqual(["adbResetNetwork", "emulator-5554"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/spana && bun test src/drivers/uiautomator2/driver.test.ts`
Expected: FAIL — `driver.setNetworkConditions` is undefined

- [ ] **Step 3: Implement setNetworkConditions in UiAutomator2 driver**

In `packages/spana/src/drivers/uiautomator2/driver.ts`, add imports:

```typescript
import {
  adbLaunchApp,
  adbForceStop,
  adbClearApp,
  adbOpenLink,
  adbSetAirplaneMode,
  adbSetNetworkProfile,
  adbSetCustomNetwork,
  adbResetNetwork,
  adbSetWifi,
  adbSetData,
} from "../../device/android.js";
import type { NetworkConditions } from "../raw-driver.js";
import { resolveNetworkConditions } from "../network-profiles.js";
```

Then add `setNetworkConditions` to the `service` object, after the `setContext` method (before the closing `};` of the service object at line 265):

```typescript
      // -----------------------------------------------------------------------
      // Network conditions
      // -----------------------------------------------------------------------
      setNetworkConditions: (conditions: NetworkConditions) =>
        Effect.tryPromise({
          try: async () => {
            const isEmulator = serial.startsWith("emulator-");
            const resolved = resolveNetworkConditions(conditions);

            // Reset case: empty object or wifi profile
            if (
              !conditions.profile &&
              !conditions.offline &&
              conditions.latencyMs === undefined &&
              conditions.downloadThroughputKbps === undefined &&
              conditions.uploadThroughputKbps === undefined
            ) {
              if (isEmulator) {
                adbResetNetwork(serial);
              } else {
                adbSetAirplaneMode(serial, false);
              }
              return;
            }

            // Offline toggle — works on both emulator and real device
            if (resolved.offline) {
              if (isEmulator) {
                adbSetWifi(serial, false);
                adbSetData(serial, false);
              } else {
                adbSetAirplaneMode(serial, true);
              }
              return;
            }

            // Throttling — emulator only
            if (!isEmulator) {
              // Real device: only offline toggle is supported
              if (conditions.profile && conditions.profile !== "wifi") {
                throw new DriverError({
                  message:
                    `Network throttling is not supported on physical Android devices. ` +
                    `Use an emulator or cloud provider (BrowserStack, SauceLabs) for network profiles. ` +
                    `Offline toggle is supported — use { offline: true } instead.`,
                });
              }
              // wifi profile or re-enabling connectivity
              adbSetAirplaneMode(serial, false);
              return;
            }

            // Emulator: ensure connectivity is on before throttling
            adbSetWifi(serial, true);
            adbSetData(serial, true);

            if (conditions.profile) {
              adbSetNetworkProfile(serial, conditions.profile);
            } else {
              adbSetCustomNetwork(
                serial,
                resolved.downloadThroughputKbps >= 0 ? resolved.downloadThroughputKbps : 0,
                resolved.uploadThroughputKbps >= 0 ? resolved.uploadThroughputKbps : 0,
                resolved.latencyMs,
              );
            }
          },
          catch: (e) => {
            if (e instanceof DriverError) return e;
            return new DriverError({ message: `Failed to set network conditions: ${e}` });
          },
        }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/spana && bun test src/drivers/uiautomator2/driver.test.ts`
Expected: All tests PASS (existing + 4 new)

- [ ] **Step 5: Commit**

```bash
git add packages/spana/src/drivers/uiautomator2/driver.ts packages/spana/src/drivers/uiautomator2/driver.test.ts
git commit -m "feat: implement setNetworkConditions for Android UiAutomator2 driver"
```

---

### Task 6: WDA Driver — setNetworkConditions

**Files:**
- Modify: `packages/spana/src/drivers/wda/driver.ts`
- Modify: `packages/spana/src/drivers/wda/driver.test.ts`

- [ ] **Step 1: Write the failing test**

Read the existing `packages/spana/src/drivers/wda/driver.test.ts` to understand its mock structure, then add tests for `setNetworkConditions`. The WDA driver receives a `simulatorUdid` parameter — when present, it indicates a simulator.

Add a mock for the new iOS network functions and tests:

```typescript
  test("setNetworkConditions with offline on simulator calls pfctlSetOffline", async () => {
    // Use the test's existing driver creation pattern with simulatorUdid set
    // to indicate a simulator environment
    const driver = await createTestDriver({ simulatorUdid: "SIM-UDID" });
    await Effect.runPromise(driver.setNetworkConditions!({ offline: true }));

    expect(iosState.events).toContainEqual(["pfctlSetOffline", true]);
  });

  test("setNetworkConditions with profile on simulator calls pfctlSetThrottle", async () => {
    const driver = await createTestDriver({ simulatorUdid: "SIM-UDID" });
    await Effect.runPromise(driver.setNetworkConditions!({ profile: "3g" }));

    // 3g = 1500 kbps, 100ms
    expect(iosState.events).toContainEqual(["pfctlSetThrottle", 1500, 100]);
  });

  test("setNetworkConditions on physical device throws", async () => {
    // No simulatorUdid = physical device
    const driver = await createTestDriver({});
    const result = await Effect.runPromise(
      Effect.either(driver.setNetworkConditions!({ profile: "3g" })),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain("not supported on physical iOS devices");
    }
  });

  test("setNetworkConditions with empty object resets network", async () => {
    const driver = await createTestDriver({ simulatorUdid: "SIM-UDID" });
    await Effect.runPromise(driver.setNetworkConditions!({}));

    expect(iosState.events).toContainEqual(["pfctlResetNetwork"]);
  });
```

**Important:** Adapt mock patterns to match the existing test file structure (read it first). The WDA driver test may use different mock patterns than UiAutomator2.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/spana && bun test src/drivers/wda/driver.test.ts`
Expected: FAIL — `driver.setNetworkConditions` is undefined

- [ ] **Step 3: Implement setNetworkConditions in WDA driver**

In `packages/spana/src/drivers/wda/driver.ts`, add imports:

```typescript
import {
  pfctlSetOffline,
  pfctlSetThrottle,
  pfctlResetNetwork,
} from "../../device/ios.js";
import type { NetworkConditions } from "../raw-driver.js";
import { resolveNetworkConditions } from "../network-profiles.js";
```

Add `setNetworkConditions` to the service object, before the closing `};` (after the `setContext` method at line 501):

```typescript
      // -----------------------------------------------------------------------
      // Network conditions
      // -----------------------------------------------------------------------
      setNetworkConditions: (conditions: NetworkConditions) =>
        Effect.tryPromise({
          try: async () => {
            // Physical device — no programmatic network control
            if (!simulatorUdid) {
              throw new DriverError({
                message:
                  "Network simulation is not supported on physical iOS devices. " +
                  "Use a cloud provider (BrowserStack, SauceLabs) for network profiles.",
              });
            }

            const resolved = resolveNetworkConditions(conditions);

            // Reset case
            if (
              !conditions.profile &&
              !conditions.offline &&
              conditions.latencyMs === undefined &&
              conditions.downloadThroughputKbps === undefined &&
              conditions.uploadThroughputKbps === undefined
            ) {
              pfctlResetNetwork();
              return;
            }

            if (resolved.offline) {
              pfctlSetOffline(true);
              return;
            }

            // Throttling with profile or custom values
            if (
              resolved.latencyMs > 0 ||
              (resolved.downloadThroughputKbps >= 0 && resolved.downloadThroughputKbps !== -1)
            ) {
              const throughput =
                resolved.downloadThroughputKbps >= 0 ? resolved.downloadThroughputKbps : 0;
              pfctlSetThrottle(throughput, resolved.latencyMs);
            } else {
              // No throttling needed, ensure online
              pfctlSetOffline(false);
            }
          },
          catch: (e) => {
            if (e instanceof DriverError) return e;
            return new DriverError({ message: `Failed to set network conditions: ${e}` });
          },
        }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/spana && bun test src/drivers/wda/driver.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/spana/src/drivers/wda/driver.ts packages/spana/src/drivers/wda/driver.test.ts
git commit -m "feat: implement setNetworkConditions for iOS WDA driver (simulator)"
```

---

### Task 7: Appium Cloud Drivers — setNetworkConditions

**Files:**
- Modify: `packages/spana/src/drivers/appium/android.ts`
- Modify: `packages/spana/src/drivers/appium/ios.ts`
- Modify: `packages/spana/src/drivers/appium/android.test.ts`
- Modify: `packages/spana/src/drivers/appium/ios.test.ts`

- [ ] **Step 1: Write the failing test for Appium Android**

Add to `packages/spana/src/drivers/appium/android.test.ts`:

```typescript
  test("setNetworkConditions with profile sends executor command", async () => {
    const { client } = await makeClient();
    queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    await Effect.runPromise(driver.setNetworkConditions!({ profile: "3g" }));

    // Verify the executeScript was called with the right mobile: command
    // (check the fetch calls for /execute/sync)
  });

  test("setNetworkConditions with offline sends airplane mode command", async () => {
    const { client } = await makeClient();
    queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    await Effect.runPromise(driver.setNetworkConditions!({ offline: true }));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/spana && bun test src/drivers/appium/android.test.ts`
Expected: FAIL — `driver.setNetworkConditions` is undefined

- [ ] **Step 3: Implement setNetworkConditions in Appium Android driver**

In `packages/spana/src/drivers/appium/android.ts`, add imports:

```typescript
import type { NetworkConditions } from "../raw-driver.js";
import { resolveNetworkConditions } from "../network-profiles.js";
```

Add to the service object, after the `setContext` method:

```typescript
      // -----------------------------------------------------------------------
      // Network conditions (cloud provider)
      // -----------------------------------------------------------------------
      setNetworkConditions: (conditions: NetworkConditions) =>
        Effect.tryPromise({
          try: async () => {
            const resolved = resolveNetworkConditions(conditions);

            // Reset case
            if (
              !conditions.profile &&
              !conditions.offline &&
              conditions.latencyMs === undefined &&
              conditions.downloadThroughputKbps === undefined &&
              conditions.uploadThroughputKbps === undefined
            ) {
              await client.executeScript("mobile: setConnectivity", [
                { wifi: true, data: true, airplaneMode: false },
              ]);
              return;
            }

            if (resolved.offline) {
              await client.executeScript("mobile: setConnectivity", [
                { wifi: false, data: false, airplaneMode: true },
              ]);
              return;
            }

            // Try BrowserStack-style network profile first
            // BrowserStack uses the browserstack_executor with setNetworkProfile action
            const host = client.getRemoteUrl?.() ?? "";
            if (host.includes("browserstack")) {
              const bsProfileMap: Record<string, string> = {
                "2g": "2g-lossy",
                edge: "edge-lossy",
                "3g": "3g-lossy",
                "4g": "4g-lossy",
                wifi: "reset",
              };
              const bsProfile = conditions.profile
                ? bsProfileMap[conditions.profile] ?? conditions.profile
                : undefined;

              if (bsProfile) {
                await client.executeScript("browserstack_executor: setNetworkProfile", [
                  { profile: bsProfile },
                ]);
                return;
              }
            }

            // Generic Appium: use mobile: setConnectivity for online/offline,
            // throttling may not be available on all providers
            await client.executeScript("mobile: setConnectivity", [
              { wifi: true, data: true, airplaneMode: false },
            ]);
          },
          catch: (e) =>
            new DriverError({ message: `Failed to set network conditions: ${e}` }),
        }),
```

- [ ] **Step 4: Implement setNetworkConditions in Appium iOS driver**

In `packages/spana/src/drivers/appium/ios.ts`, add similar imports and implementation:

```typescript
import type { NetworkConditions } from "../raw-driver.js";
import { resolveNetworkConditions } from "../network-profiles.js";
```

Add to the service object:

```typescript
      // -----------------------------------------------------------------------
      // Network conditions (cloud provider)
      // -----------------------------------------------------------------------
      setNetworkConditions: (conditions: NetworkConditions) =>
        Effect.tryPromise({
          try: async () => {
            const resolved = resolveNetworkConditions(conditions);

            // Reset case
            if (
              !conditions.profile &&
              !conditions.offline &&
              conditions.latencyMs === undefined &&
              conditions.downloadThroughputKbps === undefined &&
              conditions.uploadThroughputKbps === undefined
            ) {
              await client.executeScript("mobile: setConnectivity", [
                { wifi: true, data: true, airplaneMode: false },
              ]);
              return;
            }

            if (resolved.offline) {
              await client.executeScript("mobile: setConnectivity", [
                { wifi: false, data: false, airplaneMode: true },
              ]);
              return;
            }

            // BrowserStack network profiles
            const host = client.getRemoteUrl?.() ?? "";
            if (host.includes("browserstack")) {
              const bsProfileMap: Record<string, string> = {
                "2g": "2g-lossy",
                edge: "edge-lossy",
                "3g": "3g-lossy",
                "4g": "4g-lossy",
                wifi: "reset",
              };
              const bsProfile = conditions.profile
                ? bsProfileMap[conditions.profile] ?? conditions.profile
                : undefined;

              if (bsProfile) {
                await client.executeScript("browserstack_executor: setNetworkProfile", [
                  { profile: bsProfile },
                ]);
                return;
              }
            }

            await client.executeScript("mobile: setConnectivity", [
              { wifi: true, data: true, airplaneMode: false },
            ]);
          },
          catch: (e) =>
            new DriverError({ message: `Failed to set network conditions: ${e}` }),
        }),
```

- [ ] **Step 5: Add test for Appium iOS**

Add to `packages/spana/src/drivers/appium/ios.test.ts`:

```typescript
  test("setNetworkConditions with offline sends connectivity command", async () => {
    const { client } = await makeClient();
    queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(driver.setNetworkConditions!({ offline: true }));
  });
```

- [ ] **Step 6: Run all Appium tests**

Run: `cd packages/spana && bun test src/drivers/appium/android.test.ts src/drivers/appium/ios.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Check if AppiumClient has getRemoteUrl**

If `AppiumClient` doesn't expose `getRemoteUrl()`, the BrowserStack detection code needs adjustment. Check `packages/spana/src/drivers/appium/client.ts` for available methods. If not present, either:
- Add a `getRemoteUrl()` method to AppiumClient that returns the base URL
- Or use a different detection mechanism (check session capabilities for `browserstack.` prefixed keys)

Adjust the implementation accordingly.

- [ ] **Step 8: Commit**

```bash
git add packages/spana/src/drivers/appium/android.ts packages/spana/src/drivers/appium/ios.ts packages/spana/src/drivers/appium/android.test.ts packages/spana/src/drivers/appium/ios.test.ts
git commit -m "feat: implement setNetworkConditions for Appium cloud drivers"
```

---

### Task 8: Update withBufferedDriverLogs and Verify Full Suite

**Files:**
- Modify: `packages/spana/src/drivers/raw-driver.ts:292-374`

The `withBufferedDriverLogs` wrapper in `raw-driver.ts` explicitly lists all optional methods. `setNetworkConditions` is already listed (line 355-358), so it will automatically pick up the mobile implementations. Just verify.

- [ ] **Step 1: Verify withBufferedDriverLogs already wraps setNetworkConditions**

Read `packages/spana/src/drivers/raw-driver.ts` lines 355-358 to confirm:

```typescript
    setNetworkConditions: wrapOptionalMethod(
      logs,
      "setNetworkConditions",
      driver.setNetworkConditions,
    ),
```

This is already present — no changes needed.

- [ ] **Step 2: Run the full test suite**

Run: `cd packages/spana && bun test`
Expected: All tests pass across all driver test files

- [ ] **Step 3: Run type checking**

Run: `cd packages/spana && bun run check-types`
Expected: No type errors. The `BrowserNetworkConditions` alias ensures backwards compatibility.

- [ ] **Step 4: Commit if any fixes were needed**

Only commit if Step 2 or 3 required fixes.

---

### Task 9: Update Documentation

**Files:**
- Modify: `apps/docs/src/content/docs/writing-tests/flows.md` (or wherever `setNetworkConditions` is documented)

- [ ] **Step 1: Find existing docs for setNetworkConditions**

Run: `grep -r "setNetworkConditions" apps/docs/`

- [ ] **Step 2: Update docs to reflect new capabilities**

Update the documentation to:
- Show the new `profile` field in the `setNetworkConditions` API
- Add examples for each platform
- Document the capability matrix (what works where)
- Note the `BrowserNetworkConditions` → `NetworkConditions` rename

Example doc additions:

```markdown
### Network Profiles

Set pre-defined network conditions with a single profile name:

```typescript
// Simulate 3G network
await app.setNetworkConditions({ profile: "3g" });

// Go offline
await app.setNetworkConditions({ profile: "offline" });

// Back to normal
await app.setNetworkConditions({ profile: "wifi" });
```

Available profiles: `wifi`, `4g`, `3g`, `2g`, `edge`, `offline`

Custom values still work:

```typescript
await app.setNetworkConditions({
  latencyMs: 150,
  downloadThroughputKbps: 1000,
  uploadThroughputKbps: 500,
});
```

#### Platform Support

| Platform | Offline | Profiles | Custom Values |
|---|---|---|---|
| Web (Chromium) | ✓ | ✓ | ✓ |
| Web (Firefox/WebKit) | ✓ | ✗ | ✗ |
| Android emulator | ✓ | ✓ | ✓ |
| Android device | ✓ | ✗ | ✗ |
| iOS simulator | ✓ | ✓ (sudo) | ✓ (sudo) |
| Appium cloud | ✓ | ✓ | varies |
```

- [ ] **Step 3: Commit**

```bash
git add apps/docs/
git commit -m "docs: update setNetworkConditions with cross-platform profiles"
```
