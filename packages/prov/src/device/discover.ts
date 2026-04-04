import type { Platform } from "../schemas/selector.js";
import { listAndroidDevices } from "./android.js";
import { listBootedSimulators } from "./ios.js";

export interface DiscoveredDevice {
  platform: Platform;
  id: string;
  name: string;
  type: "emulator" | "simulator" | "device" | "browser";
  state: string;
}

/** Discover all available devices across requested platforms */
export function discoverDevices(platforms: Platform[]): DiscoveredDevice[] {
  const devices: DiscoveredDevice[] = [];

  if (platforms.includes("web")) {
    devices.push({
      platform: "web",
      id: "playwright-chromium",
      name: "Chromium (Playwright)",
      type: "browser",
      state: "available",
    });
  }

  if (platforms.includes("android")) {
    for (const d of listAndroidDevices()) {
      if (d.state === "device") {
        devices.push({
          platform: "android",
          id: d.serial,
          name: d.serial,
          type: d.type === "emulator" ? "emulator" : "device",
          state: d.state,
        });
      }
    }
  }

  if (platforms.includes("ios")) {
    for (const s of listBootedSimulators()) {
      devices.push({
        platform: "ios",
        id: s.udid,
        name: `${s.name} (${s.runtime})`,
        type: "simulator",
        state: s.state,
      });
    }
  }

  return devices;
}

/** Get first available device for a platform */
export function firstDeviceForPlatform(platform: Platform): DiscoveredDevice | null {
  const devices = discoverDevices([platform]);
  return devices[0] ?? null;
}
