import { splitGraphemes } from "../../core/graphemes.js";

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
    try {
      return await this.request<{ width: number; height: number }>(
        "GET",
        this.sessionPath("/window/current/size"),
      );
    } catch {
      // Fallback: try legacy endpoint
      try {
        return await this.request<{ width: number; height: number }>(
          "GET",
          this.sessionPath("/window/size"),
        );
      } catch {
        // Default screen size if neither endpoint is available
        return { width: 1080, height: 1920 };
      }
    }
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

  /**
   * Pinch gesture (zoom out) — two fingers move toward center.
   *
   * @param cx - center X coordinate
   * @param cy - center Y coordinate
   * @param scale - 0..1 representing how far fingers start from center (as fraction of 200px)
   * @param duration - gesture duration in milliseconds
   */
  async performPinch(cx: number, cy: number, scale: number, duration: number): Promise<void> {
    const dist = 200 * scale;
    await this.request("POST", this.sessionPath("/actions"), {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: Math.round(cx - dist), y: Math.round(cy) },
            { type: "pointerDown", button: 0 },
            { type: "pointerMove", duration, x: Math.round(cx - 10), y: Math.round(cy) },
            { type: "pointerUp", button: 0 },
          ],
        },
        {
          type: "pointer",
          id: "finger2",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: Math.round(cx + dist), y: Math.round(cy) },
            { type: "pointerDown", button: 0 },
            { type: "pointerMove", duration, x: Math.round(cx + 10), y: Math.round(cy) },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
  }

  /**
   * Zoom gesture (zoom in) — two fingers move away from center.
   *
   * @param cx - center X coordinate
   * @param cy - center Y coordinate
   * @param scale - 0..1 representing how far fingers end from center (as fraction of 200px)
   * @param duration - gesture duration in milliseconds
   */
  async performZoom(cx: number, cy: number, scale: number, duration: number): Promise<void> {
    const dist = 200 * scale;
    await this.request("POST", this.sessionPath("/actions"), {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: Math.round(cx - 10), y: Math.round(cy) },
            { type: "pointerDown", button: 0 },
            { type: "pointerMove", duration, x: Math.round(cx - dist), y: Math.round(cy) },
            { type: "pointerUp", button: 0 },
          ],
        },
        {
          type: "pointer",
          id: "finger2",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: Math.round(cx + 10), y: Math.round(cy) },
            { type: "pointerDown", button: 0 },
            { type: "pointerMove", duration, x: Math.round(cx + dist), y: Math.round(cy) },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
  }

  /**
   * Arbitrary multi-touch gesture using W3C Actions.
   * Each sequence represents one finger with a series of actions.
   */
  async performMultiTouch(
    sequences: Array<{
      id: number;
      actions: Array<
        | { type: "move"; x: number; y: number; duration?: number }
        | { type: "down" }
        | { type: "up" }
        | { type: "pause"; duration: number }
      >;
    }>,
  ): Promise<void> {
    const actions = sequences.map((seq) => ({
      type: "pointer" as const,
      id: `finger${seq.id}`,
      parameters: { pointerType: "touch" as const },
      actions: seq.actions.map((a) => {
        switch (a.type) {
          case "move":
            return {
              type: "pointerMove" as const,
              duration: a.duration ?? 0,
              x: Math.round(a.x),
              y: Math.round(a.y),
            };
          case "down":
            return { type: "pointerDown" as const, button: 0 };
          case "up":
            return { type: "pointerUp" as const, button: 0 };
          case "pause":
            return { type: "pause" as const, duration: a.duration };
        }
      }),
    }));
    await this.request("POST", this.sessionPath("/actions"), { actions });
  }

  // ---------------------------------------------------------------------------
  // Text / keyboard
  // ---------------------------------------------------------------------------

  async sendKeys(text: string): Promise<void> {
    // Check if text contains characters that UiAutomator2 can't synthesize via W3C Actions
    // (e.g., ZWJ emoji sequences, non-BMP characters)
    const hasComplexChars = /[\u{10000}-\u{10FFFF}]|\u200D/u.test(text);

    if (hasComplexChars) {
      // W3C Actions can't synthesize emoji/ZWJ sequences on Android.
      // Use sendKeysViaActions for the simple chars and skip unsupported chars,
      // accepting that complex emoji may not be typed on Android emulators.
      // This is a known UiAutomator2 limitation.
      const segments = splitGraphemes(text);
      let simpleBatch = "";

      for (const segment of segments) {
        if (/[\u{10000}-\u{10FFFF}]|\u200D/u.test(segment)) {
          if (simpleBatch) {
            await this.sendKeysViaActions(simpleBatch);
            simpleBatch = "";
          }
          // Skip complex emoji — UiAutomator2 cannot synthesize them
        } else {
          simpleBatch += segment;
        }
      }

      if (simpleBatch) {
        await this.sendKeysViaActions(simpleBatch);
      }
      return;
    }

    await this.sendKeysViaActions(text);
  }

  private async sendKeysViaActions(text: string): Promise<void> {
    // W3C Actions key sequence — triggers TextWatcher events on Android
    const keyActions: Array<{ type: string; value?: string }> = [];
    for (const segment of splitGraphemes(text)) {
      keyActions.push({ type: "keyDown", value: segment });
      keyActions.push({ type: "keyUp", value: segment });
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
