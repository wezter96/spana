import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as nodeFs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FlowDefinition } from "../api/flow.js";

const cliState = {
  flowPaths: [] as string[],
  flowFiles: new Map<string, FlowDefinition>(),
  filteredFlows: null as FlowDefinition[] | null,
  discoverCalls: [] as string[],
  loadCalls: [] as string[],
  filterCalls: [] as Array<{
    flows: FlowDefinition[];
    opts: { tags?: string[]; grep?: string; platforms: string[] };
  }>,
  orchestrateCalls: [] as Array<{
    flows: FlowDefinition[];
    platforms: Array<{
      platform: string;
      engineConfig: {
        appId: string;
        flowTimeout?: number;
        artifactConfig?: { outputDir?: string };
      };
    }>;
  }>,
  orchestrateResult: {
    results: [] as Array<{
      name: string;
      platform: "web" | "android" | "ios";
      status: "passed" | "failed" | "skipped";
      durationMs: number;
      error?: Error;
    }>,
    totalDurationMs: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
  },
  webDriverArgs: [] as Array<{ headless: boolean; baseUrl: string }>,
  androidDriverArgs: [] as Array<{
    host: string;
    port: number;
    serial: string;
    packageName: string;
  }>,
  iosDriverArgs: [] as Array<{ host: string; port: number; bundleId: string; udid: string }>,
  androidDevice: null as { serial: string; state: string; type: "device" | "emulator" } | null,
  iosSimulator: null as {
    udid: string;
    name: string;
    state: string;
    runtime: string;
    isAvailable: boolean;
  } | null,
  bootCalls: [] as string[],
  androidPackageInstalled: true,
  androidShellCalls: [] as Array<{ serial: string; command: string }>,
  androidInstallCalls: [] as Array<{ serial: string; apkPath: string }>,
  androidForwardCalls: [] as Array<{ serial: string; hostPort: number; devicePort: number }>,
  androidForwardError: null as Error | null,
  existingPaths: new Set<string>(),
  directoryEntries: new Map<string, string[]>(),
  execSyncCalls: [] as string[],
  spawnCalls: [] as Array<{
    command: string;
    args: string[];
    options: { env?: Record<string, string | undefined>; detached?: boolean; stdio?: string };
  }>,
  fetchCalls: [] as string[],
  randomValues: [] as number[],
  killCalls: [] as Array<{ label: string; appId: string }>,
  logs: [] as string[],
};

const createdTempDirs: string[] = [];
const originalConsoleLog = console.log;
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const projectWDAPath = resolve(process.cwd(), "drivers/ios/WebDriverAgent");
let importCounter = 0;

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spana-cli-"));
  createdTempDirs.push(dir);
  return dir;
}

function createFlow(name: string, platforms?: Array<"web" | "android" | "ios">): FlowDefinition {
  return {
    name,
    config: platforms ? { platforms } : {},
    fn: async () => {},
  };
}

function resetCliState(): void {
  cliState.flowPaths = [];
  cliState.flowFiles = new Map();
  cliState.filteredFlows = null;
  cliState.discoverCalls = [];
  cliState.loadCalls = [];
  cliState.filterCalls = [];
  cliState.orchestrateCalls = [];
  cliState.orchestrateResult = {
    results: [],
    totalDurationMs: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
  };
  cliState.webDriverArgs = [];
  cliState.androidDriverArgs = [];
  cliState.iosDriverArgs = [];
  cliState.androidDevice = null;
  cliState.iosSimulator = null;
  cliState.bootCalls = [];
  cliState.androidPackageInstalled = true;
  cliState.androidShellCalls = [];
  cliState.androidInstallCalls = [];
  cliState.androidForwardCalls = [];
  cliState.androidForwardError = null;
  cliState.existingPaths = new Set();
  cliState.directoryEntries = new Map();
  cliState.execSyncCalls = [];
  cliState.spawnCalls = [];
  cliState.fetchCalls = [];
  cliState.randomValues = [];
  cliState.killCalls = [];
  cliState.logs = [];
}

