import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findADB, adbShell, adbInstall, adbForward } from "../../device/android.js";
import { allocatePort, releasePort } from "../../core/port-allocator.js";
import { getHealthyWarmDaemon, registerWarmDaemon } from "../../runtime/daemon-manager.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);

export interface UiAutomator2SetupOptions {
  /** Reuse a healthy warm UiAutomator2 server if already running, and leave it up between runs */
  warm?: boolean;
  /** Optional custom daemon registry file path */
  daemonStateFile?: string;
}

function resolveOptionalPackageDir(packageName: string, subpath: string): string | null {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    return resolve(dirname(packageJsonPath), subpath);
  } catch {
    return null;
  }
}

/** Find the UiAutomator2 server APKs */
function findUiAutomator2APK(): { serverApk: string; testApk: string } | null {
  const appiumServerApks = resolveOptionalPackageDir("appium-uiautomator2-server", "apks");
  const projectDrivers = resolve(process.cwd(), "drivers/android");
  const provDrivers = resolve(__dirname, "../../../../drivers/android");
  const maestroRunnerDrivers = resolve(
    __dirname,
    "../../../../../../maestro-runner/drivers/android",
  );

  for (const dir of [projectDrivers, provDrivers, maestroRunnerDrivers, appiumServerApks]) {
    if (!dir) continue;
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir);
    const serverApk = files.find(
      (f) =>
        f.startsWith("appium-uiautomator2-server") &&
        !f.includes("androidTest") &&
        f.endsWith(".apk"),
    );
    const testApk = files.find((f) => f.includes("androidTest") && f.endsWith(".apk"));
    if (serverApk && testApk) {
      return { serverApk: join(dir, serverApk), testApk: join(dir, testApk) };
    }
  }
  return null;
}

/** Install UiAutomator2 server on device */
export function installUiAutomator2(serial: string): void {
  const apks = findUiAutomator2APK();
  if (!apks) {
    throw new Error(
      "UiAutomator2 server APK not found. Install appium-uiautomator2-server or place APKs in drivers/android/",
    );
  }

  console.log(`Installing UiAutomator2 server on ${serial}...`);
  adbInstall(serial, apks.serverApk);
  adbInstall(serial, apks.testApk);
  console.log("UiAutomator2 server installed.");
}

/** Check if UiAutomator2 server is installed on device */
export function isUiAutomator2Installed(serial: string): boolean {
  try {
    const output = adbShell(serial, "pm list packages io.appium.uiautomator2.server");
    return output.includes("io.appium.uiautomator2.server");
  } catch {
    return false;
  }
}

/** Start UiAutomator2 server on device via adb instrument */
export function startUiAutomator2Server(serial: string): void {
  const adb = findADB();
  if (!adb) throw new Error("adb not found");

  try {
    execSync(
      `${adb} -s ${serial} shell am instrument -w -e disableAnalytics true io.appium.uiautomator2.server.test/androidx.test.runner.AndroidJUnitRunner &`,
      { stdio: "ignore", timeout: 5000 },
    );
  } catch {
    // The command may timeout because it blocks — that's expected.
  }
}

/** Full setup: reuse warm daemon or install, start server, forward port */
export async function setupUiAutomator2(
  serial: string,
  hostPort?: number,
  options: UiAutomator2SetupOptions = {},
): Promise<{ host: string; port: number; cleanup: () => void; reusedWarmDaemon?: boolean }> {
  const warm = options.warm ?? process.env["SPANA_WARM_DAEMON"] === "1";

  if (warm) {
    const existing = await getHealthyWarmDaemon("uiautomator2", serial, {
      stateFile: options.daemonStateFile,
    });
    if (existing) {
      console.log(`Reusing warm UiAutomator2 daemon on ${existing.host}:${existing.port}`);
      return {
        host: existing.host,
        port: existing.port,
        reusedWarmDaemon: true,
        cleanup: () => {
          // Keep warm daemon alive between runs
        },
      };
    }
  }

  const port = hostPort ?? allocatePort(8200);

  if (!isUiAutomator2Installed(serial)) {
    installUiAutomator2(serial);
  }

  const adb = findADB();
  if (adb) {
    try {
      execSync(`${adb} -s ${serial} forward --remove tcp:${port}`, { stdio: "ignore" });
    } catch {
      /* ignore — may not exist */
    }
  }

  startUiAutomator2Server(serial);

  await new Promise((r) => setTimeout(r, 2000));

  const devicePort = 6790;
  adbForward(serial, port, devicePort);

  const maxRetries = 10;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/status`);
      if (res.ok) {
        console.log(`UiAutomator2 server ready on port ${port}`);
        if (warm) {
          registerWarmDaemon(
            {
              kind: "uiautomator2",
              deviceId: serial,
              host: "localhost",
              port,
              startedAt: new Date().toISOString(),
            },
            options.daemonStateFile,
          );
        }
        const cleanup = () => {
          if (warm) return;
          try {
            if (adb)
              execSync(`${adb} -s ${serial} forward --remove tcp:${port}`, { stdio: "ignore" });
          } catch {
            /* ignore */
          }
          releasePort(port);
        };
        return { host: "localhost", port, cleanup, reusedWarmDaemon: false };
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  releasePort(port);
  throw new Error(`UiAutomator2 server did not start within ${maxRetries} seconds`);
}
