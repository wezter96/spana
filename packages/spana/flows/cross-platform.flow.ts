import { flow } from "../src/api/flow.js";

export default flow(
  "Cross-platform - basic test",
  { tags: ["smoke"] },
  async ({ app, platform }) => {
    console.log(`Running on platform: ${platform}`);
    // This flow runs on all platforms — no platform filter
    // Just verify the app launches and we can take a screenshot
    const screenshot = await app.takeScreenshot();
    console.log(`Screenshot captured: ${screenshot.length} bytes`);
  },
);