function registerCliMocks(): void {
  mock.module("../core/runner.js", () => ({
    discoverFlows: async (flowDir: string) => {
      cliState.discoverCalls.push(flowDir);
      return cliState.flowPaths;
    },
    loadFlowFile: async (flowPath: string) => {
      cliState.loadCalls.push(flowPath);
      const flow = cliState.flowFiles.get(flowPath);
      if (!flow) {
        throw new Error(`missing flow: ${flowPath}`);
      }
      return flow;
    },
    loadTestSource: async (flowPath: string) => {
      cliState.loadCalls.push(flowPath);
      const flow = cliState.flowFiles.get(flowPath);
      if (!flow) {
        return [];
      }
      return [flow];
    },
    loadStepFiles: async () => {},
    discoverStepFiles: async () => [],
    filterFlows: (
      flows: FlowDefinition[],
      opts: { tags?: string[]; grep?: string; platforms: string[] },
    ) => {
      cliState.filterCalls.push({ flows, opts });
      return cliState.filteredFlows ?? flows;
    },
  }));
}

function writeConfigFile(dir: string, config: Record<string, unknown>): string {
  const configPath = join(dir, "spana.config.ts");
  writeFileSync(configPath, `export default ${JSON.stringify(config)};`, "utf8");
  return configPath;
}

async function importFreshTestCommand() {
  importCounter += 1;
  return (await import(
    new URL(`./test-command.ts?case=${importCounter}`, import.meta.url).href
  )) as typeof import("./test-command.js");
}

