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

function categorizeElementFailure(message: string): FailureCategory {
  const lower = message.toLowerCase();
  if (lower.includes("not visible") || lower.includes("visible=false")) {
    return "element-not-visible";
  }
  if (lower.includes("off-screen") || lower.includes("zero size")) {
    return "element-off-screen";
  }
  if (lower.includes("disabled") || lower.includes("not interactive")) {
    return "element-not-interactive";
  }
  return "element-not-found";
}

function elementSuggestion(
  category: FailureCategory,
  selector: string,
  timeoutMs: unknown,
): string {
  switch (category) {
    case "element-not-visible":
      return [
        `Selector ${selector} matched an element, but it is currently hidden.`,
        "Check whether an animation, modal, or loading state is covering it before retrying.",
        "Consider increasing waitTimeout if the element becomes visible after a delay.",
      ].join("\n");
    case "element-off-screen":
      return [
        `Selector ${selector} matched an element that is off-screen.`,
        "Use scrollUntilVisible() or scroll to the element before interacting with it.",
        "If the target is above the current viewport, reverse the search direction.",
      ].join("\n");
    case "element-not-interactive":
      return [
        `Selector ${selector} matched an element that is disabled or not interactive.`,
        "Wait for the app to enable it, or verify the prerequisite app state first.",
        "Consider increasing waitTimeout if the control becomes enabled after async work completes.",
      ].join("\n");
    default:
      return [
        `Selector ${selector} was not found within ${timeoutMs ?? "?"}ms.`,
        "Run `spana selectors` to inspect the current screen and confirm the best selector.",
        "Consider increasing waitTimeout if the element appears after a delay.",
      ].join("\n");
  }
}

interface PatternRule {
  tag?: string | readonly string[];
  pattern?: string | RegExp;
  category: FailureCategory | ((msg: string) => FailureCategory);
  suggestion: string | ((error: TaggedLike, msg: string) => string);
}

/**
 * Dynamic rules that depend on runtime error properties (selector, deviceId, etc.)
 * and must be checked before the static lookup table.
 */
