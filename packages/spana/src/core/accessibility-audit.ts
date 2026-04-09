import type { Platform } from "../schemas/selector.js";

// ---------------------------------------------------------------------------
// Platform context
// ---------------------------------------------------------------------------

export interface A11yPlatformContext {
  platform: Platform;
}

// ---------------------------------------------------------------------------
// Violation types
// ---------------------------------------------------------------------------

export interface AccessibilityViolation {
  ruleId: string;
  severity: "critical" | "serious" | "moderate" | "minor";
  description: string;
  helpUrl: string;
  wcagCriteria: string[];
  elements: Array<{ selector: string; html: string; failureSummary: string }>;
}

// ---------------------------------------------------------------------------
// normalizeRole
// ---------------------------------------------------------------------------

const WEB_TAG_ROLE_MAP: Record<string, string> = {
  button: "button",
  a: "link",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  input: "textfield",
  textarea: "textfield",
  select: "combobox",
  img: "image",
  nav: "navigation",
  main: "main",
};

const ANDROID_CLASS_ROLE_MAP: Record<string, string> = {
  "android.widget.Button": "button",
  "android.widget.EditText": "textfield",
  "android.widget.ImageView": "image",
  "android.widget.CheckBox": "checkbox",
  "android.widget.Switch": "switch",
};

const IOS_TRAIT_ROLE_MAP: Record<string, string> = {
  button: "button",
  header: "heading",
  link: "link",
  image: "image",
  staticText: "text",
};

export function normalizeRole(
  platform: Platform,
  elementType: string,
  attributes: Record<string, string> = {},
): string {
  switch (platform) {
    case "web": {
      if (attributes["role"]) return attributes["role"];
      return WEB_TAG_ROLE_MAP[elementType.toLowerCase()] ?? elementType;
    }
    case "android": {
      return ANDROID_CLASS_ROLE_MAP[elementType] ?? elementType;
    }
    case "ios": {
      return IOS_TRAIT_ROLE_MAP[elementType] ?? elementType;
    }
  }
}

// ---------------------------------------------------------------------------
// isFocusable
// ---------------------------------------------------------------------------

const WEB_FOCUSABLE_TAGS = new Set([
  "a",
  "button",
  "input",
  "textarea",
  "select",
  "details",
  "summary",
]);

export function isFocusable(
  element: Record<string, unknown>,
  context: A11yPlatformContext,
): boolean {
  switch (context.platform) {
    case "web": {
      const tag = typeof element["tag"] === "string" ? element["tag"].toLowerCase() : "";
      if (WEB_FOCUSABLE_TAGS.has(tag)) return true;
      const tabindex = element["tabindex"];
      if (tabindex !== undefined && tabindex !== null) {
        const idx = Number(tabindex);
        if (!isNaN(idx) && idx >= 0) return true;
      }
      return false;
    }
    case "android": {
      return element["focused"] === true || element["clickable"] === true;
    }
    case "ios": {
      return (
        (typeof element["accessibilityLabel"] === "string" &&
          element["accessibilityLabel"].length > 0) ||
        element["clickable"] === true
      );
    }
  }
}

// ---------------------------------------------------------------------------
// filterViolations
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<AccessibilityViolation["severity"], number> = {
  minor: 0,
  moderate: 1,
  serious: 2,
  critical: 3,
};

export function filterViolations(
  violations: AccessibilityViolation[],
  minSeverity: AccessibilityViolation["severity"],
): AccessibilityViolation[] {
  const minLevel = SEVERITY_ORDER[minSeverity];
  return violations.filter((v) => SEVERITY_ORDER[v.severity] >= minLevel);
}

// ---------------------------------------------------------------------------
// formatViolationSummary
// ---------------------------------------------------------------------------

export function formatViolationSummary(violations: AccessibilityViolation[]): string {
  const total = violations.length;
  const critical = violations.filter((v) => v.severity === "critical").length;
  const serious = violations.filter((v) => v.severity === "serious").length;
  return `Accessibility audit failed: ${total} violations (${critical} critical, ${serious} serious)`;
}

// ---------------------------------------------------------------------------
// AuditOptions / buildAxeConfig
// ---------------------------------------------------------------------------

export interface AuditOptions {
  rules?: string[];
  disabledRules?: string[];
  exclude?: string[];
  include?: string[];
  tags?: string[];
}

export function buildAxeConfig(options: AuditOptions): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  if (options.rules && options.rules.length > 0) {
    const rulesConfig: Record<string, { enabled: boolean }> = {};
    for (const ruleId of options.rules) {
      rulesConfig[ruleId] = { enabled: true };
    }
    if (options.disabledRules) {
      for (const ruleId of options.disabledRules) {
        rulesConfig[ruleId] = { enabled: false };
      }
    }
    config["rules"] = rulesConfig;
  } else if (options.disabledRules && options.disabledRules.length > 0) {
    const rulesConfig: Record<string, { enabled: boolean }> = {};
    for (const ruleId of options.disabledRules) {
      rulesConfig[ruleId] = { enabled: false };
    }
    config["rules"] = rulesConfig;
  }

  if (options.tags && options.tags.length > 0) {
    config["runOnly"] = { type: "tag", values: options.tags };
  }

  const context: Record<string, unknown> = {};
  if (options.include && options.include.length > 0) {
    context["include"] = options.include;
  }
  if (options.exclude && options.exclude.length > 0) {
    context["exclude"] = options.exclude;
  }
  if (Object.keys(context).length > 0) {
    config["context"] = context;
  }

  return config;
}