describe("runTestCommand", () => {
  beforeEach(() => {
    mock.restore();
    resetCliState();
    registerCliMocks();
    console.log = (...args: unknown[]) => {
      cliState.logs.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    mock.restore();
    console.log = originalConsoleLog;
  });

  afterAll(() => {
    for (const dir of createdTempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns early when no flow files are discovered", async () => {
    const tempDir = createTempDir();
    const configPath = join(tempDir, "missing-config.ts");
    const { runTestCommand } = await importFreshTestCommand();

    const success = await runTestCommand({
      platforms: [],
      configPath,
    });

    expect(success).toBe(true);
    expect(cliState.discoverCalls).toEqual([join(tempDir, "flows")]);
    expect(cliState.logs).toContain("No flow files found.");
  });

  test("accepts new appium-related CLI options in TestCommandOptions", async () => {
    const tempDir = createTempDir();
    const configPath = join(tempDir, "missing-config.ts");
    const { runTestCommand } = await importFreshTestCommand();

    // Verify the function accepts all new fields without type errors
    const success = await runTestCommand({
      platforms: [],
      configPath,
      driver: "local",
      appiumUrl: "http://localhost:4723",
      capsPath: "/tmp/caps.json",
      capsJson: '{"platformName":"Android"}',
      noProviderReporting: true,
    });

    // With no flows, returns true (early exit)
    expect(success).toBe(true);
  });

  test("fails when appium mode is set but no server URL is provided", async () => {
    const tempDir = createTempDir();
    const configPath = writeConfigFile(tempDir, {});
    const { runTestCommand } = await importFreshTestCommand();

    const success = await runTestCommand({
      platforms: ["web"],
      configPath,
      driver: "appium",
    });

    expect(success).toBe(false);
    expect(cliState.logs).toContain(
      "Appium mode requires a server URL. Set --appium-url or execution.appium.serverUrl in config.",
    );
  });

  test("fails when --caps-json contains malformed JSON", async () => {
    const tempDir = createTempDir();
    const configPath = writeConfigFile(tempDir, {});
    const { runTestCommand } = await importFreshTestCommand();

    const success = await runTestCommand({
      platforms: ["web"],
      configPath,
      capsJson: "{bad json",
    });

    expect(success).toBe(false);
    expect(cliState.logs).toContain("Invalid JSON in --caps-json flag.");
  });

  test("fails when --device is used with appium mode", async () => {
    const tempDir = createTempDir();
    const configPath = writeConfigFile(tempDir, {});
    const { runTestCommand } = await importFreshTestCommand();

    const success = await runTestCommand({
      platforms: ["web"],
      configPath,
      driver: "appium",
      appiumUrl: "http://hub.browserstack.com/wd/hub",
      device: "emulator-5554",
    });

    expect(success).toBe(false);
    expect(cliState.logs).toContain(
      "Cannot use --device with appium mode. Use --caps or --caps-json to set device capabilities.",
    );
  });

  test("succeeds in appium mode when --appium-url is provided", async () => {
    const tempDir = createTempDir();
    const configPath = writeConfigFile(tempDir, {});
    cliState.flowPaths = [];
    const { runTestCommand } = await importFreshTestCommand();

    const success = await runTestCommand({
      platforms: ["web"],
      configPath,
      driver: "appium",
      appiumUrl: "http://hub.browserstack.com/wd/hub",
    });

    // No flows found, so returns true (early exit after validation passes)
    expect(success).toBe(true);
  });

  test("succeeds in appium mode when server URL is in config", async () => {
    const tempDir = createTempDir();
    const configPath = writeConfigFile(tempDir, {
      execution: {
        mode: "appium",
        appium: { serverUrl: "http://hub.saucelabs.com/wd/hub" },
      },
    });
    cliState.flowPaths = [];
    const { runTestCommand } = await importFreshTestCommand();

    const success = await runTestCommand({
      platforms: ["web"],
      configPath,
    });

    expect(success).toBe(true);
  });

  test("valid --caps-json passes validation", async () => {
    const tempDir = createTempDir();
    const configPath = writeConfigFile(tempDir, {});
    cliState.flowPaths = [];
    const { runTestCommand } = await importFreshTestCommand();

    const success = await runTestCommand({
      platforms: ["web"],
      configPath,
      capsJson: '{"platformName":"Android","deviceName":"Pixel 6"}',
    });

    // Passes validation, no flows found -> true
    expect(success).toBe(true);
  });

  test("rejects unknown --driver values", async () => {
    const { runTestCommand } = await importFreshTestCommand();

    const success = await runTestCommand({
      platforms: ["web"],
      driver: "selenium" as any,
    });

    expect(success).toBe(false);
    expect(cliState.logs).toContain('Unknown --driver value "selenium". Use "local" or "appium".');
  });

  test("returns early when the filters remove every discovered flow", async () => {
    const tempDir = createTempDir();
    const configPath = writeConfigFile(tempDir, {
      flowDir: "./my-flows",
      platforms: ["web"],
    });
    const flowPath = join(tempDir, "flows", "smoke.flow.ts");
    cliState.flowPaths = [flowPath];
    cliState.flowFiles.set(flowPath, createFlow("Smoke flow"));
    cliState.filteredFlows = [];

    const { runTestCommand } = await importFreshTestCommand();
    const success = await runTestCommand({
      platforms: ["web"],
      grep: "missing",
      configPath,
    });

    expect(success).toBe(true);
    expect(cliState.discoverCalls).toEqual([join(tempDir, "my-flows")]);
    expect(cliState.loadCalls).toEqual([flowPath]);
    expect(cliState.filterCalls[0]?.opts).toEqual({
      tags: undefined,
      grep: "missing",
      platforms: ["web"],
    });
    expect(cliState.logs).toContain("No flows match the given filters.");
  });
});

const wdaInstallerState = {
  existingPaths: new Set<string>(),
  execCalls: [] as string[],
  spawnCalls: [] as Array<{
    command: string;
    args: string[];
    options: { env?: Record<string, string | undefined>; detached?: boolean; stdio?: string };
  }>,
  fetchQueue: [] as Array<"throw" | boolean>,
  fetchCalls: [] as string[],
  unrefCount: 0,
  killCount: 0,
};

const uiaInstallerState = {
  existingPaths: new Set<string>(),
  directoryEntries: new Map<string, string[]>(),
  execCalls: [] as string[],
  versionCandidates: new Set<string>(),
  packageListOutput: "",
  packageListThrows: false,
  instrumentThrows: false,
  fetchQueue: [] as Array<"throw" | boolean>,
  fetchCalls: [] as string[],
};

const projectDriversPath = resolve(process.cwd(), "drivers/android");
const projectXcodeproj = resolve(projectWDAPath, "WebDriverAgent.xcodeproj");
let wdaInstallerImportCounter = 0;
let uiaInstallerImportCounter = 0;
let freshAndroidImportCounter = 0;

function resetWDAInstallerState(): void {
  wdaInstallerState.existingPaths.clear();
  wdaInstallerState.execCalls = [];
  wdaInstallerState.spawnCalls = [];
  wdaInstallerState.fetchQueue = [];
  wdaInstallerState.fetchCalls = [];
  wdaInstallerState.unrefCount = 0;
  wdaInstallerState.killCount = 0;
}

function resetUiInstallerState(): void {
  uiaInstallerState.existingPaths.clear();
  uiaInstallerState.directoryEntries.clear();
  uiaInstallerState.execCalls = [];
  uiaInstallerState.versionCandidates.clear();
  uiaInstallerState.packageListOutput = "";
  uiaInstallerState.packageListThrows = false;
  uiaInstallerState.instrumentThrows = false;
  uiaInstallerState.fetchQueue = [];
  uiaInstallerState.fetchCalls = [];
}

function derivedDataPath(simulatorUDID: string): string {
  return resolve(projectWDAPath, "../../.wda-builds", simulatorUDID);
}

function buildProductsDir(simulatorUDID: string): string {
  return resolve(derivedDataPath(simulatorUDID), "Build", "Products");
}

function registerWDAInstallerMocks(): void {
  mock.module("node:fs", () => ({
    ...nodeFs,
    existsSync: (path: string) => wdaInstallerState.existingPaths.has(String(path)),
  }));
  mock.module("node:child_process", () => ({
    execSync: (command: string) => {
      wdaInstallerState.execCalls.push(command);
      return "";
    },
    spawn: (
      command: string,
      args: string[],
      options: { env?: Record<string, string | undefined>; detached?: boolean; stdio?: string },
    ) => {
      wdaInstallerState.spawnCalls.push({ command, args, options });
      return {
        unref: () => {
          wdaInstallerState.unrefCount += 1;
        },
        kill: () => {
          wdaInstallerState.killCount += 1;
          return true;
        },
      };
    },
  }));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    wdaInstallerState.fetchCalls.push(url);
    const next = wdaInstallerState.fetchQueue.shift() ?? false;
    if (next === "throw") {
      throw new Error("not ready");
    }
    return new Response("", { status: next ? 200 : 500 });
  }) as typeof fetch;
  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0]) => {
    if (typeof handler === "function") {
      handler();
    }
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
}