function categorizeDynamic(
  error: TaggedLike,
  tag: string | undefined,
  msg: string,
): { category: FailureCategory; suggestion?: string } | undefined {
  if (tag === "ElementNotFoundError" || tag === "WaitTimeoutError") {
    const sel = selectorHint((error as any).selector);
    if (msg.includes("scroll(s) toward")) {
      return {
        category: "element-not-found",
        suggestion: [
          `Selector ${sel} stayed off-screen while scrolling.`,
          "Try increasing `maxScrolls` or `timeout`, or reverse the search direction",
          'if the target is actually above the current viewport (for example `{ direction: "up" }`).',
        ].join("\n"),
      };
    }

    if (msg.includes("back action(s)")) {
      return {
        category: "element-not-found",
        suggestion: [
          `Selector ${sel} was not reached while navigating back.`,
          "Try increasing `maxBacks` or `timeout`, or prefer an explicit in-app",
          "back / close control on iOS-style screens instead of relying on system back.",
        ].join("\n"),
      };
    }

    const category = categorizeElementFailure(msg);
    return {
      category,
      suggestion: elementSuggestion(category, sel, (error as any).timeoutMs),
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
    return categorizeDynamicDriver(error, msg);
  }

  return undefined;
}

function categorizeDynamicDriver(
  error: TaggedLike,
  msg: string,
): { category: FailureCategory; suggestion: string } {
  for (const rule of driverRules) {
    if (rule.pattern && matchesPattern(msg, rule.pattern)) {
      return {
        category: typeof rule.category === "function" ? rule.category(msg) : rule.category,
        suggestion:
          typeof rule.suggestion === "function" ? rule.suggestion(error, msg) : rule.suggestion,
      };
    }
  }

  return {
    category: "driver-error",
    suggestion: error.command
      ? `Driver command "${error.command}" failed. Check the device connection and driver logs.`
      : "A low-level driver operation failed. Check the device connection and driver logs.",
  };
}

/** Pattern rules for DriverError sub-classification. */
const driverRules: readonly PatternRule[] = [
  {
    pattern: "dismissKeyboard()",
    category: "driver-error",
    suggestion: [
      "Keyboard dismissal failed.",
      'On Android, try `app.dismissKeyboard({ strategy: "back" })`.',
      "On iOS, prefer tapping a visible Done / Close control or a non-input element.",
    ].join("\n"),
  },
  {
    pattern: "backUntilVisible()",
    category: "driver-error",
    suggestion: [
      "System back navigation failed before the target screen became visible.",
      "If this route uses app-level navigation, tap the visible back / close control instead.",
      "This is especially common on iOS where a system back button may not exist.",
    ].join("\n"),
  },
  {
    pattern: "Input text failed",
    category: "driver-error",
    suggestion: [
      "Text input failed at the driver layer.",
      "Make sure the field is focused first, and retry with shorter input chunks if needed.",
      "If the keyboard is in the way, dismiss it before continuing the flow.",
    ].join("\n"),
  },
] as const;

/** Tag-only rules (no message pattern needed). */
const tagOnlyRules: readonly PatternRule[] = [
  {
    tag: "TimeoutError",
    category: "timeout",
    suggestion: [
      "The operation took longer than the allowed timeout.",
      "Try increasing `defaults.waitTimeout` in spana.config.ts,",
      "or set a per-flow timeout: `flow('name', { timeout: 30000 }, ...)`.",
    ].join("\n"),
  },
  {
    tag: ["ConfigError", "FlowSyntaxError"],
    category: "config-error",
    suggestion: "Run `spana validate-config` to check your configuration.",
  },
] as const;

/** Heuristic fallback rules for errors that aren't Effect TaggedErrors. */
const heuristicRules: readonly PatternRule[] = [
  {
    pattern: /[Tt]imed out/,
    category: "timeout",
    suggestion:
      "The operation timed out. Try increasing `defaults.waitTimeout` in spana.config.ts.",
  },
  {
    pattern: /not found|not visible/,
    category: (msg: string) => categorizeElementFailure(msg),
    suggestion: (_error, msg) => {
      if (msg.includes("scroll(s) toward")) {
        return "The target stayed off-screen while scrolling. Increase `maxScrolls` / `timeout`, or reverse the scroll search direction.";
      }
      const category = categorizeElementFailure(msg);
      return elementSuggestion(category, "the target selector", undefined);
    },
  },
  {
    pattern: "dismissKeyboard()",
    category: "driver-error",
    suggestion:
      'Keyboard dismissal failed. On Android try `app.dismissKeyboard({ strategy: "back" })`; on iOS prefer an explicit Done / Close control.',
  },
  {
    pattern: /ECONNREFUSED|ECONNRESET|disconnected/,
    category: "device-disconnected",
    suggestion: "The connection was lost. Check the device or emulator/simulator is still running.",
  },
] as const;

function matchesPattern(msg: string, pattern: string | RegExp): boolean {
  return typeof pattern === "string" ? msg.includes(pattern) : pattern.test(msg);
}

function matchesTag(tag: string | undefined, rule: PatternRule): boolean {
  if (!rule.tag) return true;
  if (Array.isArray(rule.tag)) return tag != null && (rule.tag as readonly string[]).includes(tag);
  return tag === rule.tag;
}

function categorize(error: TaggedLike): { category: FailureCategory; suggestion?: string } {
  const tag = error[TAG_KEY];
  const msg = error.message ?? "";

  // 1. Dynamic rules that depend on runtime error properties
  const dynamic = categorizeDynamic(error, tag, msg);
  if (dynamic) return dynamic;

  // 2. Tag-only rules (no message pattern)
  for (const rule of tagOnlyRules) {
    if (matchesTag(tag, rule)) {
      return {
        category: typeof rule.category === "function" ? rule.category(msg) : rule.category,
        suggestion:
          typeof rule.suggestion === "function" ? rule.suggestion(error, msg) : rule.suggestion,
      };
    }
  }

  // 3. Heuristic fallbacks for untagged errors
  for (const rule of heuristicRules) {
    if (rule.pattern && matchesPattern(msg, rule.pattern)) {
      return {
        category: typeof rule.category === "function" ? rule.category(msg) : rule.category,
        suggestion:
          typeof rule.suggestion === "function" ? rule.suggestion(error, msg) : rule.suggestion,
      };
    }
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
