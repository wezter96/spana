import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allocatePort, releasePort } from "../../core/port-allocator.js";
import { getHealthyWarmDaemon, registerWarmDaemon } from "../../runtime/daemon-manager.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);

export interface WDASetupOptions {
  /** Reuse a healthy warm WDA daemon if already running, and leave it up between runs */
  warm?: boolean;
  /** Optional custom daemon registry file path */
  daemonStateFile?: string;
}

function resolveOptionalPackageDir(packageName: string): string | null {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    return dirname(packageJsonPath);
  } catch {
    return null;
  }
}

/** Find the WDA Xcode project directory */
function findWDAProject(): string | null {
  const appiumWDA = resolveOptionalPackageDir("appium-webdriveragent");
  const projectWDA = resolve(process.cwd(), "drivers/ios/WebDriverAgent");
  const provWDA = resolve(__dirname, "../../../../drivers/ios/WebDriverAgent");
  const maestroRunnerWDA = resolve(
    __dirname,
    "../../../../../../maestro-runner/drivers/ios/WebDriverAgent",
  );

  for (const wdaPath of [projectWDA, provWDA, maestroRunnerWDA, appiumWDA]) {
    if (!wdaPath) continue;
    if (existsSync(resolve(wdaPath, "WebDriverAgent.xcodeproj"))) {
      return wdaPath;
    }
  }
  return null;
}

/**
 * Locate the cached `*.xctestrun` file produced by `xcodebuild build-for-testing`
 * inside `<derivedDataPath>/Build/Products/`. Using `-xctestrun` avoids Xcode
 * reparsing the project graph on every `test-without-building` invocation.
 */
export function findXctestrunFile(derivedDataPath: string): string | null {
  const productsDir = resolve(derivedDataPath, "Build", "Products");
  if (!existsSync(productsDir)) return null;
  try {
    const files = readdirSync(productsDir);
    const xctestrun = files.find((f) => f.endsWith(".xctestrun") && !f.startsWith("._"));
    return xctestrun ? join(productsDir, xctestrun) : null;
  } catch {
    return null;
  }
}

/** Build WDA for a specific simulator using build-for-testing */
export function buildWDA(simulatorUDID: string): string {
  const wdaPath = findWDAProject();
  if (!wdaPath) {
    throw new Error(
      "WebDriverAgent project not found. Install appium-webdriveragent or place WDA in drivers/ios/WebDriverAgent/",
    );
  }

  const derivedDataPath = resolve(wdaPath, "../../.wda-builds", simulatorUDID);

  console.log("Building WebDriverAgent for simulator...");

  execSync(
    [
      "xcodebuild",
      "build-for-testing",
      `-project "${resolve(wdaPath, "WebDriverAgent.xcodeproj")}"`,
      "-scheme WebDriverAgentRunner",
      `-destination "platform=iOS Simulator,id=${simulatorUDID}"`,
      `-derivedDataPath "${derivedDataPath}"`,
      'CODE_SIGN_IDENTITY=""',
      "CODE_SIGNING_REQUIRED=NO",
      "CODE_SIGNING_ALLOWED=NO",
      "GCC_TREAT_WARNINGS_AS_ERRORS=0",
      "-quiet",
    ].join(" "),
    { stdio: "inherit", timeout: 600_000 },
  );

  console.log("WebDriverAgent built successfully.");
  return derivedDataPath;
}

/**
 * Build the `xcodebuild test-without-building` argument list.
 * Prefers cached `-xctestrun <file>` when present (no compile/scheme resolution).
 */
export function buildWdaLaunchArgs(params: {
  udid: string;
  isPhysicalDevice: boolean;
  derivedDataPath: string;
  wdaProjectPath?: string;
  xctestrunPath?: string | null;
}): string[] {
  const destination = params.isPhysicalDevice
    ? `id=${params.udid}`
    : `platform=iOS Simulator,id=${params.udid}`;

  if (params.xctestrunPath) {
    return [
      "test-without-building",
      "-xctestrun",
      params.xctestrunPath,
      "-destination",
      destination,
    ];
  }

  return [
    "test-without-building",
    "-project",
    resolve(params.wdaProjectPath ?? "", "WebDriverAgent.xcodeproj"),
    "-scheme",
    "WebDriverAgentRunner",
    "-destination",
    destination,
    "-derivedDataPath",
    params.derivedDataPath,
  ];
}

