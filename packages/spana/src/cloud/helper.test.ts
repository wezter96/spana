import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];
let importCounter = 0;

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spana-cloud-helper-"));
  tempDirs.push(dir);
  return dir;
}

function createTempApp(name: string): string {
  const dir = createTempDir();
  const filePath = join(dir, name);
  writeFileSync(filePath, "app-bytes");
  return filePath;
}

const helperState = {
  uploadCalls: [] as Array<{
    url: string;
    auth: string;
    fileField: string;
    filePath: string;
    fileName?: string;
    fields?: Record<string, string>;
  }>,
  uploadResponses: [] as Array<Record<string, unknown>>,
  processCalls: [] as Array<{ label: string; command: string; args: string[] }>,
  processStops: [] as string[],
};

function resetHelperState() {
  helperState.uploadCalls = [];
  helperState.uploadResponses = [];
  helperState.processCalls = [];
  helperState.processStops = [];
}

async function importFreshProviderModule() {
  importCounter += 1;
  return (await import(
    new URL(`./provider.ts?case=${importCounter}`, import.meta.url).href
  )) as typeof import("./provider.js");
}

beforeEach(() => {
  mock.restore();
  resetHelperState();
  mock.module("./common.js", () => ({
    hasConfig: (value: unknown) =>
      value !== undefined &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as Record<string, unknown>).length > 0,
    parseAppiumCredentials: (appiumUrl: string, label: string) => {
      const url = new URL(appiumUrl);
      const username = decodeURIComponent(url.username);
      const password = decodeURIComponent(url.password);
      if (!username || !password) {
        throw new Error(
          `${label} helper features require credentials in execution.appium.serverUrl.`,
        );
      }
      return { url, username, password };
    },
    readOptionRecord: (value: unknown, fieldName: string) => {
      if (value === undefined) return {};
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
      throw new Error(`${fieldName} must be an object.`);
    },
    uploadMultipartJson: async (options: {
      url: string;
      auth: string;
      fileField: string;
      filePath: string;
      fileName?: string;
      fields?: Record<string, string>;
    }) => {
      helperState.uploadCalls.push(options);
      const response = helperState.uploadResponses.shift();
      if (!response) {
        throw new Error("Unexpected upload");
      }
      return response;
    },
    startManagedProcess: async (options: { label: string; command: string; args: string[] }) => {
      helperState.processCalls.push(options);
      return async () => {
        helperState.processStops.push(options.label);
      };
    },
  }));
});

describe("createCloudProviderHelper", () => {
  test("returns a no-op helper for generic Appium URLs without provider config", async () => {
    const { createCloudProviderHelper } = await importFreshProviderModule();
    const helper = createCloudProviderHelper("http://localhost:4723", {});
    const caps = await helper.prepareCapabilities("android", { platformName: "Android" });
    expect(caps).toEqual({ platformName: "Android" });
    await helper.cleanup();
  });

  test("rejects helper config for unknown Appium providers", async () => {
    const { createCloudProviderHelper } = await importFreshProviderModule();
    expect(() =>
      createCloudProviderHelper("http://localhost:4723", {
        browserstack: { local: { enabled: true } },
      }),
    ).toThrow("Provider helper config requires a BrowserStack or Sauce Labs Appium URL.");
  });

  test("rejects BrowserStack helper config for Sauce Labs URLs", async () => {
    const { createCloudProviderHelper } = await importFreshProviderModule();
    expect(() =>
      createCloudProviderHelper("https://user:key@ondemand.us-west-1.saucelabs.com/wd/hub", {
        browserstack: { local: { enabled: true } },
      }),
    ).toThrow("BrowserStack helper config requires a BrowserStack Appium URL.");
  });
});

