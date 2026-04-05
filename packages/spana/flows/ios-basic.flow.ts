import { flow } from "../src/api/flow.js";

export default flow(
  "iOS - WDA basic test",
  { tags: ["smoke", "ios"], platforms: ["ios"], autoLaunch: false },
  async ({ app, platform }) => {
    console.log(`Running on platform: ${platform}`);
    // Just take a screenshot to prove WDA works
    const screenshot = await app.takeScreenshot();
    console.log(`Screenshot captured: ${screenshot.length} bytes`);
  },
);
