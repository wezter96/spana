import type { FailureCategory, FlowError } from "./types.js";

const TAG_KEY = "_tag";

interface TaggedLike {
  [TAG_KEY]?: string;
  message?: string;
  selector?: unknown;
  timeoutMs?: number;
  expected?: string;
  actual?: string;
  deviceId?: string;
  appId?: string;
  command?: string;
  platform?: string;
}

function selectorHint(selector: unknown): string {
  if (selector && typeof selector === "object") {
    const s = selector as Record<string, unknown>;
    if (s.testID) return `testID="${s.testID}"`;
    if (s.text) return `text="${s.text}"`;
    if (s.accessibilityLabel) return `accessibilityLabel="${s.accessibilityLabel}"`;
  }
  return JSON.stringify(selector);
}

function categorize(error: TaggedLike): { category: FailureCategory; suggestion?: string } {
  const tag = error[TAG_KEY];

  if (tag === "ElementNotFoundError" || tag === "WaitTimeoutError") {
    const sel = selectorHint((error as any).selector);
    return {
      category: "element-not-found",
      suggestion: [
        `Selector ${sel} was not found within ${(error as any).timeoutMs ?? "?"}ms.`,
        "Try: run `spana selectors` to see available selectors on the current screen,",
        "or increase the timeout with `{ timeout: 10000 }` on the assertion.",
      ].join("\n"),
    };
  }

  if (tag === "TextMismatchError") {
    const e = error as TaggedLike;
    return {
      category: "text-mismatch",
      suggestion: [
        `Expected text "${e.expected}" but found "${e.actual ?? "(empty)"}".`,
        "The element exists but its content differs. Check for whitespace, truncation,",
        "or platform-specific text rendering differences.",
      ].join("\n"),
    };
  }

  if (tag === "TimeoutError") {
    return {
      category: "timeout",
      suggestion: [
        "The operation took longer than the allowed timeout.",
        "Try increasing `defaults.waitTimeout` in spana.config.ts,",
        "or set a per-flow timeout: `flow('name', { timeout: 30000 }, ...)`.",
      ].join("\n"),
    };
  }

  if (tag === "DeviceDisconnectedError") {
    const id = error.deviceId ? ` (${error.deviceId})` : "";
    return {
      category: "device-disconnected",
      suggestion: [
        `The device${id} disconnected during the test.`,
        "Check the physical connection or emulator/simulator stability.",
        "Run `spana devices` to verify available devices.",
      ].join("\n"),
    };
  }

  if (tag === "AppCrashedError") {
    const app = error.appId ? ` (${error.appId})` : "";
    return {
      category: "app-crashed",
      suggestion: [
        `The app${app} crashed during the test.`,
        "Check the device logs for a crash stack trace:",
        "  Android: `adb logcat -d | grep FATAL`",
        "  iOS: Check Console.app or `log show --predicate 'process == \"your-app\"'`",
      ].join("\n"),
    };
  }

  if (tag === "AppNotInstalledError") {
    return {
      category: "app-not-installed",
      suggestion: [
        `App "${error.appId}" is not installed on the device.`,
        "Install it before running tests, or configure `apps.android.appPath`",
        "/ `apps.ios.appPath` in spana.config.ts for auto-install.",
      ].join("\n"),
    };
  }

  if (tag === "DriverError") {
    return {
      category: "driver-error",
      suggestion: error.command
        ? `Driver command "${error.command}" failed. Check the device connection and driver logs.`
        : "A low-level driver operation failed. Check the device connection and driver logs.",
    };
  }

  if (tag === "ConfigError" || tag === "FlowSyntaxError") {
    return {
      category: "config-error",
      suggestion: "Run `spana validate-config` to check your configuration.",
    };
  }

  // Heuristic fallbacks for errors that aren't Effect TaggedErrors
  const msg = error.message ?? "";

  if (msg.includes("timed out") || msg.includes("Timed out")) {
    return {
      category: "timeout",
      suggestion:
        "The operation timed out. Try increasing `defaults.waitTimeout` in spana.config.ts.",
    };
  }

  if (msg.includes("not found") || msg.includes("not visible")) {
    return {
      category: "element-not-found",
      suggestion:
        "An element was not found. Run `spana selectors` to check available selectors on the current screen.",
    };
  }

  if (msg.includes("ECONNREFUSED") || msg.includes("ECONNRESET") || msg.includes("disconnected")) {
    return {
      category: "device-disconnected",
      suggestion:
        "The connection was lost. Check the device or emulator/simulator is still running.",
    };
  }

  return { category: "unknown" };
}

/** Classify an Error into a typed FlowError with category and actionable suggestion. */
export function classifyError(error: Error): FlowError {
  const tagged = error as unknown as TaggedLike;
  const { category, suggestion } = categorize(tagged);
  return {
    message: error.message,
    stack: error.stack,
    category,
    suggestion,
  };
}