describe("BrowserStack cloud helper", () => {
  test("uploads apps, augments bstack options, and starts BrowserStack Local", async () => {
    const appPath = createTempApp("browserstack.apk");
    helperState.uploadResponses = [{ app_url: "bs://uploaded-app" }];
    const { createCloudProviderHelper } = await importFreshProviderModule();

    const helper = createCloudProviderHelper("https://user:key@hub-cloud.browserstack.com/wd/hub", {
      browserstack: {
        app: { path: appPath, name: "managed.apk", customId: "spana-app" },
        local: { enabled: true, identifier: "local-1", binary: "/tmp/BrowserStackLocal" },
        options: { projectName: "spana", buildName: "config-build" },
      },
    });

    const caps = await helper.prepareCapabilities("android", {
      "bstack:options": { buildName: "caps-build" },
    });

    expect(caps["appium:app"]).toBe("bs://uploaded-app");
    expect(caps["bstack:options"]).toEqual({
      projectName: "spana",
      buildName: "caps-build",
      local: true,
      localIdentifier: "local-1",
    });
    expect(helperState.uploadCalls).toEqual([
      {
        url: "https://api-cloud.browserstack.com/app-automate/upload",
        auth: `Basic ${Buffer.from("user:key").toString("base64")}`,
        fileField: "file",
        filePath: appPath,
        fileName: "managed.apk",
        fields: { custom_id: "spana-app" },
      },
    ]);
    expect(helperState.processCalls).toContainEqual(
      expect.objectContaining({
        label: "BrowserStack Local",
        command: "/tmp/BrowserStackLocal",
        args: ["--key", "key", "--local-identifier", "local-1"],
      }),
    );

    await helper.cleanup();
    expect(helperState.processStops).toEqual(["BrowserStack Local"]);
  });

  test("prefers explicit capabilities over helper defaults and skips upload when app is already set", async () => {
    const { createCloudProviderHelper } = await importFreshProviderModule();
    const helper = createCloudProviderHelper("https://user:key@hub-cloud.browserstack.com/wd/hub", {
      browserstack: {
        app: { path: "/tmp/unused.apk" },
        local: { enabled: true, identifier: "config-id", binary: "/tmp/BrowserStackLocal" },
        options: { projectName: "config-project" },
      },
    });

    const caps = await helper.prepareCapabilities("android", {
      "appium:app": "bs://from-caps",
      "bstack:options": {
        projectName: "caps-project",
        local: true,
        localIdentifier: "caps-id",
      },
    });

    expect(caps["appium:app"]).toBe("bs://from-caps");
    expect(caps["bstack:options"]).toEqual({
      projectName: "caps-project",
      local: true,
      localIdentifier: "caps-id",
    });
    expect(helperState.uploadCalls).toHaveLength(0);
    expect(helperState.processCalls).toContainEqual(
      expect.objectContaining({
        label: "BrowserStack Local",
        command: "/tmp/BrowserStackLocal",
        args: ["--key", "key", "--local-identifier", "caps-id"],
      }),
    );
  });
});

describe("Sauce Labs cloud helper", () => {
  test("uploads apps, augments sauce options, and starts Sauce Connect", async () => {
    const appPath = createTempApp("saucelabs.apk");
    helperState.uploadResponses = [{ item: { id: "storage-id-1" } }];
    const { createCloudProviderHelper } = await importFreshProviderModule();

    const helper = createCloudProviderHelper(
      "https://user:key@ondemand.us-west-1.saucelabs.com/wd/hub",
      {
        saucelabs: {
          app: { path: appPath, name: "managed.apk" },
          connect: { enabled: true, binary: "/tmp/sc" },
          options: { build: "config-build" },
        },
      },
    );

    const caps = await helper.prepareCapabilities("android", {
      "sauce:options": { name: "caps-name" },
    });

    expect(caps["appium:app"]).toBe("storage:storage-id-1");
    expect(caps["sauce:options"]).toEqual({
      build: "config-build",
      name: "caps-name",
      tunnelName: `spana-${process.pid}`,
    });
    expect(helperState.uploadCalls).toEqual([
      {
        url: "https://api.us-west.saucelabs.com/v1/storage/upload",
        auth: `Basic ${Buffer.from("user:key").toString("base64")}`,
        fileField: "payload",
        filePath: appPath,
        fileName: "managed.apk",
        fields: { name: "managed.apk" },
      },
    ]);
    expect(helperState.processCalls).toContainEqual(
      expect.objectContaining({
        label: "Sauce Connect",
        command: "/tmp/sc",
        args: [
          "run",
          "--username",
          "user",
          "--access-key",
          "key",
          "--region",
          "us-west",
          "--tunnel-name",
          `spana-${process.pid}`,
        ],
      }),
    );

    await helper.cleanup();
    expect(helperState.processStops).toEqual(["Sauce Connect"]);
  });
});

afterAll(() => {
  mock.restore();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});
