import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config-loader.js";

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spana-config-loader-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  process.chdir(originalCwd);
});

afterAll(() => {
  process.chdir(originalCwd);
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
            storageState: "./auth/storage-state.json",
            storybook: {
              url: "http://localhost:6006",
              iframePath: "/iframe.html"
            }
          },
          appium: {
            capabilitiesFile: "./caps.json",
            cloudProvider: "./providers/custom.ts",
            browserstack: {
              app: { path: "./uploads/browserstack.apk" },
              local: { binary: "./bin/BrowserStackLocal" }
            },
            saucelabs: {
              app: { path: "./uploads/sauce.apk" },
              connect: { binary: "./bin/sc" }
            }
          }
        },
        visualRegression: {
          baselinesDir: "./visual-baselines"
        }
      };`,
      "utf8",
    );

    const result = await loadConfig({ configPath });

    expect(result.configPath).toBe(configPath);
    expect(result.config.flowDir).toBe(join(tempDir, "flows"));
    expect(result.config.artifacts?.outputDir).toBe(join(tempDir, "artifacts"));
    expect(result.config.apps?.android?.appPath).toBe(join(tempDir, "builds", "app.apk"));
    expect(result.config.execution?.web?.storageState).toBe(
      join(tempDir, "auth", "storage-state.json"),
    );
    expect(result.config.execution?.web?.storybook).toEqual({
      url: "http://localhost:6006",
      iframePath: "/iframe.html",
    });
    expect(result.config.execution?.appium?.capabilitiesFile).toBe(join(tempDir, "caps.json"));
    expect(result.config.execution?.appium?.cloudProvider).toBe(
      join(tempDir, "providers", "custom.ts"),
    );
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
    expect(result.config.visualRegression?.baselinesDir).toBe(join(tempDir, "visual-baselines"));
  });

  test("returns an empty config when missing configs are allowed", async () => {
    const tempDir = createTempDir();
    process.chdir(tempDir);

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

    await expect(loadConfig({ configPath })).rejects.toThrow(
      `Config validation failed for ${configPath}:\n- platforms.0: Invalid option: expected one of "web"|"android"|"ios"`,
    );
  });
});
