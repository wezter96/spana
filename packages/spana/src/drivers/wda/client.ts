import { splitGraphemes } from "../../core/graphemes.js";

/**
 * HTTP client for WebDriverAgent (WDA) on iOS.
 *
 * WDA runs on the iOS device / simulator and is accessed via USB tunnel or
 * simulator localhost. All touch endpoints use WDA-specific routes under
 * `/wda/` rather than the generic W3C Actions API, matching the
 * maestro-runner WDA client implementation.
 *
 * Reference: /Users/anton/.superset/projects/maestro-runner/pkg/driver/wda/client.go
 */

interface WdaResponse {
  sessionId?: string;
  value: unknown;
}

export class WDAClient {
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

    let parsed: WdaResponse;
    try {
      parsed = JSON.parse(text) as WdaResponse;
    } catch {
      throw new Error(`WDA: failed to parse response: ${text}`);
    }

    if (!res.ok) {
      const val = parsed.value as Record<string, unknown> | undefined;
      const msg = val?.message ?? val?.error ?? text;
      throw new Error(`WDA ${method} ${path} → ${res.status}: ${msg}`);
    }

    // Surface WDA error values embedded in a 200 response ({"value":{"error":...}})
    if (
      parsed.value !== null &&
      typeof parsed.value === "object" &&
      "error" in (parsed.value as object)
    ) {
      const val = parsed.value as Record<string, unknown>;
      throw new Error(`WDA error: ${val.message ?? val.error}`);
    }