function registerUiInstallerMocks(): void {
  mock.module("node:fs", () => ({
    ...nodeFs,
    existsSync: (path: string) => uiaInstallerState.existingPaths.has(String(path)),
    readdirSync: (path: string) => uiaInstallerState.directoryEntries.get(String(path)) ?? [],
  }));
  mock.module("node:child_process", () => ({
    execSync: (command: string) => {
      uiaInstallerState.execCalls.push(command);

      if (command.endsWith(" version")) {
        const candidate = command.slice(0, -8);
        if (uiaInstallerState.versionCandidates.has(candidate)) {
          return "Android Debug Bridge version";
        }
        throw new Error("missing adb");
      }

      if (command.includes("pm list packages io.appium.uiautomator2.server")) {
        if (uiaInstallerState.packageListThrows) {
          throw new Error("package lookup failed");
        }
        return uiaInstallerState.packageListOutput;
      }

      if (command.includes(" shell am instrument") && uiaInstallerState.instrumentThrows) {
        throw new Error("instrument timeout");
      }

      return "";
    },
    execFileSync: () => "",
  }));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    uiaInstallerState.fetchCalls.push(url);
    const next = uiaInstallerState.fetchQueue.shift() ?? false;
    if (next === "throw") {
      throw new Error("not ready");
    }
    return new Response("", { status: next ? 200 : 500 });
  }) as typeof fetch;
  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0]) => {
    if (typeof handler === "function") {
      handler();
    }
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
}

