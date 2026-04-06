/**
 * HTTP client for the Appium UiAutomator2 server.
 *
 * The UiAutomator2 server runs on the Android device and is accessed via
 * adb port forwarding (e.g. `adb forward tcp:4723 tcp:4723`).
 *
 * Gesture endpoints use the Appium gesture extensions rather than the W3C
 * Actions API wherever possible, matching the maestro-runner implementation.
 * Coordinate-based swipe (from/to) uses W3C Actions since the Appium swipe
 * extension only accepts direction + percent.
 */

interface Ua2Response {
  sessionId?: string;
  value: unknown;
}

export class UiAutomator2Client {
  private baseUrl: string;
  private sessionId: string | null = null;

  constructor(host: string, port: number) {
    this.baseUrl = `http://${host}:${port}`;
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
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

    let parsed: Ua2Response;
    try {
      parsed = JSON.parse(text) as Ua2Response;
    } catch {
      throw new Error(`UiAutomator2: failed to parse response: ${text}`);
    }

    if (!res.ok) {
      const val = parsed.value as Record<string, unknown> | undefined;
      const msg = val?.message ?? val?.error ?? text;
      throw new Error(`UiAutomator2 ${method} ${path} → ${res.status}: ${msg}`);
    }

    // Surface WDA-style error values embedded in a 200 response
    if (
      parsed.value !== null &&
      typeof parsed.value === "object" &&
      "error" in (parsed.value as object)
    ) {
      const val = parsed.value as Record<string, unknown>;
      throw new Error(`UiAutomator2 error: ${val.message ?? val.error}`);
    }

    return parsed.value as T;
  }

  private sessionPath(path: string): string {
    if (this.sessionId === null) {
      throw new Error("UiAutomator2: no active session");
    }
    return `/session/${this.sessionId}${path}`;
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  async createSession(appPackage?: string): Promise<string> {
    const capabilities: Record<string, unknown> = {
      platformName: "Android",
    };
    if (appPackage) {
      capabilities["appium:appPackage"] = appPackage;
    }

    const body = { capabilities };

    // The session response may have sessionId at the top level or inside value
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
      throw new Error(`UiAutomator2: failed to parse session response: ${text}`);
    }

    if (!res.ok) {
      const val = parsed["value"] as Record<string, unknown> | undefined;
      throw new Error(`UiAutomator2: failed to create session: ${val?.message ?? text}`);
    }

    let sessionId =
      (parsed["sessionId"] as string | undefined) ??
      ((parsed["value"] as Record<string, unknown> | undefined)?.["sessionId"] as
        | string
        | undefined);

    if (!sessionId) {
      throw new Error("UiAutomator2: no sessionId in session response");
    }

    this.sessionId = sessionId;
    return sessionId;
  }

  async deleteSession(): Promise<void> {
    if (this.sessionId === null) return;
    const path = `/session/${this.sessionId}`;
    this.sessionId = null;
    await fetch(`${this.baseUrl}${path}`, { method: "DELETE" });
  }

  // ---------------------------------------------------------------------------
  // Screen queries
  // ---------------------------------------------------------------------------

  async getSource(): Promise<string> {
    const value = await this.request<string>("GET", this.sessionPath("/source"));
    return value;
  }

  async getScreenshot(): Promise<string> {
    const value = await this.request<string>("GET", this.sessionPath("/screenshot"));
    return value;
  }

  async getWindowSize(): Promise<{ width: number; height: number }> {
    const value = await this.request<{ width: number; height: number }>(
      "GET",
      this.sessionPath("/window/size"),
    );
    return value;
  }

  // ---------------------------------------------------------------------------
  // Gestures — Appium gesture extensions
  // These match the endpoints used by maestro-runner's uiautomator2 client.
  // ---------------------------------------------------------------------------

  async performTap(x: number, y: number): Promise<void> {
    await this.request("POST", this.sessionPath("/appium/gestures/click"), {
      offset: { x, y },
    });
  }

  async performDoubleTap(x: number, y: number): Promise<void> {
    await this.request("POST", this.sessionPath("/appium/gestures/double_click"), {
      offset: { x, y },
    });
  }

  async performLongPress(x: number, y: number, duration: number): Promise<void> {
    await this.request("POST", this.sessionPath("/appium/gestures/long_click"), {
      offset: { x, y },
      duration, // milliseconds
    });
  }

  /**
   * Coordinate-based swipe from (startX, startY) to (endX, endY).
   *
   * The Appium swipe extension only accepts direction + percent; for arbitrary
   * from/to coordinates we use the W3C Actions API instead.
   *
   * @param duration - gesture duration in milliseconds
   */
  async performSwipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration: number,
  ): Promise<void> {
    await this.request("POST", this.sessionPath("/actions"), {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: startX, y: startY },
            { type: "pointerDown", button: 0 },
            { type: "pointerMove", duration, x: endX, y: endY },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // Text / keyboard
  // ---------------------------------------------------------------------------

  async sendKeys(text: string): Promise<void> {
    // W3C Actions key sequence — triggers TextWatcher events on Android
    const keyActions: Array<{ type: string; value?: string }> = [];
    for (const ch of text) {
      keyActions.push({ type: "keyDown", value: ch });
      keyActions.push({ type: "keyUp", value: ch });
    }
    await this.request("POST", this.sessionPath("/actions"), {
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: keyActions,
        },
      ],
    });
  }

  async pressKeyCode(keyCode: number): Promise<void> {
    await this.request("POST", this.sessionPath("/appium/device/press_keycode"), {
      keycode: keyCode,
    });
  }

  async hideKeyboard(): Promise<void> {
    await this.request("POST", this.sessionPath("/appium/device/hide_keyboard"), undefined);
  }

  // ---------------------------------------------------------------------------
  // App lifecycle
  // ---------------------------------------------------------------------------

  async activateApp(appPackage: string): Promise<void> {
    await this.request("POST", this.sessionPath("/appium/device/activate_app"), {
      appId: appPackage,
    });
  }

  async terminateApp(appPackage: string): Promise<void> {
    await this.request("POST", this.sessionPath("/appium/device/terminate_app"), {
      appId: appPackage,
    });
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

  async executeScript(script: string, args: unknown[] = []): Promise<unknown> {
    return this.request("POST", this.sessionPath("/execute/sync"), { script, args });
  }
}
