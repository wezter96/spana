import { flow } from "../src/api/flow.js";

export default flow(
	"iOS E2E - Settings app with element matching",
	{ tags: ["e2e", "ios"], platforms: ["ios"], timeout: 30_000 },
	async ({ app, expect, platform }) => {
		console.log(`Running full e2e on: ${platform}`);

		// Settings app auto-launched via config bundleId
		// Assert "General" is visible (always present in Settings)
		await expect({ text: "General" }).toBeVisible({ timeout: 10_000 });

		// Assert "Display & Brightness" or similar
		await expect({ text: "Notifications" }).toBeVisible({ timeout: 10_000 });

		const screenshot = await app.takeScreenshot();
		console.log(`Screenshot: ${screenshot.length} bytes`);

		console.log("iOS full e2e with element matching passed!");
	},
);
