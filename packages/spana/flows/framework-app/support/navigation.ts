import type { FlowContext } from "spana-test";
import type { Platform } from "spana-test";

export const WEB_BASE_URL = "http://127.0.0.1:8081";

export function buildFrameworkHref(platform: Platform, path: string): string {
  if (platform === "web") {
    return `${WEB_BASE_URL}${path}`;
  }

  const normalizedPath = path === "/" ? "" : path.replace(/^\/+/, "");
  return `spana://${normalizedPath}`;
}

type NavigationContext = Pick<FlowContext, "app" | "expect" | "platform">;

export async function navigateToHomeScreen({
  app,
  expect,
  platform,
}: NavigationContext): Promise<void> {
  if (platform === "ios") {
    // Use app.launch() instead of openLink with custom scheme — WDA's openUrl
    // routes through Safari which breaks the WDA session for spana:// URLs.
    await app.launch();
    await expect({ testID: "home-title" }).toBeVisible({ timeout: 10_000 });
    return;
  }

  await app.launch({
    clearState: platform === "android",
    deepLink: buildFrameworkHref(platform, "/"),
  });

  if (platform === "android") {
    try {
      await expect({ testID: "home-title" }).toBeVisible({ timeout: 3_000 });
    } catch {
      await app.tap({ accessibilityLabel: "Show navigation menu" });
      await app.tap({ testID: "drawer-home-item" });
    }
  }

  await expect({ testID: "home-title" }).toBeVisible({ timeout: 10_000 });
}

export async function navigateToTabsScreen(ctx: NavigationContext): Promise<void> {
  await navigateToHomeScreen(ctx);
  await ctx.expect({ accessibilityLabel: "Show navigation menu" }).toBeVisible({
    timeout: 10_000,
  });
  await ctx.app.tap({ accessibilityLabel: "Show navigation menu" });
  await ctx.expect({ testID: "drawer-tabs-item" }).toBeVisible({ timeout: 10_000 });
  await ctx.app.tap({ testID: "drawer-tabs-item" });
  await ctx.expect({ testID: "tab-one-title" }).toBeVisible({ timeout: 15_000 });
}
