import type { RawDriverService } from "../drivers/raw-driver.js";
import type { Platform } from "../schemas/selector.js";
import type { EngineConfig } from "../core/engine.js";

export interface RuntimeHandle {
  driver: RawDriverService;
  cleanup: () => Promise<void>;
  metadata: {
    platform: Platform;
    mode: "local" | "appium";
    adapter?: string;
    deviceId?: string;
    sessionId?: string;
    provider?: string;
    sessionCaps?: Record<string, unknown>;
  };
}

export interface RuntimeResult {
  runtime: RuntimeHandle;
  engineConfig: EngineConfig;
}
