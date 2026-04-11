import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCapabilities } from "./capabilities.js";

const createdTempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spana-caps-"));
  createdTempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveCapabilities", () => {
  test("returns config capabilities when no file or CLI caps given", async () => {
    const result = await resolveCapabilities(
      { capabilities: { platformName: "Android", deviceName: "Pixel 6" } },
      {},
    );
    expect(result).toEqual({ platformName: "Android", deviceName: "Pixel 6" });
  });

  test("returns empty object when no sources are provided", async () => {
    const result = await resolveCapabilities({}, {});
    expect(result).toEqual({});
  });

  test("loads capabilities from a JSON file", async () => {
    const dir = createTempDir();
    const capsFile = join(dir, "caps.json");
    writeFileSync(capsFile, JSON.stringify({ browserName: "chrome", platformVersion: "14" }));

    const result = await resolveCapabilities({}, { capsPath: capsFile });
    expect(result).toEqual({ browserName: "chrome", platformVersion: "14" });
  });

  test("uses config capabilitiesFile when --caps is not provided", async () => {
    const dir = createTempDir();
    const capsFile = join(dir, "default-caps.json");
    writeFileSync(capsFile, JSON.stringify({ app: "bs://abc123" }));

    const result = await resolveCapabilities({ capabilitiesFile: capsFile }, {});
    expect(result).toEqual({ app: "bs://abc123" });
  });

  test("--caps flag overrides config capabilitiesFile", async () => {
    const dir = createTempDir();
    const configFile = join(dir, "config-caps.json");
    const cliFile = join(dir, "cli-caps.json");
    writeFileSync(configFile, JSON.stringify({ source: "config-file" }));
    writeFileSync(cliFile, JSON.stringify({ source: "cli-file" }));

    const result = await resolveCapabilities(
      { capabilitiesFile: configFile },
      { capsPath: cliFile },
    );
    expect(result).toEqual({ source: "cli-file" });
  });

  test("merges config caps + file caps + CLI JSON caps with correct precedence", async () => {
    const dir = createTempDir();
    const capsFile = join(dir, "caps.json");
    writeFileSync(capsFile, JSON.stringify({ platformName: "iOS", deviceName: "file-device" }));

    const result = await resolveCapabilities(
      {
        capabilities: { platformName: "Android", app: "my-app.apk", deviceName: "config-device" },
      },
      {
        capsPath: capsFile,
        capsJson: JSON.stringify({ deviceName: "cli-device" }),
      },
    );

    // config: platformName=Android, app=my-app.apk, deviceName=config-device
    // file:   platformName=iOS, deviceName=file-device  (overrides config)
    // cli:    deviceName=cli-device                     (overrides file)
    expect(result).toEqual({
      platformName: "iOS",
      app: "my-app.apk",
      deviceName: "cli-device",
    });
  });

  test("parses inline --caps-json", async () => {
    const result = await resolveCapabilities(
      {},
      { capsJson: '{"browserName":"safari","platformVersion":"17"}' },
    );
    expect(result).toEqual({ browserName: "safari", platformVersion: "17" });
  });

  test("maps launchOptions.deviceState into Appium capabilities", async () => {
    const result = await resolveCapabilities(
      {},
      {
        platform: "ios",
        launchOptions: {
          deviceState: {
            language: "fr",
            locale: "fr_CA",
            timeZone: "America/Toronto",
          },
        },
      },
    );

    expect(result).toEqual({
      "appium:language": "fr",
      "appium:locale": "fr_CA",
      "appium:appTimeZone": "America/Toronto",
    });
  });

  test("explicit capabilities override typed deviceState defaults", async () => {
    const result = await resolveCapabilities(
      {
        capabilities: {
          "appium:language": "en",
          "appium:locale": "en_US",
        },
        platformCapabilities: {
          ios: {
            "appium:appTimeZone": "UTC",
          },
        },
      },
      {
        platform: "ios",
        launchOptions: {
          deviceState: {
            language: "fr",
            locale: "fr_CA",
            timeZone: "America/Toronto",
          },
        },
      },
    );

    expect(result).toEqual({
      "appium:language": "en",
      "appium:locale": "en_US",
      "appium:appTimeZone": "UTC",
    });
  });

  test("normalizes combined locale values for Appium Android", async () => {
    const result = await resolveCapabilities(
      {},
      {
        platform: "android",
        launchOptions: {
          deviceState: {
            locale: "fr_CA",
          },
        },
      },
    );

    expect(result).toEqual({
      "appium:language": "fr",
      "appium:locale": "CA",
    });
  });

  test("rejects Android deviceState when only one of language or locale is provided", async () => {
    await expect(
      resolveCapabilities(
        {},
        {
          platform: "android",
          launchOptions: {
            deviceState: {
              language: "fr",
            },
          },
        },
      ),
    ).rejects.toThrow("Appium Android deviceState requires both language and locale");
  });

  test("throws on malformed caps file", async () => {
    const dir = createTempDir();
    const capsFile = join(dir, "bad.json");
    writeFileSync(capsFile, "not json at all");

    expect(resolveCapabilities({}, { capsPath: capsFile })).rejects.toThrow();
  });

  test("throws on malformed --caps-json", async () => {
    expect(resolveCapabilities({}, { capsJson: "{bad json" })).rejects.toThrow();
  });
});
