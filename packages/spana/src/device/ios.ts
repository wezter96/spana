import { execFileSync, execSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { allocatePort, releasePort } from "../core/port-allocator.js";

export interface IOSSimulator {
  udid: string;
  name: string;
  state: "Booted" | "Shutdown" | string;
  runtime: string; // e.g. "iOS 17.5"
  isAvailable: boolean;
}

export interface IOSDevice {
  udid: string;
  name: string;
  type: "simulator" | "device";
  state: string;
  runtime?: string;
}

/** List iOS simulators */
export function listIOSSimulators(): IOSSimulator[] {
  try {
    const output = execSync("xcrun simctl list devices -j", { encoding: "utf-8" });
    const data = JSON.parse(output);
    const simulators: IOSSimulator[] = [];

    for (const [runtime, devices] of Object.entries(data.devices ?? {})) {
      // runtime looks like "com.apple.CoreSimulator.SimRuntime.iOS-17-5"
      const runtimeName = runtime
        .replace("com.apple.CoreSimulator.SimRuntime.", "")
        .replaceAll("-", ".");

      for (const device of devices as any[]) {
        simulators.push({
          udid: device.udid,
          name: device.name,
          state: device.state,
          runtime: runtimeName,
          isAvailable: device.isAvailable ?? true,
        });
      }
    }

    return simulators;
  } catch {
    return [];
  }
}

/** List booted iOS simulators */
export function listBootedSimulators(): IOSSimulator[] {
  return listIOSSimulators().filter((s) => s.state === "Booted" && s.isAvailable);
}

/** Get first booted simulator, or first available if none booted */
export function firstIOSSimulator(): IOSSimulator | null {
  const booted = listBootedSimulators();
  if (booted.length > 0) return booted[0]!;

  const available = listIOSSimulators().filter((s) => s.isAvailable);
  return available[0] ?? null;
}

/** Check whether an app is installed on a simulator */
export function hasAppInstalledOnSimulator(udid: string, bundleId: string): boolean {
  if (!bundleId) return false;

  try {
    execSync(`xcrun simctl get_app_container ${udid} ${bundleId} app`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Prefer a simulator that already has the requested app installed */
export function firstIOSSimulatorWithApp(bundleId: string): IOSSimulator | null {
  const bootedWithApp = listBootedSimulators().find((sim) =>
    hasAppInstalledOnSimulator(sim.udid, bundleId),
  );
  if (bootedWithApp) return bootedWithApp;

  const availableWithApp = listIOSSimulators()
    .filter((sim) => sim.isAvailable)
    .find((sim) => hasAppInstalledOnSimulator(sim.udid, bundleId));
  if (availableWithApp) return availableWithApp;

  return firstIOSSimulator();
}

/**
 * Ensure an iOS simulator is available and booted.
 * If none booted, boots the first available simulator (preferring one with the app installed).
 * Returns the simulator or null if none available.
 */
export function ensureIOSSimulator(bundleId?: string): IOSSimulator | null {
  const sim = bundleId ? firstIOSSimulatorWithApp(bundleId) : firstIOSSimulator();
  if (!sim) return null;

  if (sim.state !== "Booted") {
    console.log(`Booting iOS simulator "${sim.name}"...`);
    bootSimulator(sim.udid);
  }

  return sim;
}

/** Boot a simulator by UDID */
export function bootSimulator(udid: string): void {
  try {
    execSync(`xcrun simctl boot ${udid}`, { stdio: "ignore" });
  } catch {
    // May already be booted — ignore
  }
}

/** Install app on simulator */
export function installOnSimulator(udid: string, appPath: string): void {
  execSync(`xcrun simctl install ${udid} ${appPath}`);
}

/** Launch app on simulator */
export function launchOnSimulator(udid: string, bundleId: string): void {
  execSync(`xcrun simctl launch ${udid} ${bundleId}`);
}

/** Launch app on simulator with a deep link URL (bypasses system confirmation dialog) */
export function launchWithUrlOnSimulator(udid: string, bundleId: string, url: string): void {
  execFileSync("xcrun", ["simctl", "launch", udid, bundleId, "--open-url", url]);
}

/** List URL schemes registered by the installed app on simulator */
export function installedUrlSchemesOnSimulator(udid: string, bundleId: string): string[] {
  if (!bundleId) return [];

  try {
    const appPath = execSync(`xcrun simctl get_app_container ${udid} ${bundleId} app`, {
      encoding: "utf-8",
    }).trim();

    const raw = execFileSync(
      "plutil",
      ["-extract", "CFBundleURLTypes", "json", "-o", "-", `${appPath}/Info.plist`],
      {
        encoding: "utf-8",
      },
    );

    const urlTypes = JSON.parse(raw) as Array<{
      CFBundleURLSchemes?: string[];
    }>;

    return urlTypes.flatMap((entry) => entry.CFBundleURLSchemes ?? []);
  } catch {
    return [];
  }
}

/** Open a URL or deep link on simulator */
export function openUrlOnSimulator(udid: string, url: string): void {
  execFileSync("xcrun", ["simctl", "openurl", udid, url], { stdio: "ignore" });
}

/** Terminate app on simulator */
export function terminateOnSimulator(udid: string, bundleId: string): void {
  try {
    execSync(`xcrun simctl terminate ${udid} ${bundleId}`, { stdio: "ignore" });
  } catch {
    // May not be running
  }
}

/**
 * Clone an existing iOS Simulator for parallel multi-worker CI execution (`xcrun simctl clone`).
 * Returns the newly created simulator UDID.
 */
export function cloneIOSSimulator(sourceUdid: string, cloneName: string): string {
  const out = execFileSync("xcrun", ["simctl", "clone", sourceUdid, cloneName], {
    encoding: "utf-8",
  });
  const udid = out.trim();
  if (!udid) {
    throw new Error(`xcrun simctl clone returned empty UDID for ${sourceUdid}`);
  }
  return udid;
}

/** Shut down and delete a temporary cloned iOS Simulator (`xcrun simctl delete`). */
export function deleteIOSSimulator(udid: string): void {
  try {
    execFileSync("xcrun", ["simctl", "shutdown", udid], { stdio: "ignore" });
  } catch {
    // already shut down
  }
  execFileSync("xcrun", ["simctl", "delete", udid], { stdio: "ignore" });
}

// ---------------------------------------------------------------------------
// Physical device support
// ---------------------------------------------------------------------------

export interface IOSPhysicalDevice {
  udid: string;
  name: string;
  connectionType: "USB" | "Wi-Fi" | string;
}

/**
 * List connected physical iOS devices using xcrun devicectl (Xcode 15+).
 * Falls back to system_profiler if devicectl is unavailable.
 */
export function listIOSPhysicalDevices(): IOSPhysicalDevice[] {
  // Try xcrun devicectl first (Xcode 15+)
  try {
    const tmpFile = `/tmp/spana-devicectl-${Date.now()}.json`;
    execSync(`xcrun devicectl list devices --json-output ${tmpFile} 2>/dev/null`, {
      timeout: 10_000,
    });
    const output = readFileSync(tmpFile, "utf-8");
    try {
      unlinkSync(tmpFile);
    } catch {
      /* cleanup */
    }

    const data = JSON.parse(output);
    const devices: IOSPhysicalDevice[] = [];

    for (const device of data?.result?.devices ?? []) {
      const deviceType = device.hardwareProperties?.deviceType ?? "";
      const transport = device.connectionProperties?.transportType;
      const state = device.connectionProperties?.tunnelState;

      // Only treat iPhones/iPads with an active tunnel as available physical
      // devices. devicectl can report remembered Wi-Fi devices with a transport
      // but tunnelState "disconnected", which should not trigger a device-first
      // test run attempt.
      if (
        (deviceType === "iPhone" || deviceType === "iPad") &&
        transport &&
        state === "connected"
      ) {
        devices.push({
          udid: device.hardwareProperties?.udid ?? device.identifier,
          name: device.deviceProperties?.name ?? "Unknown",
          connectionType: transport === "wired" ? "USB" : (transport ?? "unknown"),
        });
      }
    }

    return devices;
  } catch {
    // Fall back to system_profiler for older Xcode
  }

  try {
    const output = execSync("system_profiler SPUSBDataType -json 2>/dev/null", {
      encoding: "utf-8",
      timeout: 10_000,
    });
    const data = JSON.parse(output);
    const devices: IOSPhysicalDevice[] = [];

    function walkUSB(items: any[]): void {
      for (const item of items) {
        // iOS devices have serial_num and contain "iPhone" or "iPad" in name
        if (item.serial_num && /iPhone|iPad|iPod/i.test(item._name ?? "")) {
          devices.push({
            udid: item.serial_num.replaceAll("-", ""),
            name: item._name ?? "iOS Device",
            connectionType: "USB",
          });
        }
        if (item._items) walkUSB(item._items);
      }
    }

    walkUSB(data.SPUSBDataType ?? []);
    return devices;
  } catch {
    return [];
  }
}

/** Get first connected physical iOS device */
export function firstIOSPhysicalDevice(): IOSPhysicalDevice | null {
  const devices = listIOSPhysicalDevices();
  return devices[0] ?? null;
}

/**
 * Start iproxy to tunnel a port from localhost to a physical device via USB.
 * Requires libimobiledevice (`brew install libimobiledevice`).
 *
 * @returns A cleanup function to kill the iproxy process.
 */
export function startIproxy(
  udid: string,
  localPort: number,
  devicePort: number,
): { host: string; port: number; cleanup: () => void } {
  // Check iproxy is available
  try {
    execSync("which iproxy", { stdio: "ignore" });
  } catch {
    throw new Error("iproxy not found. Install with: brew install libimobiledevice");
  }

  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const proc = spawn("iproxy", [`${localPort}:${devicePort}`, "-u", udid], {
    stdio: "ignore",
    detached: true,
  });
  proc.unref();

  // Give iproxy a moment to bind
  const waitUntil = Date.now() + 1500;
  while (Date.now() < waitUntil) {
    /* busy wait */
  }

  return {
    host: "localhost",
    port: localPort,
    cleanup: () => {
      try {
        proc.kill();
      } catch {
        // already dead
      }
    },
  };
}

/**
 * Connect to a physical iOS device for testing.
 * Sets up iproxy tunnel and returns connection info for WDA.
 *
 * WDA must be pre-installed and running on the device.
 * Install with: xcodebuild -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner
 *               -destination "id=<UDID>" test
 */
export function connectPhysicalDevice(
  udid: string,
  wdaPort = 8100,
): { host: string; port: number; cleanup: () => void } {
  const localPort = allocatePort(8100);

  try {
    const tunnel = startIproxy(udid, localPort, wdaPort);
    return {
      ...tunnel,
      cleanup: () => {
        tunnel.cleanup();
        releasePort(localPort);
      },
    };
  } catch (error) {
    releasePort(localPort);
    throw error;
  }
}

/**
 * Install an app on a physical iOS device using xcrun devicectl (Xcode 15+).
 * Accepts .app bundles or .ipa files.
 */
export function installOnPhysicalDevice(udid: string, appPath: string): void {
  try {
    execSync(`xcrun devicectl device install app --device ${udid} ${appPath}`, {
      stdio: "inherit",
      timeout: 120_000,
    });
  } catch {
    throw new Error(
      `Failed to install app on device ${udid}. Ensure the app is signed for this device.`,
    );
  }
}

/**
 * Check if an app is installed on a physical device.
 */
export function hasAppOnPhysicalDevice(udid: string, bundleId: string): boolean {
  if (!bundleId) return false;
  try {
    const tmpFile = `/tmp/spana-applist-${Date.now()}.json`;
    execSync(
      `xcrun devicectl device info apps --device ${udid} --json-output ${tmpFile} 2>/dev/null`,
      { timeout: 15_000 },
    );
    const output = readFileSync(tmpFile, "utf-8");
    try {
      unlinkSync(tmpFile);
    } catch {
      /* cleanup */
    }
    return output.includes(bundleId);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Network control helpers (pfctl / dnctl)
// ---------------------------------------------------------------------------
// WARNING: These functions affect the entire host Mac's network stack.
// iOS simulators share the host network — there is no per-simulator isolation.
// Requires sudo.

/** pfctl anchor name used by spana for network rules */
export const SPANA_ANCHOR = "com.spana.network";

/**
 * Block or unblock all outbound network traffic using pfctl.
 * When enabled, adds a "block out all" rule to the spana anchor.
 * When disabled, flushes all rules from the spana anchor.
 */
export function pfctlSetOffline(enable: boolean): void {
  if (enable) {
    execSync(`echo "block out all\n" | sudo pfctl -a ${SPANA_ANCHOR} -f -`, { stdio: "ignore" });
    try {
      execSync("sudo pfctl -e 2>/dev/null", { stdio: "ignore" });
    } catch {
      // May already be enabled
    }
  } else {
    try {
      execSync(`sudo pfctl -a ${SPANA_ANCHOR} -F all`, { stdio: "ignore" });
    } catch {
      // Ignore errors
    }
  }
}

/**
 * Throttle network using dnctl pipe and pfctl dummynet rules.
 * Configures bandwidth and delay for all outbound traffic.
 */
export function pfctlSetThrottle(throughputKbps: number, delayMs: number): void {
  execSync(`sudo dnctl pipe 1 config bw ${throughputKbps}Kbit/s delay ${delayMs}ms`, {
    stdio: "ignore",
  });
  execSync(`echo "dummynet out all pipe 1\n" | sudo pfctl -a ${SPANA_ANCHOR} -f -`, {
    stdio: "ignore",
  });
  try {
    execSync("sudo pfctl -e 2>/dev/null", { stdio: "ignore" });
  } catch {
    // May already be enabled
  }
}

/**
 * Reset all network modifications — flush pfctl anchor rules and dnctl pipes.
 */
export function pfctlResetNetwork(): void {
  try {
    execSync(`sudo pfctl -a ${SPANA_ANCHOR} -F all`, { stdio: "ignore" });
  } catch {
    // Ignore errors
  }
  try {
    execSync("sudo dnctl -q flush", { stdio: "ignore" });
  } catch {
    // Ignore errors
  }
}

/** Reset simulator keychain (removes all stored passwords and certificates) */
export function resetSimulatorKeychain(udid: string): void {
  execSync(`xcrun simctl keychain ${udid} reset`, { stdio: "ignore" });
}

/**
 * Ensure an app is installed on the target device (simulator or physical).
 * Installs from appPath if not already present.
 */
export function ensureAppInstalled(opts: {
  udid: string;
  bundleId: string;
  appPath: string;
  isPhysicalDevice: boolean;
}): void {
  const { udid, bundleId, appPath, isPhysicalDevice } = opts;

  if (isPhysicalDevice) {
    if (!hasAppOnPhysicalDevice(udid, bundleId)) {
      console.log(`Installing ${bundleId} on physical device...`);
      installOnPhysicalDevice(udid, appPath);
    }
  } else {
    if (!hasAppInstalledOnSimulator(udid, bundleId)) {
      console.log(`Installing ${bundleId} on simulator...`);
      installOnSimulator(udid, appPath);
    }
  }
}