/** Start WDA on a simulator using xcodebuild test-without-building */
export function startWDA(
  simulatorUDID: string,
  port: number = 8100,
  derivedDataPath?: string,
): ChildProcess {
  const wdaPath = findWDAProject();
  if (!wdaPath) {
    throw new Error("WebDriverAgent project not found");
  }

  const ddPath = derivedDataPath ?? resolve(wdaPath, "../../.wda-builds", simulatorUDID);
  const xctestrunPath = findXctestrunFile(ddPath);

  // Set both USE_PORT and TEST_RUNNER_USE_PORT so WDA honors the port whether
  // launched via -xctestrun or via -project/-scheme.
  const env = {
    ...process.env,
    USE_PORT: String(port),
    TEST_RUNNER_USE_PORT: String(port),
  };

  console.log(`Starting WebDriverAgent on port ${port}...`);

  const args = buildWdaLaunchArgs({
    udid: simulatorUDID,
    isPhysicalDevice: false,
    derivedDataPath: ddPath,
    wdaProjectPath: wdaPath,
    xctestrunPath,
  });

  const child = spawn("xcodebuild", args, { env, stdio: "ignore", detached: true });

  child.unref();
  return child;
}

/** Stop a specific WDA process spawned by startWDA/startWDAOnDevice. */
export function stopWDA(proc: ChildProcess | null | undefined): void {
  if (proc) {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }
}

/** Build WDA for a physical device with code signing */
export function buildWDAForDevice(
  deviceUDID: string,
  teamId: string,
  signingIdentity = "Apple Development",
): string {
  const wdaPath = findWDAProject();
  if (!wdaPath) {
    throw new Error(
      "WebDriverAgent project not found. Install appium-webdriveragent or place WDA in drivers/ios/WebDriverAgent/",
    );
  }

  const derivedDataPath = resolve(wdaPath, "../../.wda-builds", deviceUDID);

  console.log("Building WebDriverAgent for physical device...");

  execSync(
    [
      "xcodebuild",
      "build-for-testing",
      `-project "${resolve(wdaPath, "WebDriverAgent.xcodeproj")}"`,
      "-scheme WebDriverAgentRunner",
      `-destination "platform=iOS,id=${deviceUDID}"`,
      `-derivedDataPath "${derivedDataPath}"`,
      `DEVELOPMENT_TEAM=${teamId}`,
      `CODE_SIGN_IDENTITY="${signingIdentity}"`,
      "CODE_SIGNING_REQUIRED=YES",
      "CODE_SIGNING_ALLOWED=YES",
      "GCC_TREAT_WARNINGS_AS_ERRORS=0",
      "-allowProvisioningUpdates",
      "-quiet",
    ].join(" "),
    { stdio: "inherit", timeout: 600_000 },
  );

  console.log("WebDriverAgent built for device successfully.");
  return derivedDataPath;
}

/** Start WDA on a physical device */
export function startWDAOnDevice(
  deviceUDID: string,
  port: number = 8100,
  derivedDataPath?: string,
): ChildProcess {
  const wdaPath = findWDAProject();
  if (!wdaPath) throw new Error("WebDriverAgent project not found");

  const ddPath = derivedDataPath ?? resolve(wdaPath, "../../.wda-builds", deviceUDID);
  const xctestrunPath = findXctestrunFile(ddPath);
  const env = {
    ...process.env,
    USE_PORT: String(port),
    TEST_RUNNER_USE_PORT: String(port),
  };

  console.log(`Starting WebDriverAgent on physical device (port ${port})...`);

  const args = buildWdaLaunchArgs({
    udid: deviceUDID,
    isPhysicalDevice: true,
    derivedDataPath: ddPath,
    wdaProjectPath: wdaPath,
    xctestrunPath,
  });

  const child = spawn("xcodebuild", args, { env, stdio: "ignore", detached: true });

  child.unref();
  return child;
}

