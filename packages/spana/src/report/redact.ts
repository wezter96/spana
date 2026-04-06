/**
 * Log masking / redaction for secrets in console and artifact output.
 *
 * Detects and masks:
 * - URL credentials (user:pass@ in appium/cloud URLs)
 * - Common secret environment variable values
 * - Bearer/Basic auth tokens
 * - Custom patterns from config
 */

const REDACTED = "***";

/** Built-in patterns that match sensitive content. */
const builtinPatterns: RegExp[] = [
  // URL credentials: https://user:pass@host or http://user:pass@host
  /(?<=\/\/)[^/:@\s]+:[^/:@\s]+(?=@)/g,
  // Authorization headers: Basic xxx or Bearer xxx (including JWTs with dots)
  /(?<=(?:Authorization|authorization)[:\s]+(?:Basic|Bearer)\s+)[A-Za-z0-9+/=_.-]+/g,
  // bs://app-id references are not secrets, but bstack access keys look like hex strings after ':'
  // Generic API key patterns: long hex/base64 strings following common key names
  /(?<=(?:key|token|secret|password|apiKey|api_key|accessKey|access_key)[=:\s"']+)[A-Za-z0-9+/=_-]{16,}/gi,
];

/** Environment variable name patterns that indicate secrets. */
const secretEnvPatterns = [
  /key$/i,
  /secret$/i,
  /token$/i,
  /password$/i,
  /^(?:BS|BROWSERSTACK)_/i,
  /^(?:SAUCE)_/i,
  /^(?:APPIUM)_.*(?:KEY|SECRET|TOKEN|PASSWORD)/i,
];

export interface RedactorConfig {
  /** Additional regex patterns to redact. */
  patterns?: RegExp[];
  /** Additional literal strings to redact (e.g., specific API keys). */
  literals?: string[];
  /** Whether to auto-detect secrets from environment variables. Default: true. */
  redactEnv?: boolean;
  /** Disable redaction entirely. Default: false. */
  disabled?: boolean;
}

export interface Redactor {
  /** Redact sensitive content from a string. */
  redact(input: string): string;
  /** Register an additional literal secret to redact. Set force to skip length check. */
  addSecret(secret: string, force?: boolean): void;
}

export function createRedactor(config?: RedactorConfig): Redactor {
  if (config?.disabled) {
    return { redact: (input) => input, addSecret: () => {} };
  }

  const literalSecrets = new Set<string>(config?.literals ?? []);
  const customPatterns = config?.patterns ?? [];

  // Auto-detect secrets from environment variables
  if (config?.redactEnv !== false) {
    for (const [name, value] of Object.entries(process.env)) {
      if (!value || value.length < 8) continue;
      if (secretEnvPatterns.some((p) => p.test(name))) {
        literalSecrets.add(value);
      }
    }
  }

  function redact(input: string): string {
    let result = input;

    // Redact literal secrets (longest first to avoid partial matches)
    const sorted = [...literalSecrets].sort((a, b) => b.length - a.length);
    for (const secret of sorted) {
      if (result.includes(secret)) {
        result = result.replaceAll(secret, REDACTED);
      }
    }

    // Apply built-in patterns
    for (const pattern of builtinPatterns) {
      // Reset lastIndex for global regexes
      pattern.lastIndex = 0;
      result = result.replace(pattern, REDACTED);
    }

    // Apply custom patterns
    for (const pattern of customPatterns) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, REDACTED);
    }

    return result;
  }

  return {
    redact,
    addSecret(secret: string, force?: boolean) {
      if (force || secret.length >= 8) {
        literalSecrets.add(secret);
      }
    },
  };
}

/** Extract credentials from an Appium URL and register them for redaction. */
export function registerUrlSecrets(redactor: Redactor, url: string): void {
  try {
    const parsed = new URL(url);
    // URL credentials are always sensitive regardless of length
    if (parsed.username) redactor.addSecret(decodeURIComponent(parsed.username), true);
    if (parsed.password) redactor.addSecret(decodeURIComponent(parsed.password), true);
  } catch {
    // Not a valid URL — nothing to redact
  }
}
