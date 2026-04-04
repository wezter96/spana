import { execSync } from "node:child_process";

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

/** Get first available (state === "device") Android device */
export function firstAndroidDevice(): AndroidDevice | null {
  const devices = listAndroidDevices();
  return devices.find((d) => d.state === "device") ?? null;
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
