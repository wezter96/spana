import { flow } from "spana-test";
import type { Platform } from "spana-test";

const WEB_BASE_URL = "http://127.0.0.1:8081";

function homePath(_platform: Platform): string {
  return "/";
}

function homeHref(platform: Platform): string {
  const path = homePath(platform);
  if (platform === "web") {
    return `${WEB_BASE_URL}${path}`;
  }

  const normalizedPath = path === "/" ? "" : path.replace(/^\/+/, "");
  return `spana://${normalizedPath}`;
}

export default flow(
  "Framework app - home screen renders on every platform",
  {
    tags: ["smoke", "e2e", "framework-app"],
    platforms: ["web", "android", "ios"],
    autoLaunch: false,
  },
  async ({ app, expect, platform }) => {
    await app.openLink(homeHref(platform));
    await expect({ testID: "home-scroll" }).toBeVisible({ timeout: 15_000 });
    await expect({ testID: "home-content" }).toBeVisible();
    await expect({ testID: "home-title" }).toBeVisible();
    await expect({ testID: "home-card" }).toBeVisible();
    await expect({ text: "Spana Demo" }).toBeVisible();
  },
);