    return parsed.value as T;
  }

  private sessionPath(path: string): string {
    if (this.sessionId === null) {
      throw new Error("WDA: no active session");
    }
    return `/session/${this.sessionId}${path}`;
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  /**
   * Creates a new WDA session.
   *
   * @param bundleId - the app bundle ID to attach to (e.g. "com.example.app")
   * @param alertAction - optional auto-alert handling: "accept" | "dismiss"
   */
  async createSession(bundleId?: string, alertAction?: string): Promise<string> {
    const alwaysMatch: Record<string, unknown> = {
      shouldWaitForQuiescence: false,
      waitForIdleTimeout: 0,
      shouldUseTestManagerForVisibilityDetection: false,
    };
    if (bundleId) {
      alwaysMatch["bundleId"] = bundleId;
    }
    if (alertAction) {
      alwaysMatch["defaultAlertAction"] = alertAction;
    }

    const res = await fetch(`${this.baseUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capabilities: { alwaysMatch },
      }),
    });

    const text = await res.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`WDA: failed to parse session response: ${text}`);
    }

    if (!res.ok) {
      const val = parsed["value"] as Record<string, unknown> | undefined;
      throw new Error(`WDA: failed to create session: ${val?.message ?? text}`);
    }

    // Session ID may be at root or nested under value
    let sessionId =
      (parsed["sessionId"] as string | undefined) ??
      ((parsed["value"] as Record<string, unknown> | undefined)?.["sessionId"] as
        | string
        | undefined);

    if (!sessionId) {
      throw new Error("WDA: no sessionId in session response");
    }

    this.sessionId = sessionId;
    return sessionId;
  }

  async deleteSession(): Promise<void> {
    if (this.sessionId === null) return;
    const path = `/session/${this.sessionId}`;
    try {
      await fetch(`${this.baseUrl}${path}`, { method: "DELETE" });
    } finally {
      this.sessionId = null;
    }
  }

  hasSession(): boolean {
    return this.sessionId !== null;
  }

  sessionID(): string | null {
    return this.sessionId;
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  async updateSettings(settings: Record<string, unknown>): Promise<void> {
    await this.request("POST", this.sessionPath("/appium/settings"), {
      settings,
    });
  }

  async disableQuiescence(): Promise<void> {
    await this.updateSettings({
      shouldWaitForQuiescence: false,
      waitForIdleTimeout: 0,
    });
  }

  /**
   * Sets the maximum depth for UI hierarchy snapshots.
   * Higher values (e.g. 100) are required for deeply nested React Native apps.
   */
  async setSnapshotMaxDepth(depth: number): Promise<void> {
    await this.updateSettings({ snapshotMaxDepth: depth });
  }

  // ---------------------------------------------------------------------------
  // Screen queries
  // ---------------------------------------------------------------------------

  /** Returns the UI hierarchy as XML. */
  async getSource(): Promise<string> {
    const value = await this.request<string>("GET", this.sessionPath("/source"));
    return value;
  }

  /**
   * Captures the screen and returns PNG bytes.
   *
   * The Go client calls GET /session/{id}/screenshot (session-prefixed) and
   * decodes the base64 value. We follow the same pattern.
   */
  async getScreenshot(): Promise<Uint8Array> {
    const base64 = await this.request<string>("GET", this.sessionPath("/screenshot"));
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  }

  /** Returns the screen dimensions in logical points. */
  async getWindowSize(): Promise<{ width: number; height: number }> {
    const value = await this.request<{ width: number; height: number }>(
      "GET",
      this.sessionPath("/window/size"),
    );
    return value;
  }

  // ---------------------------------------------------------------------------
  // Touch actions — WDA-specific endpoints
  // ---------------------------------------------------------------------------

  async tap(x: number, y: number): Promise<void> {
    await this.request("POST", this.sessionPath("/wda/tap"), { x, y });
  }

  async doubleTap(x: number, y: number): Promise<void> {
    // Two SEPARATE W3C Action requests. Each uses XCSynthesizedEventRecord
    // (lower-level than /wda/tap's [XCUICoordinate tap]) and includes a
    // quiescence wait after completion. Splitting into two requests ensures
    // iOS treats them as independent gestures — a single request with both
    // taps gets interpreted as a scroll/pan by the ScrollView.
    const rx = Math.round(x);
    const ry = Math.round(y);
    const singleTap = [
      {
        type: "pointer" as const,
        id: "finger1",
        parameters: { pointerType: "touch" },
        actions: [
          { type: "pointerMove", duration: 0, x: rx, y: ry },
          { type: "pointerDown", button: 0 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ];
    // Two taps with delay. Uses W3C Actions (XCSynthesizedEventRecord)
    // for each tap independently, with quiescence wait between them.
    await this.request("POST", this.sessionPath("/actions"), { actions: singleTap });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await this.request("POST", this.sessionPath("/actions"), { actions: singleTap });
  }

  /**
   * Long-presses at coordinates.
   *
   * @param durationSec - hold duration in **seconds** (WDA convention)
   */
  async longPress(x: number, y: number, durationSec: number): Promise<void> {
    await this.request("POST", this.sessionPath("/wda/touchAndHold"), {
      x,
      y,
      duration: durationSec,
    });
  }

  /**
   * Swipes from one point to another.
   *
   * @param durationSec - gesture duration in **seconds** (WDA convention)
   */
  async swipe(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    durationSec: number,
  ): Promise<void> {
    await this.request("POST", this.sessionPath("/wda/dragfromtoforduration"), {
      fromX,
      fromY,
      toX,
      toY,
      duration: durationSec,
    });
  }

  /**
   * Pinch gesture (zoom out) — two fingers move toward center.
   *
   * @param cx - center X coordinate
   * @param cy - center Y coordinate
   * @param scale - 0..1 representing how far fingers start from center (as fraction of 200px)
   * @param durationSec - gesture duration in seconds (WDA convention)
   */
  async pinch(cx: number, cy: number, scale: number, durationSec: number): Promise<void> {
    const dist = 200 * scale;
    const durationMs = durationSec * 1000;
    await this.request("POST", this.sessionPath("/actions"), {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: Math.round(cx - dist), y: Math.round(cy) },
            { type: "pointerDown", button: 0 },
            {
              type: "pointerMove",
              duration: durationMs,
              x: Math.round(cx - 10),
              y: Math.round(cy),
            },
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
            {
              type: "pointerMove",
              duration: durationMs,
              x: Math.round(cx + 10),
              y: Math.round(cy),
            },
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
   * @param durationSec - gesture duration in seconds (WDA convention)
   */
  async zoom(cx: number, cy: number, scale: number, durationSec: number): Promise<void> {
    const dist = 200 * scale;
    const durationMs = durationSec * 1000;
    await this.request("POST", this.sessionPath("/actions"), {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: Math.round(cx - 10), y: Math.round(cy) },
            { type: "pointerDown", button: 0 },
            {
              type: "pointerMove",
              duration: durationMs,
              x: Math.round(cx - dist),
              y: Math.round(cy),
            },
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
            {
              type: "pointerMove",
              duration: durationMs,
              x: Math.round(cx + dist),
              y: Math.round(cy),
            },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
  }

  /**
   * Arbitrary multi-touch gesture using W3C Actions.
   */
  async multiTouch(
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

  /**
   * Types text. WDA expects the value as an array of individual characters.
   *
   * @param frequency - typing speed in keys/sec (0 = WDA default ~60/s)
   */
  async sendKeys(text: string, frequency = 25): Promise<void> {
    const body: Record<string, unknown> = {
      value: splitGraphemes(text),
    };
    if (frequency > 0) {
      body["frequency"] = frequency;
    }
    await this.request("POST", this.sessionPath("/wda/keys"), body);
  }

  /**
   * Presses a hardware button by name.
   *
   * @param button - "home" | "volumeUp" | "volumeDown"
   */
  async pressButton(button: string): Promise<void> {
    await this.request("POST", this.sessionPath("/wda/pressButton"), {
      name: button,
    });
  }

  async pressHome(): Promise<void> {
    await this.pressButton("home");
  }

  // ---------------------------------------------------------------------------
  // App lifecycle
  // ---------------------------------------------------------------------------

  async launchApp(bundleId: string, args?: string[]): Promise<void> {
    const body: Record<string, unknown> = { bundleId };
    if (args && args.length > 0) {
      body["arguments"] = args;
    }
    await this.request("POST", this.sessionPath("/wda/apps/launch"), body);
  }

  async terminateApp(bundleId: string): Promise<void> {
    await this.request("POST", this.sessionPath("/wda/apps/terminate"), {
      bundleId,
    });
  }

  async activateApp(bundleId: string): Promise<void> {
    await this.request("POST", this.sessionPath("/wda/apps/activate"), {
      bundleId,
    });
  }

  // ---------------------------------------------------------------------------
  // Deep link / URL
  // ---------------------------------------------------------------------------

  /** Opens a URL or deep link. Works for both simulator and real device. */
  async openUrl(url: string): Promise<void> {
    await this.request("POST", this.sessionPath("/url"), { url });
  }

  // ---------------------------------------------------------------------------
  // Alerts
  // ---------------------------------------------------------------------------

  async acceptAlert(): Promise<void> {
    await this.request("POST", this.sessionPath("/alert/accept"), undefined);
  }

  async dismissAlert(): Promise<void> {
    await this.request("POST", this.sessionPath("/alert/dismiss"), undefined);
  }

  // ---------------------------------------------------------------------------
  // Device status
  // ---------------------------------------------------------------------------

  async getStatus(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", "/status");
  }
}
