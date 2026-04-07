import { flow } from "spana-test";

export default flow(
  "Studio - run all tests and verify results",
  {
    tags: ["studio", "e2e"],
    platforms: ["web"],
    autoLaunch: false,
    timeout: 600_000, // 10 minutes — full test suite takes time
  },
  async ({ app, expect }) => {
    // Navigate to Studio Test Runner
    await app.launch({ deepLink: "http://localhost:4400" });

    // Click the Test Runner tab
    await app.tap("Test Runner");
    await expect("Flows").toBeVisible({ timeout: 5_000 });

    // Ensure all 3 platforms are selected (they should be by default)
    // The platform buttons show as brighter text when active
    await expect("web").toBeVisible();
    await expect("android").toBeVisible();
    await expect("ios").toBeVisible();

    // Verify flows are listed
    await expect("Select all").toBeVisible({ timeout: 5_000 });

    // Click Select All to ensure all flows are checked
    await app.tap("Select all");

    // Click Run button
    await app.tap("Run");

    // Wait for "Running..." state
    await expect("Running...").toBeVisible({ timeout: 10_000 });

    // Wait for run to complete — poll for "passed" or "failed" text in results header
    // This can take several minutes for all platforms
    await expect("Results").toBeVisible({ timeout: 10_000 });

    // Wait for the run to finish (Running... button should become Run again)
    // Use a long timeout since all 3 platforms run serially
    await app.evaluate(() => {
      return new Promise<void>((resolve) => {
        const check = () => {
          const btn = Array.from(document.querySelectorAll("button")).find(
            (b) => b.textContent?.trim() === "Run" || b.textContent?.trim() === "Re-run Failed",
          );
          if (
            btn &&
            !btn.textContent?.includes("Running") &&
            !btn.textContent?.includes("Starting")
          ) {
            resolve();
          } else {
            setTimeout(check, 2000);
          }
        };
        check();
      });
    });

    // Take a screenshot of the final results
    await app.takeScreenshot("studio-runner-results");

    // Verify the results summary is visible
    await expect("passed").toBeVisible({ timeout: 5_000 });

    // Check that there are no failures
    // Read the passed/failed counts from the UI
    const resultsText = await app.evaluate(() => {
      const header = document.querySelector("h2");
      const parent = header?.parentElement;
      return parent?.textContent ?? "";
    });
    console.log("[Studio E2E] Results:", resultsText);

    // Verify zero failures
    const failMatch = resultsText.match(/(\d+)\s*failed/);
    const failCount = failMatch ? parseInt(failMatch[1]!, 10) : -1;

    if (failCount > 0) {
      // Take screenshot showing failures
      await app.takeScreenshot("studio-runner-failures");
      throw new Error(
        `Studio test run had ${failCount} failure(s). Expected 0. Results: ${resultsText}`,
      );
    }

    if (failCount === -1) {
      throw new Error(`Could not parse results from Studio UI. Text: ${resultsText}`);
    }

    console.log("[Studio E2E] All tests passed in Studio!");
  },
);