async function importFreshWDAInstaller() {
  wdaInstallerImportCounter += 1;
  return (await import(
    new URL(`../drivers/wda/installer.ts?case=${wdaInstallerImportCounter}`, import.meta.url).href
  )) as typeof import("../drivers/wda/installer.js");
}

async function importFreshAndroidModule() {
  freshAndroidImportCounter += 1;
  return (await import(
    new URL(`../device/android.ts?case=${freshAndroidImportCounter}`, import.meta.url).href
  )) as typeof import("../device/android.js");
}

async function importFreshUiInstaller() {
  uiaInstallerImportCounter += 1;
  return (await import(
    new URL(
      `../drivers/uiautomator2/installer.ts?case=${uiaInstallerImportCounter}`,
      import.meta.url,
    ).href
  )) as typeof import("../drivers/uiautomator2/installer.js");
}

describe("wda installer", () => {
  beforeEach(() => {
    mock.restore();
    resetWDAInstallerState();
    registerWDAInstallerMocks();
  });

  afterEach(() => {
    mock.restore();
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });

  test("builds WebDriverAgent using the project-local xcode project", async () => {
    wdaInstallerState.existingPaths.add(projectXcodeproj);
    const installer = await importFreshWDAInstaller();

    const result = installer.buildWDA("SIM-123");

    expect(result).toBe(derivedDataPath("SIM-123"));
    expect(wdaInstallerState.execCalls[0]).toContain("build-for-testing");
    expect(wdaInstallerState.execCalls[0]).toContain(projectXcodeproj);
    expect(wdaInstallerState.execCalls[0]).toContain("platform=iOS Simulator,id=SIM-123");
    expect(wdaInstallerState.execCalls[0]).toContain(
      `-derivedDataPath "${derivedDataPath("SIM-123")}"`,
    );
  });

  test("starts and stops WebDriverAgent with the requested port", async () => {
    wdaInstallerState.existingPaths.add(projectXcodeproj);
    const installer = await importFreshWDAInstaller();

    installer.startWDA("SIM-456", 8127, "/tmp/wda-builds");
    installer.stopWDA();

    expect(wdaInstallerState.spawnCalls).toHaveLength(1);
    expect(wdaInstallerState.spawnCalls[0]).toEqual({
      command: "xcodebuild",
      args: [
        "test-without-building",
        "-project",
        projectXcodeproj,
        "-scheme",
        "WebDriverAgentRunner",
        "-destination",
        "platform=iOS Simulator,id=SIM-456",
        "-derivedDataPath",
        "/tmp/wda-builds",
      ],
      options: expect.objectContaining({
        detached: true,
        stdio: "ignore",
        env: expect.objectContaining({ USE_PORT: "8127" }),
      }),
    });
    expect(wdaInstallerState.unrefCount).toBe(1);
    expect(wdaInstallerState.killCount).toBe(1);
  });

  test("builds on demand and waits for WebDriverAgent readiness", async () => {
    wdaInstallerState.existingPaths.add(projectXcodeproj);
    wdaInstallerState.fetchQueue = ["throw", true];
    const installer = await importFreshWDAInstaller();

    const result = await installer.setupWDA("SIM-READY", 8115);

    expect(result).toMatchObject({ host: "localhost", port: 8115 });
    expect(
      wdaInstallerState.execCalls.some((command) => command.includes("build-for-testing")),
    ).toBe(true);
    expect(wdaInstallerState.spawnCalls).toHaveLength(1);
    expect(wdaInstallerState.fetchCalls).toEqual([
      "http://localhost:8115/status",
      "http://localhost:8115/status",
    ]);
  });

  test("reuses an existing build when products are already present", async () => {
    wdaInstallerState.existingPaths.add(projectXcodeproj);
    wdaInstallerState.existingPaths.add(buildProductsDir("SIM-CACHED"));
    wdaInstallerState.fetchQueue = [true];
    const installer = await importFreshWDAInstaller();

    const result = await installer.setupWDA("SIM-CACHED", 8109);

    expect(result).toMatchObject({ host: "localhost", port: 8109 });
    expect(
      wdaInstallerState.execCalls.some((command) => command.includes("build-for-testing")),
    ).toBe(false);
    expect(wdaInstallerState.spawnCalls).toHaveLength(1);
  });
});

