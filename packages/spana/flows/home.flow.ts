import { flow } from "../src/api/flow.js";

export default flow("Home screen loads", async ({ expect }) => {
  await expect({ testID: "home-screen" }).toBeVisible();
  await expect({ testID: "title-banner" }).toBeVisible();
  await expect({ testID: "api-status-heading" }).toBeVisible();
  await expect({ text: "API Status" }).toBeVisible();
});

export const settings = {
  tags: ["smoke"],
  platforms: ["web" as const],
};
