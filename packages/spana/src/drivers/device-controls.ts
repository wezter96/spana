import { execFileSync } from "node:child_process";
import { Effect } from "effect";
import { findADB } from "../device/android.js";
import { DriverError } from "../errors.js";

export interface Geolocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

export type Orientation = "portrait" | "landscape";

export interface PermissionOptions {
  origin?: string;
}

export type BiometricOptions =
  | { type: "faceId" | "touchId"; match?: boolean }
  | { type: "fingerprint"; fingerId: number };

export type PushPayload = Record<string, unknown>;

export function deviceEffect<A>(operation: string, action: () => A | Promise<A>) {
  return Effect.tryPromise({
    try: async () => action(),
    catch: (error) =>
      new DriverError({
        message: `${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });
}

type Command = (file: string, args: string[], input?: string) => string;
const run: Command = (file, args, input) =>
  execFileSync(file, args, { encoding: "utf8", input, timeout: 15_000 });

function androidIdentifier(name: string): string {
  if (!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(name)) {
    throw new Error(`Invalid Android package or permission: ${name}`);
  }
  return name;
}

export function androidDeviceControls(serial: string, command = run, adbPath = findADB) {
  const adb = (...args: string[]) => {
    const file = adbPath();
    if (!file) throw new Error("adb not found");
    return command(file, ["-s", serial, ...args]);
  };
  const emulator = (operation: string, ...args: string[]) => {
    if (!serial.startsWith("emulator-")) {
      throw new Error(`${operation} is not supported on physical Android devices`);
    }
    const result = adb("emu", ...args);
    if (/^KO:/m.test(result)) throw new Error(result.trim());
  };
  return {
    setGeolocation: (point: Geolocation) =>
      deviceEffect("setGeolocation", () =>
        emulator(
          "Geolocation emulation",
          "geo",
          "fix",
          String(point.longitude),
          String(point.latitude),
        ),
      ),
    setPermission: (appId: string, permission: string, state: "grant" | "deny") =>
      deviceEffect("setPermission", () => {
        adb(
          "shell",
          "pm",
          state === "grant" ? "grant" : "revoke",
          androidIdentifier(appId),
          androidIdentifier(permission),
        );
      }),
    simulateBiometric: (opts: BiometricOptions) =>
      deviceEffect("simulateBiometric", () => {
        if (opts.type !== "fingerprint")
          throw new Error("Only fingerprint simulation is supported on Android");
        if (!Number.isInteger(opts.fingerId) || opts.fingerId < 1)
          throw new Error("fingerId must be a positive integer");
        emulator("Fingerprint simulation", "finger", "touch", String(opts.fingerId));
      }),
  };
}

export function iosSimulatorControls(udid?: string, command = run) {
  const simctl = (subcommand: string, args: string[], input?: string) => {
    if (!udid) throw new Error(`${subcommand} is not supported on physical iOS devices`);
    return command("xcrun", ["simctl", subcommand, udid, ...args], input);
  };
  const notify = (args: string[]) => simctl("spawn", ["notifyutil", ...args]);
  return {
    setGeolocation: (point: Geolocation) =>
      deviceEffect("setGeolocation", () => {
        simctl("location", ["set", `${point.latitude.toFixed(7)},${point.longitude.toFixed(7)}`]);
      }),
    setPermission: (appId: string, permission: string, state: "grant" | "deny") =>
      deviceEffect("setPermission", () => {
        simctl("privacy", [state === "grant" ? "grant" : "revoke", permission, appId]);
      }),
    setBiometricEnrollment: (enabled: boolean) =>
      deviceEffect("setBiometricEnrollment", () => {
        const event = "com.apple.BiometricKit.enrollmentChanged";
        notify(["-s", event, enabled ? "1" : "0"]);
        notify(["-p", event]);
      }),
    simulateBiometric: (opts: BiometricOptions) =>
      deviceEffect("simulateBiometric", () => {
        if (opts.type === "fingerprint") throw new Error("Use touchId or faceId on iOS");
        const sensor = opts.type === "faceId" ? "pearl" : "fingerTouch";
        notify([
          "-p",
          `com.apple.BiometricKit_Sim.${sensor}.${opts.match === false ? "nomatch" : "match"}`,
        ]);
      }),
    sendPushNotification: (appId: string, payload: PushPayload) =>
      deviceEffect("sendPushNotification", () => {
        simctl("push", [appId, "-"], JSON.stringify(payload));
      }),
  };
}
