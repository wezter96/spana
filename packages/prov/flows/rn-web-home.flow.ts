import { flow } from "../src/api/flow.js";

export default flow(
	"RN Web - Home screen loads",
	{ tags: ["smoke", "rn-web"], platforms: ["web"] },
	async ({ expect }) => {
		await expect({ testID: "home-content" }).toBeVisible();
		await expect({ testID: "home-title" }).toBeVisible();
		await expect({ testID: "home-card" }).toBeVisible();
		await expect({ text: "BETTER T STACK" }).toBeVisible();
	},
);
