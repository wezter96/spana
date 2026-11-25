import { flow } from "spana-test";

const WEB_BASE_URL = "http://127.0.0.1:8081";

export default flow(
  "Secondary web session - iOS primary + web admin session both load",
  {
    tags: ["e2e", "secondary-sessions"],
    platforms: ["ios"],
    autoLaunch: false,
  },
  async ({ app, expect, sessions }) => {
    // 1. Launch the native iOS app and verify the home screen loads
    await app.launch({ deepLink: "spana://" });
    await expect({ testID: "home-scroll" }).toBeVisible({ timeout: 15_000 });
    await expect({ testID: "home-title" }).toBeVisible();

    // 2. Open a secondary web session against the same app served via Expo web
    const web = await sessions.open({
      name: "web-admin",
      platform: "web",
      baseUrl: WEB_BASE_URL,
      headless: true,
    });

    // 3. Verify the web session loaded the home screen
    await web.expect({ testID: "home-scroll" }).toBeVisible({ timeout: 15_000 });
    await web.expect({ testID: "home-title" }).toBeVisible();
    await web.expect({ text: "Spana Demo" }).toBeVisible();

    // 4. Interact with the native app while web session is still open
    await expect({ testID: "home-card" }).toBeVisible();

    // 5. Explicitly disconnect the web session (engine also auto-cleans on flow end)
    await web.disconnect();
  },
);
