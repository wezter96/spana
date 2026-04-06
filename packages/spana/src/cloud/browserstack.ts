import type {
  AppConfig,
  AppiumExecutionConfig,
  BrowserStackHelperConfig,
} from "../schemas/config.js";
import type { Platform } from "../schemas/selector.js";
import {
  parseAppiumCredentials,
  readOptionRecord,
  startManagedProcess,
  uploadMultipartJson,
} from "./common.js";
import type { CloudProvider, CloudProviderHelper, ProviderRunResult } from "./provider.js";

async function resolveBrowserStackAppReference(
  appiumUrl: string,
  helperConfig: BrowserStackHelperConfig | undefined,
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

  const cacheKey = `${appPath}:${managedApp?.name ?? ""}:${managedApp?.customId ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const { username, password } = parseAppiumCredentials(appiumUrl, "BrowserStack");
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const response = await uploadMultipartJson({
    url: "https://api-cloud.browserstack.com/app-automate/upload",
    auth,
    fileField: "file",
    filePath: appPath,
    fileName: managedApp?.name,
    fields: managedApp?.customId ? { custom_id: managedApp.customId } : undefined,
  });

  const appUrl =
    typeof response["app_url"] === "string"
      ? response["app_url"]
      : typeof response["url"] === "string"
        ? response["url"]
        : undefined;

  if (!appUrl) {
    throw new Error("BrowserStack upload did not return an app_url.");
  }

  cache.set(cacheKey, appUrl);
  return appUrl;
}

async function startBrowserStackLocal(
  appiumUrl: string,
  helperConfig: BrowserStackHelperConfig,
  localIdentifier: string | undefined,
): Promise<() => Promise<void>> {
  const { password } = parseAppiumCredentials(appiumUrl, "BrowserStack");
  const args = ["--key", password];

  if (localIdentifier) {
    args.push("--local-identifier", localIdentifier);
  }

  args.push(...(helperConfig.local?.args ?? []));

  return await startManagedProcess({
    label: "BrowserStack Local",
    command: helperConfig.local?.binary ?? "BrowserStackLocal",
    args,
    readyWhen: [
      /You can now access your local server/i,
      /Connected/i,
      /local (testing|connection).*(running|connected)/i,
    ],
  });
}

export class BrowserStackProvider implements CloudProvider {
  name() {
    return "BrowserStack";
  }

  createHelper(appiumUrl: string, config: AppiumExecutionConfig): CloudProviderHelper {
    const helperConfig = config.browserstack;
    let localCleanup: (() => Promise<void>) | undefined;
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

        const existingOptions = readOptionRecord(caps["bstack:options"], "bstack:options");
        const mergedOptions: Record<string, unknown> = {
          ...helperConfig.options,
          ...existingOptions,
        };

        if (helperConfig.local?.enabled) {
          if (mergedOptions["local"] !== undefined && mergedOptions["local"] !== true) {
            throw new Error(
              "BrowserStack local helper requires bstack:options.local to be true when set.",
            );
          }

          const localIdentifier =
            typeof mergedOptions["localIdentifier"] === "string"
              ? mergedOptions["localIdentifier"]
              : helperConfig.local.identifier;

          mergedOptions["local"] = true;
          if (localIdentifier) {
            mergedOptions["localIdentifier"] = localIdentifier;
          }

          if (!localCleanup) {
            localCleanup = await startBrowserStackLocal(appiumUrl, helperConfig, localIdentifier);
          }
        }

        const nextCaps = { ...caps };
        if (Object.keys(mergedOptions).length > 0) {
          nextCaps["bstack:options"] = mergedOptions;
        }

        if (nextCaps["appium:app"] === undefined) {
          const appReference = await resolveBrowserStackAppReference(
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
        if (localCleanup) {
          const cleanup = localCleanup;
          localCleanup = undefined;
          await cleanup();
        }
      },
    };
  }

  extractMeta(sessionId: string, caps: Record<string, unknown>, meta: Record<string, string>) {
    meta["sessionId"] = sessionId;
    if (caps["bstack:options"]) {
      const opts = caps["bstack:options"] as Record<string, unknown>;
      if (opts.buildName) meta["buildName"] = String(opts.buildName);
      if (opts.projectName) meta["projectName"] = String(opts.projectName);
    }
  }

  async reportResult(appiumUrl: string, meta: Record<string, string>, result: ProviderRunResult) {
    const url = new URL(appiumUrl);
    const auth = Buffer.from(`${url.username}:${url.password}`).toString("base64");
    const sessionId = meta["sessionId"];

    await fetch(`https://api-cloud.browserstack.com/app-automate/sessions/${sessionId}.json`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        status: result.passed ? "passed" : "failed",
        reason: result.reason ?? "",
        name: result.name ?? "",
      }),
    });
  }
}
