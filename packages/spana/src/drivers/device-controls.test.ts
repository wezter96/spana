import { expect, test } from "bun:test";
import { Effect } from "effect";
import { androidDeviceControls, iosSimulatorControls } from "./device-controls.js";

test("Android device controls target the selected emulator and application", async () => {
  const calls: string[][] = [];
  const android = androidDeviceControls(
    "emulator-5556",
    (command, args) => {
      calls.push([command, ...args]);
      return "OK";
    },
    () => "adb",
  );
  await Effect.runPromise(android.setGeolocation({ latitude: -20.5, longitude: 45.7 }));
  await Effect.runPromise(
    android.setPermission("com.example.app", "android.permission.CAMERA", "grant"),
  );
  await Effect.runPromise(android.simulateBiometric({ type: "fingerprint", fingerId: 4 }));
  expect(calls).toEqual([
    ["adb", "-s", "emulator-5556", "emu", "geo", "fix", "45.7", "-20.5"],
    [
      "adb",
      "-s",
      "emulator-5556",
      "shell",
      "pm",
      "grant",
      "com.example.app",
      "android.permission.CAMERA",
    ],
    ["adb", "-s", "emulator-5556", "emu", "finger", "touch", "4"],
  ]);
});

test("iOS device controls send simulator-scoped permissions, biometrics, location and push", async () => {
  const calls: { cmd: string; args: string[]; input?: string }[] = [];
  const ios = iosSimulatorControls("device-id", (cmd, args, input) => {
    calls.push({ cmd, args, input });
    return "";
  });
  await Effect.runPromise(ios.setGeolocation({ latitude: -2.5, longitude: 45.7 }));
  await Effect.runPromise(ios.setPermission("com.example.app", "location", "deny"));
  await Effect.runPromise(ios.setBiometricEnrollment(true));
  await Effect.runPromise(ios.simulateBiometric({ type: "faceId", match: false }));
  await Effect.runPromise(ios.sendPushNotification("com.example.app", { aps: { alert: "Test" } }));
  expect(calls.map((call) => [call.cmd, ...call.args])).toEqual([
    ["xcrun", "simctl", "location", "device-id", "set", "-2.5000000,45.7000000"],
    ["xcrun", "simctl", "privacy", "device-id", "revoke", "location", "com.example.app"],
    [
      "xcrun",
      "simctl",
      "spawn",
      "device-id",
      "notifyutil",
      "-s",
      "com.apple.BiometricKit.enrollmentChanged",
      "1",
    ],
    [
      "xcrun",
      "simctl",
      "spawn",
      "device-id",
      "notifyutil",
      "-p",
      "com.apple.BiometricKit.enrollmentChanged",
    ],
    [
      "xcrun",
      "simctl",
      "spawn",
      "device-id",
      "notifyutil",
      "-p",
      "com.apple.BiometricKit_Sim.pearl.nomatch",
    ],
    ["xcrun", "simctl", "push", "device-id", "com.example.app", "-"],
  ]);
  expect(JSON.parse(calls.at(-1)!.input!)).toEqual({ aps: { alert: "Test" } });
  await expect(
    Effect.runPromise(iosSimulatorControls().setGeolocation({ latitude: 0, longitude: 0 })),
  ).rejects.toThrow("not supported on physical iOS devices");
});