/** Full setup for physical device: reuse warm daemon or build, start WDA, tunnel via iproxy, wait for ready */
export async function setupWDAForDevice(
  deviceUDID: string,
  port: number = 8100,
  teamId: string,
  signingIdentity?: string,
  options: WDASetupOptions = {},
): Promise<{
  host: string;
  port: number;
  cleanup: () => void;
  reusedWarmDaemon?: boolean;
  warmSessionId?: string;
}> {
  const warm = options.warm ?? process.env["SPANA_WARM_DAEMON"] === "1";

  if (warm) {
    const existing = await getHealthyWarmDaemon("wda", deviceUDID, {
      stateFile: options.daemonStateFile,
    });
    if (existing) {
      console.log(`Reusing warm WebDriverAgent daemon on ${existing.host}:${existing.port}`);
      return {
        host: existing.host,
        port: existing.port,
        reusedWarmDaemon: true,
        warmSessionId: existing.sessionId,
        cleanup: () => {
          // Intentionally keep warm daemon running across runs
        },
      };
    }
  }

  let wdaProcess: ChildProcess | null = null;
  let tunnel: { host: string; port: number; cleanup: () => void } | null = null;

  try {
    const wdaPath = findWDAProject();
    if (!wdaPath) throw new Error("WebDriverAgent project not found");

    const derivedDataPath = resolve(wdaPath, "../../.wda-builds", deviceUDID);
    const buildProductsDir = resolve(derivedDataPath, "Build", "Products");

    if (!existsSync(buildProductsDir)) {
      buildWDAForDevice(deviceUDID, teamId, signingIdentity);
    }

    wdaProcess = startWDAOnDevice(deviceUDID, 8100, derivedDataPath);

    const { startIproxy } = await import("../../device/ios.js");
    tunnel = startIproxy(deviceUDID, port, 8100);

    const maxRetries = 45;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const res = await fetch(`http://localhost:${tunnel.port}/status`);
        if (res.ok) {
          console.log(`WebDriverAgent ready on physical device (port ${tunnel.port})`);
          const activeProcess = wdaProcess;
          const activeTunnel = tunnel;
          if (warm) {
            registerWarmDaemon(
              {
                kind: "wda",
                deviceId: deviceUDID,
                host: activeTunnel.host,
                port: activeTunnel.port,
                pid: activeProcess.pid,
                xctestrunPath: findXctestrunFile(derivedDataPath) ?? undefined,
                startedAt: new Date().toISOString(),
              },
              options.daemonStateFile,
            );
          }
          return {
            host: activeTunnel.host,
            port: activeTunnel.port,
            reusedWarmDaemon: false,
            cleanup: () => {
              if (warm) return;
              stopWDA(activeProcess);
              activeTunnel.cleanup();
              releasePort(port);
            },
          };
        }
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    throw new Error(`WebDriverAgent did not start on device within ${maxRetries} seconds`);
  } catch (error) {
    stopWDA(wdaProcess);
    tunnel?.cleanup();
    releasePort(port);
    throw error;
  }
}

/** Full setup: reuse warm daemon or build if needed, start WDA, wait for it to be ready */
export async function setupWDA(
  simulatorUDID: string,
  port?: number,
  options: WDASetupOptions = {},
): Promise<{
  host: string;
  port: number;
  cleanup: () => void;
  reusedWarmDaemon?: boolean;
  warmSessionId?: string;
}> {
  const warm = options.warm ?? process.env["SPANA_WARM_DAEMON"] === "1";

  if (warm) {
    const existing = await getHealthyWarmDaemon("wda", simulatorUDID, {
      stateFile: options.daemonStateFile,
    });
    if (existing) {
      console.log(`Reusing warm WebDriverAgent daemon on ${existing.host}:${existing.port}`);
      return {
        host: existing.host,
        port: existing.port,
        reusedWarmDaemon: true,
        warmSessionId: existing.sessionId,
        cleanup: () => {
          // Keep warm daemon alive between runs
        },
      };
    }
  }

  const actualPort = port ?? allocatePort(8100);
  const wdaPath = findWDAProject();
  if (!wdaPath) {
    throw new Error("WebDriverAgent project not found");
  }

  const derivedDataPath = resolve(wdaPath, "../../.wda-builds", simulatorUDID);
  const buildProductsDir = resolve(derivedDataPath, "Build", "Products");

  if (!existsSync(buildProductsDir)) {
    buildWDA(simulatorUDID);
  }

  const wdaProcess = startWDA(simulatorUDID, actualPort, derivedDataPath);

  const maxRetries = 60;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`http://localhost:${actualPort}/status`);
      if (res.ok) {
        console.log(`WebDriverAgent ready on port ${actualPort}`);
        if (warm) {
          registerWarmDaemon(
            {
              kind: "wda",
              deviceId: simulatorUDID,
              host: "localhost",
              port: actualPort,
              pid: wdaProcess.pid,
              xctestrunPath: findXctestrunFile(derivedDataPath) ?? undefined,
              startedAt: new Date().toISOString(),
            },
            options.daemonStateFile,
          );
        }
        return {
          host: "localhost",
          port: actualPort,
          reusedWarmDaemon: false,
          cleanup: () => {
            if (warm) return;
            stopWDA(wdaProcess);
            releasePort(actualPort);
          },
        };
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  stopWDA(wdaProcess);
  releasePort(actualPort);
  throw new Error(`WebDriverAgent did not start within ${maxRetries} seconds`);
}
