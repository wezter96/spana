import { flow } from "spana-test";

export default flow(
  "Studio - inspector selects live elements and recorder surfaces render",
  {
    tags: ["studio", "e2e", "showcase"],
    platforms: ["web"],
    autoLaunch: false,
  },
  async ({ app, expect }) => {
    await app.launch({ deepLink: "http://localhost:4400" });

    await expect({ testID: "studio-nav-inspector" }).toBeVisible({ timeout: 10_000 });
    await expect({ testID: "studio-inspector-screenshot-image" }).toBeVisible({ timeout: 20_000 });
    await expect({ testID: "studio-element-tree-node-body-root" }).toBeVisible({ timeout: 10_000 });
    await expect({ testID: "studio-element-details-empty" }).toBeVisible({ timeout: 5_000 });

    await app.tap({ testID: "studio-inspector-refresh" });
    await expect({ testID: "studio-inspector-screenshot-image" }).toBeVisible({ timeout: 20_000 });
    await app.tap({ testID: "studio-element-tree-node-body-root" });
    await expect({ testID: "studio-element-detail-elementType" }).toBeVisible({ timeout: 5_000 });
    await app.evaluate(() => {
      const elementType = document
        .querySelector('[data-testid="studio-element-detail-elementType"]')
        ?.textContent?.replaceAll(/\s+/g, " ")
        .trim();
      if (!elementType?.includes("body")) {
        throw new Error(`Expected selected element type to include body, received: ${elementType}`);
      }
    });
    await app.takeScreenshot("studio-inspector-selection");

    await app.tap({ testID: "studio-nav-recorder" });
    await expect({ testID: "studio-recorder-start" }).toBeVisible({ timeout: 5_000 });
    await expect({ testID: "studio-recorder-platform-select" }).toBeVisible({ timeout: 5_000 });
    await expect({ testID: "studio-recorder-code-empty" }).toBeVisible({ timeout: 5_000 });

    await app.tap({ testID: "studio-nav-runner" });
    await expect({ testID: "studio-runner-select-all" }).toBeVisible({ timeout: 5_000 });
    await expect({
      testID: "studio-runner-flow-framework-app-home-screen-renders-on-every-platform",
    }).toBeVisible({ timeout: 10_000 });
  },
);
