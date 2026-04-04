import { flow } from "../src/api/flow.js";

export default flow(
	"Android - UiAutomator2 basic test",
	{ tags: ["smoke", "android"], platforms: ["android"], autoLaunch: false },
	async ({ app, expect, platform }) => {
		console.log(`Running on platform: ${platform}`);
		const screenshot = await app.takeScreenshot();
		console.log(`Screenshot captured: ${screenshot.length} bytes`);
	},
);
