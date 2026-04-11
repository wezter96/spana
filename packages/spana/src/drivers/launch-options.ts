import type { Platform } from "../schemas/selector.js";
import type { DeviceStateConfig, LaunchOptions } from "./raw-driver.js";

function mergeRecord<T extends object>(base?: T, override?: T): T | undefined {
  if (!base && !override) return undefined;
  return { ...base, ...override } as T;
}

function stringifyLaunchValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return String(value);
  }
  return JSON.stringify(value);
}

function splitLocale(locale?: string): { language?: string; remainder?: string } {
  if (!locale) return {};
  const [language, ...rest] = locale.split(/[-_]/).filter(Boolean);
  if (!language || rest.length === 0) {
    return {};
  }
  return { language, remainder: rest.join("_") };
}

function resolveAndroidDeviceState(deviceState?: DeviceStateConfig): DeviceStateConfig {
  if (!deviceState) return {};
  const split = splitLocale(deviceState.locale);
  return {
    language: deviceState.language ?? split.language,
    locale: split.remainder ?? deviceState.locale,
    timeZone: deviceState.timeZone,
  };
}

function resolveIOSDeviceState(deviceState?: DeviceStateConfig): DeviceStateConfig {
  if (!deviceState) return {};
  const split = splitLocale(deviceState.locale);
  const language = deviceState.language ?? split.language;
  const locale =
    deviceState.locale && split.remainder && language
      ? `${language}_${split.remainder}`
      : deviceState.locale && !split.remainder && language
        ? `${language}_${deviceState.locale}`
        : deviceState.locale?.replaceAll("-", "_");

  return {
    language,
    locale,
    timeZone: deviceState.timeZone,
  };
}

export function mergeLaunchOptions<R extends string = string>(
  base?: LaunchOptions<R>,
  override?: LaunchOptions<R>,
): LaunchOptions<R> | undefined {
  if (!base && !override) return undefined;

  return {
    ...base,
    ...override,
    launchArguments: mergeRecord(base?.launchArguments, override?.launchArguments),
    deviceState: mergeRecord(base?.deviceState, override?.deviceState),
  };
}

export function hasLaunchDeviceState(deviceState?: DeviceStateConfig): boolean {
  return Boolean(deviceState?.language || deviceState?.locale || deviceState?.timeZone);
}

export function deviceStateToAppiumCapabilities(
  platform: Extract<Platform, "android" | "ios">,
  deviceState?: DeviceStateConfig,
): Record<string, unknown> {
  const normalizedState =
    platform === "android"
      ? resolveAndroidDeviceState(deviceState)
      : resolveIOSDeviceState(deviceState);
  if (!normalizedState.language && !normalizedState.locale && !normalizedState.timeZone) return {};

  if (platform === "android") {
    const hasLanguage = Boolean(normalizedState.language);
    const hasLocale = Boolean(normalizedState.locale);
    if (hasLanguage !== hasLocale) {
      throw new Error(
        "Appium Android deviceState requires both language and locale when either is provided.",
      );
    }
  }

  const capabilities: Record<string, unknown> = {};
  if (normalizedState.language) {
    capabilities["appium:language"] = normalizedState.language;
  }
  if (normalizedState.locale) {
    capabilities["appium:locale"] = normalizedState.locale;
  }
  if (normalizedState.timeZone) {
    capabilities[platform === "ios" ? "appium:appTimeZone" : "appium:timeZone"] =
      normalizedState.timeZone;
  }

  return capabilities;
}

export function buildIOSLaunchConfiguration(options?: LaunchOptions):
  | {
      arguments?: string[];
      environment?: Record<string, string>;
    }
  | undefined {
  if (!options) return undefined;

  const argumentsList: string[] = [];
  const environment: Record<string, string> = {};
  const normalizedState = resolveIOSDeviceState(options.deviceState);

  if (normalizedState.language) {
    argumentsList.push("-AppleLanguages", `(${normalizedState.language})`);
  }
  if (normalizedState.locale) {
    argumentsList.push("-AppleLocale", normalizedState.locale);
  }
  if (options.launchArguments) {
    for (const [key, value] of Object.entries(options.launchArguments)) {
      argumentsList.push(`-${key}`, stringifyLaunchValue(value));
    }
  }
  if (normalizedState.timeZone) {
    environment.TZ = normalizedState.timeZone;
  }

  if (argumentsList.length === 0 && Object.keys(environment).length === 0) {
    return undefined;
  }

  return {
    arguments: argumentsList.length > 0 ? argumentsList : undefined,
    environment: Object.keys(environment).length > 0 ? environment : undefined,
  };
}
