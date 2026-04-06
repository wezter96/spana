import type { AppConfig, AppiumExecutionConfig, SauceLabsHelperConfig } from "../schemas/config.js";
import type { Platform } from "../schemas/selector.js";
import {
  parseAppiumCredentials,
  readOptionRecord,
  startManagedProcess,
  uploadMultipartJson,
} from "./common.js";
import type { CloudProvider, CloudProviderHelper, ProviderRunResult } from "./provider.js";

function detectSauceRegion(hostname: string): string {
  if (hostname.includes("eu-central")) {
    return "eu-central";
  }

  if (hostname.includes("us-east")) {
    return "us-east";
  }

  return "us-west";
}

async function resolveSauceAppReference(
  appiumUrl: string,
  helperConfig: SauceLabsHelperConfig | undefined,
  appConfig: AppConfig | undefined,
  cache: Map<string, string>,
): Promise<string | undefined> {
  const managedApp = helperConfig?.app;
  if (managedApp?.id) {
    return managedApp.id;
  }

  const appPath = managedApp?.path ?? appConfig?.appPath;
  if (!appPath) {
    return undefined;
  }

  const cacheKey = `${appPath}:${managedApp?.name ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const { url, username, password } = parseAppiumCredentials(appiumUrl, "Sauce Labs");
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const region = detectSauceRegion(url.hostname);
  const response = await uploadMultipartJson({
    url: `https://api.${region}.saucelabs.com/v1/storage/upload`,
    auth,
    fileField: "payload",
    filePath: appPath,
    fileName: managedApp?.name,
    fields: managedApp?.name ? { name: managedApp.name } : undefined,
  });

  const item =
    response["item"] && typeof response["item"] === "object"
      ? (response["item"] as Record<string, unknown>)
      : undefined;
  const appId =
    (typeof item?.["id"] === "string" && item["id"]) ||
    (typeof response["id"] === "string" && response["id"]);

  if (!appId) {
    throw new Error("Sauce Labs upload did not return an app id.");
  }

  const appReference = `storage:${appId}`;
  cache.set(cacheKey, appReference);
  return appReference;
}

async function startSauceConnect(
  appiumUrl: string,
  helperConfig: SauceLabsHelperConfig,
  tunnelName: string,
): Promise<() => Promise<void>> {
  const { url, username, password } = parseAppiumCredentials(appiumUrl, "Sauce Labs");
  const region = detectSauceRegion(url.hostname);
  const args = [
    "run",
    "--username",
    username,
    "--access-key",
    password,
    "--region",
    region,
    "--tunnel-name",
    tunnelName,
    ...(helperConfig.connect?.args ?? []),
  ];

  return await startManagedProcess({
    label: "Sauce Connect",
    command: helperConfig.connect?.binary ?? "sc",
    args,
    readyWhen: [/you may start your tests/i, /Sauce Connect Proxy is up/i, /Sauce Connect is up/i],
  });
}

export class SauceLabsProvider implements CloudProvider {
  name() {
    return "Sauce Labs";
  }

  createHelper(appiumUrl: string, config: AppiumExecutionConfig): CloudProviderHelper {
    const helperConfig = config.saucelabs;
    let tunnelCleanup: (() => Promise<void>) | undefined;
    let generatedTunnelName: string | undefined;
    const uploadedApps = new Map<string, string>();

    return {
      prepareCapabilities: async (
        _platform: Platform,
        caps: Record<string, unknown>,
        appConfig?: AppConfig,
      ) => {
        if (!helperConfig) {
          return caps;
        }

        const existingOptions = readOptionRecord(caps["sauce:options"], "sauce:options");
        const mergedOptions: Record<string, unknown> = {
          ...helperConfig.options,
          ...existingOptions,
        };

        if (helperConfig.connect?.enabled) {
          const explicitTunnelName =
            typeof mergedOptions["tunnelName"] === "string"
              ? mergedOptions["tunnelName"]
              : helperConfig.connect.tunnelName;
          const tunnelName = explicitTunnelName ?? (generatedTunnelName ??= `spana-${process.pid}`);

          mergedOptions["tunnelName"] = tunnelName;

          if (!tunnelCleanup) {
            tunnelCleanup = await startSauceConnect(appiumUrl, helperConfig, tunnelName);
          }
        }

        const nextCaps = { ...caps };
        if (Object.keys(mergedOptions).length > 0) {
          nextCaps["sauce:options"] = mergedOptions;
        }

        if (nextCaps["appium:app"] === undefined) {
          const appReference = await resolveSauceAppReference(
            appiumUrl,
            helperConfig,
            appConfig,
            uploadedApps,
          );
          if (appReference) {
            nextCaps["appium:app"] = appReference;
          }
        }

        return nextCaps;
      },
      cleanup: async () => {
        if (tunnelCleanup) {
          const cleanup = tunnelCleanup;
          tunnelCleanup = undefined;
          await cleanup();
        }
      },
    };
  }

  extractMeta(sessionId: string, caps: Record<string, unknown>, meta: Record<string, string>) {
    meta["sessionId"] = sessionId;
    if (caps["sauce:options"]) {
      const opts = caps["sauce:options"] as Record<string, unknown>;
      if (opts.build) meta["build"] = String(opts.build);
      if (opts.name) meta["name"] = String(opts.name);
    }
  }

  async reportResult(appiumUrl: string, meta: Record<string, string>, result: ProviderRunResult) {
    const url = new URL(appiumUrl);
    const auth = Buffer.from(`${url.username}:${url.password}`).toString("base64");
    const sessionId = meta["sessionId"];

    const region = url.hostname.includes("eu-central") ? "eu-central-1" : "us-west-1";

    await fetch(`https://api.${region}.saucelabs.com/rest/v1/${url.username}/jobs/${sessionId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        passed: result.passed,
        name: result.name ?? "",
      }),
    });
  }
}
