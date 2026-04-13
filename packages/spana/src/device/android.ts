import { execFileSync, execSync } from "node:child_process";

export interface AndroidDevice {
  serial: string;
  state: string; // "device", "offline", "unauthorized"
  type: "emulator" | "device";
}

/** Find the adb binary */
export function findADB(): string | null {
  // Check common locations
  const candidates = [
    "adb", // on PATH
    `${process.env.ANDROID_HOME}/platform-tools/adb`,
    `${process.env.ANDROID_SDK_ROOT}/platform-tools/adb`,
    "/usr/local/bin/adb",
    `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      execSync(`${candidate} version`, { stdio: "ignore" });
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

/** List connected Android devices */
export function listAndroidDevices(): AndroidDevice[] {
  const adb = findADB();
  if (!adb) return [];

  try {
    const output = execSync(`${adb} devices`, { encoding: "utf-8" });
    return parseDeviceList(output);
  } catch {
    return [];
  }
}

function parseDeviceList(output: string): AndroidDevice[] {
  const devices: AndroidDevice[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("List of")) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;

    const serial = parts[0]!;
    const state = parts[1]!;

    devices.push({
      serial,
      state,
      type: serial.startsWith("emulator-") ? "emulator" : "device",
    });
  }

  return devices;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Get first available (state === "device") Android device */
export function firstAndroidDevice(): AndroidDevice | null {
  const devices = listAndroidDevices();
  return devices.find((d) => d.state === "device") ?? null;
}

/** Find the emulator binary */
export function findEmulator(): string | null {
  const candidates = [
    "emulator",
    `${process.env.ANDROID_HOME}/emulator/emulator`,
    `${process.env.ANDROID_SDK_ROOT}/emulator/emulator`,
    `${process.env.HOME}/Library/Android/sdk/emulator/emulator`,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      execSync(`${candidate} -version`, { stdio: "ignore" });
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

/** List available Android Virtual Devices */
export function listAVDs(): string[] {
  const emulator = findEmulator();
  if (!emulator) return [];
  try {
    const output = execSync(`${emulator} -list-avds`, { encoding: "utf-8" });
    return output
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Start an Android emulator and wait for it to boot.
 * Returns the device serial (e.g. "emulator-5554") once ready.
 */
export function startEmulator(avdName: string, timeoutMs = 60_000): string {
  const emulator = findEmulator();
  if (!emulator) throw new Error("Android emulator not found");

  // Launch in background
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const proc = spawn(emulator, ["-avd", avdName, "-no-snapshot-save", "-no-audio", "-no-window"], {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();

  // Wait for device to appear in adb
  const adb = findADB();
  if (!adb) throw new Error("adb not found");

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const device = firstAndroidDevice();
    if (device) {
      // Wait for boot to complete
      try {
        const bootAnim = execSync(`${adb} -s ${device.serial} shell getprop sys.boot_completed`, {
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        if (bootAnim === "1") return device.serial;
      } catch {
        // not ready yet
      }
    }
    execSync("sleep 2");
  }

  throw new Error(`Emulator "${avdName}" did not boot within ${timeoutMs / 1000}s`);
}

/**
 * Ensure an Android device is available.
 * If none connected, attempts to start the first available AVD.
 * Returns the device or null if no AVDs available.
 */
export function ensureAndroidDevice(timeoutMs = 60_000): AndroidDevice | null {
  const existing = firstAndroidDevice();
  if (existing) return existing;

  const avds = listAVDs();
  if (avds.length === 0) return null;

  console.log(`No Android device connected. Starting emulator "${avds[0]}"...`);
  const serial = startEmulator(avds[0]!, timeoutMs);
  return { serial, state: "device", type: "emulator" };
}

/** Forward a port from host to device via adb */
export function adbForward(serial: string, hostPort: number, devicePort: number): void {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");
  execSync(`${adb} -s ${serial} forward tcp:${hostPort} tcp:${devicePort}`);
}

/** Run adb shell command on device */
export function adbShell(serial: string, command: string): string {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");
  return execSync(`${adb} -s ${serial} shell ${command}`, { encoding: "utf-8" });
}

/** Install APK on device */
export function adbInstall(serial: string, apkPath: string): void {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");
  execSync(`${adb} -s ${serial} install -r ${apkPath}`, { stdio: "ignore" });
}

/** Launch an installed app via the launcher intent */
export function adbLaunchApp(serial: string, packageName: string): void {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");
  execSync(
    `${adb} -s ${serial} shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`,
    { stdio: "ignore" },
  );
}

/** Force-stop an installed app */
export function adbForceStop(serial: string, packageName: string): void {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");
  execSync(`${adb} -s ${serial} shell am force-stop ${packageName}`, { stdio: "ignore" });
}

/** Clear app data and cache */
export function adbClearApp(serial: string, packageName: string): void {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");
  execSync(`${adb} -s ${serial} shell pm clear ${packageName}`, { stdio: "ignore" });
}

// ── Network control helpers ──────────────────────────────────────────

/** Maps friendly profile names to ADB emulator network presets */
export const ADB_PROFILE_MAP: Record<string, { speed: string; delay: string }> = {
  "2g": { speed: "gprs", delay: "gprs" },
  edge: { speed: "edge", delay: "edge" },
  "3g": { speed: "umts", delay: "umts" },
  "4g": { speed: "lte", delay: "none" },
  wifi: { speed: "full", delay: "none" },
};

/** Toggle airplane mode on/off */
export function adbSetAirplaneMode(serial: string, enable: boolean): void {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");
  execSync(`${adb} -s ${serial} shell cmd connectivity airplane-mode ${enable ? "enable" : "disable"}`);
}

/** Toggle Wi-Fi on/off */
export function adbSetWifi(serial: string, enable: boolean): void {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");
  execSync(`${adb} -s ${serial} shell svc wifi ${enable ? "enable" : "disable"}`);
}

/** Toggle mobile data on/off */
export function adbSetData(serial: string, enable: boolean): void {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");
  execSync(`${adb} -s ${serial} shell svc data ${enable ? "enable" : "disable"}`);
}

/** Apply a named network profile (emulator only) */
export function adbSetNetworkProfile(serial: string, profile: string): void {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");
  const mapping = ADB_PROFILE_MAP[profile];
  if (!mapping) throw new Error(`Unknown network profile "${profile}"`);
  execSync(`${adb} -s ${serial} emu network speed ${mapping.speed}`);
  execSync(`${adb} -s ${serial} emu network delay ${mapping.delay}`);
}

/** Apply custom network throttling (emulator only) */
export function adbSetCustomNetwork(serial: string, downloadKbps: number, uploadKbps: number, delayMs: number): void {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");
  execSync(`${adb} -s ${serial} emu network speed ${downloadKbps}:${uploadKbps}`);
  execSync(`${adb} -s ${serial} emu network delay ${delayMs}:${delayMs}`);
}

/** Reset network to full speed and disable airplane mode */
export function adbResetNetwork(serial: string): void {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");
  execSync(`${adb} -s ${serial} emu network speed full`);
  execSync(`${adb} -s ${serial} emu network delay none`);
  try {
    execSync(`${adb} -s ${serial} shell cmd connectivity airplane-mode disable`);
  } catch {
    // best-effort: may fail on physical devices
  }
}

/** Open a deep link or URL on the device */
export function adbOpenLink(serial: string, url: string, packageName?: string): void {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");

  // FLAG_ACTIVITY_CLEAR_TOP (0x04000000) + FLAG_ACTIVITY_NEW_TASK (0x10000000)
  // ensures the deeplink resets the navigation stack
  const flags = 0x04000000 | 0x10000000;
  const command = [
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-f",
    String(flags),
    "-d",
    shellQuote(url),
  ];

  if (packageName) {
    command.push(shellQuote(packageName));
  }

  execFileSync(adb, ["-s", serial, "shell", command.join(" ")], { stdio: "ignore" });
}
