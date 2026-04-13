import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const networkState = {
  versionCandidates: new Set<string>(),
  execSyncCalls: [] as string[],
};

const originalAndroidHome = process.env.ANDROID_HOME;
const originalAndroidSdkRoot = process.env.ANDROID_SDK_ROOT;
let importCounter = 0;

function resetState(): void {
  networkState.versionCandidates.clear();
  networkState.execSyncCalls = [];
}

function registerMocks(): void {
  mock.module("node:child_process", () => ({
    execSync: (command: string) => {
      networkState.execSyncCalls.push(command);

      if (command.endsWith(" version")) {
        const candidate = command.slice(0, -8);
        if (networkState.versionCandidates.has(candidate)) {
          return "Android Debug Bridge version";
        }
        throw new Error(`missing adb: ${candidate}`);
      }

      return "";
    },
    execFileSync: () => "",
  }));
}

async function importFresh() {
  importCounter += 1;
  return (await import(
    new URL(`./android.ts?net=${importCounter}`, import.meta.url).href
  )) as typeof import("./android.js");
}

describe("android network helpers", () => {
  beforeEach(() => {
    mock.restore();
    resetState();
    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;
    networkState.versionCandidates.add("adb");
    registerMocks();
  });

  afterEach(() => {
    mock.restore();
    process.env.ANDROID_HOME = originalAndroidHome;
    process.env.ANDROID_SDK_ROOT = originalAndroidSdkRoot;
  });

  test("ADB_PROFILE_MAP contains expected profiles", async () => {
    const android = await importFresh();
    expect(android.ADB_PROFILE_MAP).toEqual({
      "2g": { speed: "gprs", delay: "gprs" },
      edge: { speed: "edge", delay: "edge" },
      "3g": { speed: "umts", delay: "umts" },
      "4g": { speed: "lte", delay: "none" },
      wifi: { speed: "full", delay: "none" },
    });
  });

  test("adbSetAirplaneMode enable", async () => {
    const android = await importFresh();
    android.adbSetAirplaneMode("emu-5554", true);
    expect(networkState.execSyncCalls).toContain(
      "adb -s emu-5554 shell cmd connectivity airplane-mode enable",
    );
  });

  test("adbSetAirplaneMode disable", async () => {
    const android = await importFresh();
    android.adbSetAirplaneMode("emu-5554", false);
    expect(networkState.execSyncCalls).toContain(
      "adb -s emu-5554 shell cmd connectivity airplane-mode disable",
    );
  });

  test("adbSetWifi enable/disable", async () => {
    const android = await importFresh();
    android.adbSetWifi("dev-1", true);
    expect(networkState.execSyncCalls).toContain(
      "adb -s dev-1 shell svc wifi enable",
    );

    networkState.execSyncCalls = [];
    android.adbSetWifi("dev-1", false);
    expect(networkState.execSyncCalls).toContain(
      "adb -s dev-1 shell svc wifi disable",
    );
  });

  test("adbSetData enable/disable", async () => {
    const android = await importFresh();
    android.adbSetData("dev-1", true);
    expect(networkState.execSyncCalls).toContain(
      "adb -s dev-1 shell svc data enable",
    );

    networkState.execSyncCalls = [];
    android.adbSetData("dev-1", false);
    expect(networkState.execSyncCalls).toContain(
      "adb -s dev-1 shell svc data disable",
    );
  });

  test("adbSetNetworkProfile sends speed and delay commands", async () => {
    const android = await importFresh();
    android.adbSetNetworkProfile("emu-5554", "3g");
    expect(networkState.execSyncCalls).toContain(
      "adb -s emu-5554 emu network speed umts",
    );
    expect(networkState.execSyncCalls).toContain(
      "adb -s emu-5554 emu network delay umts",
    );
  });

  test("adbSetNetworkProfile throws on unknown profile", async () => {
    const android = await importFresh();
    expect(() => android.adbSetNetworkProfile("emu-5554", "5g")).toThrow(
      'Unknown network profile "5g"',
    );
  });

  test("adbSetCustomNetwork sends speed and delay with custom values", async () => {
    const android = await importFresh();
    android.adbSetCustomNetwork("emu-5554", 500, 200, 100);
    expect(networkState.execSyncCalls).toContain(
      "adb -s emu-5554 emu network speed 500:200",
    );
    expect(networkState.execSyncCalls).toContain(
      "adb -s emu-5554 emu network delay 100:100",
    );
  });

  test("adbResetNetwork resets speed, delay, and disables airplane mode", async () => {
    const android = await importFresh();
    android.adbResetNetwork("emu-5554");
    expect(networkState.execSyncCalls).toContain(
      "adb -s emu-5554 emu network speed full",
    );
    expect(networkState.execSyncCalls).toContain(
      "adb -s emu-5554 emu network delay none",
    );
    expect(networkState.execSyncCalls).toContain(
      "adb -s emu-5554 shell cmd connectivity airplane-mode disable",
    );
  });
});
