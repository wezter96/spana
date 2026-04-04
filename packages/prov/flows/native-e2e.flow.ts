import { flow } from "../src/api/flow.js";

export default flow(
	"Native E2E - Home screen with testIDs",
	{ tags: ["e2e"], platforms: ["android", "ios"] },
	async ({ app, expect, platform }) => {
		console.log(`Running full e2e on: ${platform}`);

		// Verify elements with testIDs are visible
		await expect({ testID: "home-content" }).toBeVisible();
		await expect({ testID: "home-title" }).toBeVisible();

		// Verify text content
		await expect({ text: "BETTER T STACK" }).toBeVisible();

		// Take a screenshot as proof
		const screenshot = await app.takeScreenshot();
		console.log(`Screenshot: ${screenshot.length} bytes`);

		console.log(`${platform} e2e passed!`);
	},
);
