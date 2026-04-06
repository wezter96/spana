/**
 * Generic W3C WebDriver / Appium HTTP client.
 *
 * Creates and manages sessions against any Appium-compatible server
 * (local Appium, BrowserStack, Sauce Labs, etc.) using the W3C
 * WebDriver protocol with Appium extensions.
 */

interface W3CResponse {
  value: unknown;
}

interface W3CErrorValue {
  error?: string;
  message?: string;
  stacktrace?: string;
}

export class AppiumClient {
  private baseUrl: string;
  private sessionId: string | null = null;
  private sessionCaps: Record<string, unknown> = {};

  constructor(serverUrl: string) {
    // Strip trailing slash for consistent URL building
    this.baseUrl = serverUrl.replace(/\/+$/, "");
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    const text = await res.text();

    let parsed: W3CResponse;
    try {
      parsed = JSON.parse(text) as W3CResponse;
    } catch {
      throw new Error(`Appium: failed to parse response: ${text}`);
    }

    if (!res.ok) {
      const val = parsed.value as W3CErrorValue | undefined;
      const msg = val?.message ?? val?.error ?? text;
      throw new Error(`Appium ${method} ${path} -> ${res.status}: ${msg}`);
    }

    // Surface W3C error values embedded in a 200 response
    if (
      parsed.value !== null &&
      typeof parsed.value === "object" &&
      "error" in (parsed.value as object)
    ) {
      const val = parsed.value as W3CErrorValue;
      throw new Error(`Appium error: ${val.message ?? val.error}`);
    }

    return parsed.value as T;
  }

  sessionPath(suffix: string): string {
    if (this.sessionId === null) {
      throw new Error("Appium: no active session");
    }
    return `/session/${this.sessionId}${suffix}`;
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  async createSession(capabilities: Record<string, unknown>): Promise<string> {
    const body = {
      capabilities: {
        alwaysMatch: capabilities,
      },
    };

    const res = await fetch(`${this.baseUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`Appium: failed to parse session response: ${text}`);
    }

    if (!res.ok) {
      const val = parsed["value"] as W3CErrorValue | undefined;
      throw new Error(`Appium: failed to create session: ${val?.message ?? text}`);
    }

    // W3C spec: { value: { sessionId, capabilities } }
    const value = parsed["value"] as Record<string, unknown> | undefined;
    const sessionId =
      (value?.["sessionId"] as string | undefined) ?? (parsed["sessionId"] as string | undefined);

    if (!sessionId) {
      throw new Error("Appium: no sessionId in session response");
    }

    this.sessionId = sessionId;
    this.sessionCaps = (value?.["capabilities"] as Record<string, unknown>) ?? {};
    return sessionId;
  }

  async deleteSession(): Promise<void> {
    if (this.sessionId === null) return;
    const path = `/session/${this.sessionId}`;
    this.sessionId = null;
    this.sessionCaps = {};
    await fetch(`${this.baseUrl}${path}`, { method: "DELETE" });
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getSessionCaps(): Record<string, unknown> {
    return this.sessionCaps;
  }

  // ---------------------------------------------------------------------------
  // WebView / hybrid context switching
  // ---------------------------------------------------------------------------

  async getContexts(): Promise<string[]> {
    return this.request<string[]>("GET", this.sessionPath("/contexts"));
  }

  async getCurrentContext(): Promise<string> {
    return this.request<string>("GET", this.sessionPath("/context"));
  }

  async setContext(contextId: string): Promise<void> {
    await this.request("POST", this.sessionPath("/context"), { name: contextId });
  }

  // ---------------------------------------------------------------------------
  // Scripting (execute in current context — works in WebView contexts)
  // ---------------------------------------------------------------------------

  async executeScript(script: string, args: unknown[] = []): Promise<unknown> {
    return this.request("POST", this.sessionPath("/execute/sync"), { script, args });
  }
}
