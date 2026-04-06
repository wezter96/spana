import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as nodeFs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();
const tempDirs: string[] = [];
let importCounter = 0;

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spana-config-loader-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  mock.restore();
  process.chdir(originalCwd);
});

afterAll(() => {
  process.chdir(originalCwd);
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function importFreshConfigLoader() {
  importCounter += 1;
  return (await import(
    new URL(`./config-loader.ts?case=${importCounter}`, import.meta.url).href
  )) as typeof import("./config-loader.js");
}

describe("config loader", () => {
  test("loads and resolves relative config paths", async () => {
    const tempDir = createTempDir();
    const configPath = join(tempDir, "spana.config.ts");
    writeFileSync(
      configPath,
      `export default {
        flowDir: "./flows",
        artifacts: { outputDir: "./artifacts" },
        apps: { android: { packageName: "com.example.app", appPath: "./builds/app.apk" } },
        execution: {
          web: {
            storageState: "./auth/storage-state.json"
          },
          appium: {
            capabilitiesFile: "./caps.json",
            browserstack: {
              app: { path: "./uploads/browserstack.apk" },
              local: { binary: "./bin/BrowserStackLocal" }
            },
            saucelabs: {
              app: { path: "./uploads/sauce.apk" },
              connect: { binary: "./bin/sc" }
            }
          }
        }
      };`,
      "utf8",
    );

    mock.module("node:fs", () => ({
      ...nodeFs,
      existsSync: (path: string) => String(path) === configPath,
    }));
    const { loadConfig } = await importFreshConfigLoader();
    const result = await loadConfig({ configPath });

    expect(result.configPath).toBe(configPath);
    expect(result.config.flowDir).toBe(join(tempDir, "flows"));
    expect(result.config.artifacts?.outputDir).toBe(join(tempDir, "artifacts"));
    expect(result.config.apps?.android?.appPath).toBe(join(tempDir, "builds", "app.apk"));
    expect(result.config.execution?.web?.storageState).toBe(
      join(tempDir, "auth", "storage-state.json"),
    );
    expect(result.config.execution?.appium?.capabilitiesFile).toBe(join(tempDir, "caps.json"));
    expect(result.config.execution?.appium?.browserstack?.app?.path).toBe(
      join(tempDir, "uploads", "browserstack.apk"),
    );
    expect(result.config.execution?.appium?.browserstack?.local?.binary).toBe(
      join(tempDir, "bin", "BrowserStackLocal"),
    );
    expect(result.config.execution?.appium?.saucelabs?.app?.path).toBe(
      join(tempDir, "uploads", "sauce.apk"),
    );
    expect(result.config.execution?.appium?.saucelabs?.connect?.binary).toBe(
      join(tempDir, "bin", "sc"),
    );
  });

  test("returns an empty config when missing configs are allowed", async () => {
    const tempDir = createTempDir();
    process.chdir(tempDir);

    mock.module("node:fs", () => ({
      ...nodeFs,
      existsSync: () => false,
    }));
    const { loadConfig } = await importFreshConfigLoader();
    const result = await loadConfig({ allowMissing: true });

    expect(result).toEqual({ config: {} });
  });

  test("throws a formatted validation error for invalid configs", async () => {
    const tempDir = createTempDir();
    const configPath = join(tempDir, "spana.config.ts");
    writeFileSync(
      configPath,
      `export default {
        platforms: ["tvOS"],
        reporters: ["console"]
      };`,
      "utf8",
    );

    mock.module("node:fs", () => ({
      ...nodeFs,
      existsSync: (path: string) => String(path) === configPath,
    }));
    const { loadConfig } = await importFreshConfigLoader();
    await expect(loadConfig({ configPath })).rejects.toThrow(
      `Config validation failed for ${configPath}:\n- platforms.0: Invalid option: expected one of "web"|"android"|"ios"`,
    );
  });
});
