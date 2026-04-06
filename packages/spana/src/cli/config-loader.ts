import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ZodError } from "zod";
import { formatConfigValidationError, validateConfig, type ProvConfig } from "../schemas/config.js";

const DEFAULT_CONFIG_CANDIDATES = ["spana.config.ts", "packages/spana/spana.config.ts"];

export interface LoadConfigOptions {
  configPath?: string;
  allowMissing?: boolean;
}

export interface LoadedConfig {
  config: ProvConfig;
  configPath?: string;
}

function resolveIfRelative(baseDir: string, value?: string): string | undefined {
  if (!value) {
    return value;
  }

  return isAbsolute(value) ? value : resolve(baseDir, value);
}

function resolveConfigPaths(config: ProvConfig, configPath: string): ProvConfig {
  const configDir = dirname(configPath);

  if (config.flowDir) {
    config.flowDir = resolveIfRelative(configDir, config.flowDir);
  }

  if (config.artifacts?.outputDir) {
    config.artifacts.outputDir = resolveIfRelative(configDir, config.artifacts.outputDir);
  }

  if (config.apps?.web?.appPath) {
    config.apps.web.appPath = resolveIfRelative(configDir, config.apps.web.appPath);
  }

  if (config.apps?.android?.appPath) {
    config.apps.android.appPath = resolveIfRelative(configDir, config.apps.android.appPath);
  }

  if (config.apps?.ios?.appPath) {
    config.apps.ios.appPath = resolveIfRelative(configDir, config.apps.ios.appPath);
  }

  if (config.execution?.appium?.capabilitiesFile) {
    config.execution.appium.capabilitiesFile = resolveIfRelative(
      configDir,
      config.execution.appium.capabilitiesFile,
    );
  }

  if (config.execution?.web?.storageState) {
    config.execution.web.storageState = resolveIfRelative(
      configDir,
      config.execution.web.storageState,
    );
  }

  if (config.execution?.appium?.browserstack?.app?.path) {
    config.execution.appium.browserstack.app.path = resolveIfRelative(
      configDir,
      config.execution.appium.browserstack.app.path,
    );
  }

  if (config.execution?.appium?.browserstack?.local?.binary) {
    config.execution.appium.browserstack.local.binary = resolveIfRelative(
      configDir,
      config.execution.appium.browserstack.local.binary,
    );
  }

  if (config.execution?.appium?.saucelabs?.app?.path) {
    config.execution.appium.saucelabs.app.path = resolveIfRelative(
      configDir,
      config.execution.appium.saucelabs.app.path,
    );
  }

  if (config.execution?.appium?.saucelabs?.connect?.binary) {
    config.execution.appium.saucelabs.connect.binary = resolveIfRelative(
      configDir,
      config.execution.appium.saucelabs.connect.binary,
    );
  }

  return config;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const candidates = options.configPath
    ? [resolve(options.configPath)]
    : DEFAULT_CONFIG_CANDIDATES.map((candidate) => resolve(candidate));
  const foundPath = candidates.find((candidate) => existsSync(candidate));

  if (!foundPath) {
    if (options.allowMissing && !options.configPath) {
      return { config: {} };
    }

    if (options.configPath) {
      throw new Error(`Config file not found: ${resolve(options.configPath)}`);
    }

    throw new Error(`No config file found. Looked in: ${candidates.join(", ")}`);
  }

  let moduleValue: Record<string, unknown>;
  try {
    moduleValue = (await import(pathToFileURL(foundPath).href)) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load config at ${foundPath}: ${message}`);
  }

  const rawConfig = ("default" in moduleValue ? moduleValue.default : moduleValue) as unknown;

  try {
    const config = validateConfig(rawConfig);
    return {
      config: resolveConfigPaths(config, foundPath),
      configPath: foundPath,
    };
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(
        `Config validation failed for ${foundPath}:\n${formatConfigValidationError(error)}`,
      );
    }
    throw error;
  }
}