describe("uiautomator2 installer", () => {
  beforeEach(() => {
    mock.restore();
    resetUiInstallerState();
    registerUiInstallerMocks();
  });

  afterEach(() => {
    mock.restore();
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });

  test("installs both UiAutomator2 APKs from the project drivers directory", async () => {
    uiaInstallerState.versionCandidates.add("adb");
    uiaInstallerState.existingPaths.add(projectDriversPath);
    uiaInstallerState.directoryEntries.set(projectDriversPath, [
      "appium-uiautomator2-server-v1.apk",
      "appium-uiautomator2-server-androidTest.apk",
    ]);

    const androidModule = await importFreshAndroidModule();
    mock.module("../device/android.js", () => androidModule);
    const installer = await importFreshUiInstaller();

    installer.installUiAutomator2("SERIAL-1");

    expect(uiaInstallerState.execCalls).toEqual([
      "adb version",
      `adb -s SERIAL-1 install -r ${join(projectDriversPath, "appium-uiautomator2-server-v1.apk")}`,
      "adb version",
      `adb -s SERIAL-1 install -r ${join(projectDriversPath, "appium-uiautomator2-server-androidTest.apk")}`,
    ]);
  });

  test("installs on demand, starts the server, forwards the port, and waits for readiness", async () => {
    uiaInstallerState.versionCandidates.add("adb");
    uiaInstallerState.existingPaths.add(projectDriversPath);
    uiaInstallerState.directoryEntries.set(projectDriversPath, [
      "appium-uiautomator2-server-v1.apk",
      "appium-uiautomator2-server-androidTest.apk",
    ]);
    uiaInstallerState.packageListOutput = "";
    uiaInstallerState.fetchQueue = ["throw", true];

    const androidModule = await importFreshAndroidModule();
    mock.module("../device/android.js", () => androidModule);
    const installer = await importFreshUiInstaller();

    const result = await installer.setupUiAutomator2("SERIAL-2", 8214);

    expect(result).toMatchObject({ host: "localhost", port: 8214 });
    expect(uiaInstallerState.execCalls.some((command) => command.includes("install -r"))).toBe(
      true,
    );
    expect(
      uiaInstallerState.execCalls.some((command) =>
        command.includes(
          "shell am instrument -w -e disableAnalytics true io.appium.uiautomator2.server.test/androidx.test.runner.AndroidJUnitRunner &",
        ),
      ),
    ).toBe(true);
    expect(
      uiaInstallerState.execCalls.some((command) => command.includes("forward tcp:8214 tcp:6790")),
    ).toBe(true);
    expect(uiaInstallerState.fetchCalls).toEqual([
      "http://localhost:8214/status",
      "http://localhost:8214/status",
    ]);
  });

  test("tolerates a blocking instrumentation timeout while the server starts", async () => {
    uiaInstallerState.versionCandidates.add("adb");
    uiaInstallerState.instrumentThrows = true;

    const androidModule = await importFreshAndroidModule();
    mock.module("../device/android.js", () => androidModule);
    const installer = await importFreshUiInstaller();

    expect(() => installer.startUiAutomator2Server("SERIAL-3")).not.toThrow();
  });
});
