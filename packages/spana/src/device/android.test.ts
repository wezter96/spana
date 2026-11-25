import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const androidState = {
  versionCandidates: new Set<string>(),
  devicesOutput: "",
  execSyncCalls: [] as string[],
  execFileCalls: [] as Array<{ command: string; args: string[] }>,
};

const originalAndroidHome = process.env.ANDROID_HOME;
const originalAndroidSdkRoot = process.env.ANDROID_SDK_ROOT;
let importCounter = 0;

function resetAndroidState(): void {
  androidState.versionCandidates.clear();
  androidState.devicesOutput = "";
  androidState.execSyncCalls = [];
  androidState.execFileCalls = [];
}

function registerAndroidMocks(): void {
  mock.module("node:child_process", () => ({
    execSync: () => "",
    spawn: () => ({ unref: () => {} }),
    execFileSync: (command: string, args: string[]) => {
      androidState.execFileCalls.push({ command, args });
      androidState.execSyncCalls.push(`${command} ${args.join(" ")}`);

      if (args.length === 1 && args[0] === "version") {
        if (androidState.versionCandidates.has(command)) {
          return "Android Debug Bridge version";
        }
        throw new Error(`missing adb: ${command}`);
      }

      if (args.length === 1 && args[0] === "devices") {
        return androidState.devicesOutput;
      }

      return "";
    },
  }));
}

async function importFreshAndroid() {
  importCounter += 1;
  return (await import(
    new URL(`./android.ts?case=${importCounter}`, import.meta.url).href
  )) as typeof import("./android.js");
}

describe("android device helpers", () => {
  beforeEach(() => {
    mock.restore();
    resetAndroidState();
    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;
    registerAndroidMocks();
  });

  afterEach(() => {
    mock.restore();
    process.env.ANDROID_HOME = originalAndroidHome;
    process.env.ANDROID_SDK_ROOT = originalAndroidSdkRoot;
  });

  test("finds adb from ANDROID_HOME and parses connected devices", async () => {
    process.env.ANDROID_HOME = "/sdk";
    androidState.versionCandidates.add("/sdk/platform-tools/adb");
    androidState.devicesOutput = [
      "List of devices attached",
      "emulator-5554 device",
      "phone-42 device",
      "usb-9 offline",
      "",
    ].join("\n");

    const android = await importFreshAndroid();

    expect(android.findADB()).toBe("/sdk/platform-tools/adb");
    expect(android.listAndroidDevices()).toEqual([
      { serial: "emulator-5554", state: "device", type: "emulator" },
      { serial: "phone-42", state: "device", type: "device" },
      { serial: "usb-9", state: "offline", type: "device" },
    ]);
    expect(android.firstAndroidDevice()).toEqual({
      serial: "emulator-5554",
      state: "device",
      type: "emulator",
    });
  });

  test("returns an empty list when adb is unavailable", async () => {
    const android = await importFreshAndroid();

    expect(android.findADB()).toBeNull();
    expect(android.listAndroidDevices()).toEqual([]);
  });

  test("builds the expected adb deep link command", async () => {
    androidState.versionCandidates.add("adb");
    const android = await importFreshAndroid();

    android.adbOpenLink("emulator-5554", "spana://checkout?id=1", "com.example.shop");

    expect(androidState.execFileCalls).toContainEqual({
      command: "adb",
      args: [
        "-s",
        "emulator-5554",
        "shell",
        "am start -W -a android.intent.action.VIEW -f 335544320 -d 'spana://checkout?id=1' 'com.example.shop'",
      ],
    });
  });
});
