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
    await app.launch({ deepLink: "http://localhost:4400" });
    await app.evaluate(() => {
      sessionStorage.setItem(
        "spana-studio-runner",
        JSON.stringify({ runId: null, results: [], platforms: ["web"] }),
      );
    });
    await app.launch({ deepLink: "http://localhost:4400" });
    await expect({ testID: "studio-nav-runner" }).toBeVisible({ timeout: 10_000 });

    await app.tap({ testID: "studio-nav-runner" });
    await expect({ testID: "studio-runner-flow-list-title" }).toBeVisible({ timeout: 5_000 });
    await expect({
      testID: "studio-runner-flow-framework-app-home-screen-renders-on-every-platform",
    }).toBeVisible({ timeout: 10_000 });
    await expect({ testID: "studio-runner-platform-web" }).toBeVisible();
    await expect({ testID: "studio-runner-platform-android" }).toBeVisible();
    await expect({ testID: "studio-runner-platform-ios" }).toBeVisible();
    await expect({ testID: "studio-runner-capture-screenshots-input" }).toBeVisible();

    await app.tap({ testID: "studio-runner-capture-screenshots-input" });
    await app.tap({ testID: "studio-runner-capture-steps-input" });

    await app.evaluate(() => {
      return new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 15_000;
        const tick = () => {
          const runButton = document.querySelector<HTMLButtonElement>(
            '[data-testid="studio-runner-run"]',
          );
          if (runButton && !runButton.disabled) {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            reject(new Error("Studio Run button never became enabled"));
            return;
          }
          setTimeout(tick, 200);
        };
        tick();
      });
    });

    await app.tap({ testID: "studio-runner-run" });

    await app.evaluate(() => {
      return new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 15_000;
        const tick = () => {
          const runButton = document.querySelector('[data-testid="studio-runner-run"]');
          const runLabel = runButton?.textContent?.trim();
          const runningMessage = document.querySelector(
            '[data-testid="studio-runner-results-running-message"]',
          );
          if (runLabel === "Starting..." || runLabel === "Running..." || runningMessage) {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            reject(new Error("Studio run never entered a running state"));
            return;
          }
          setTimeout(tick, 200);
        };
        tick();
      });
    });

    const resultsText = await app.evaluate(() => {
      return new Promise<string>((resolve, reject) => {
        const deadline = Date.now() + 600_000;
        const check = () => {
          const runButton = document.querySelector<HTMLButtonElement>(
            '[data-testid="studio-runner-run"]',
          );
          const runLabel = runButton?.textContent?.trim();
          const summary = document
            .querySelector('[data-testid="studio-runner-results-summary"]')
            ?.textContent?.replaceAll(/\s+/g, " ")
            .trim();
          const hasSummary = /(\d+)\s*(passed|failed|skipped)/.test(summary ?? "");
          if (runButton && hasSummary && runLabel !== "Starting..." && runLabel !== "Running...") {
            if (runButton.disabled) {
              setTimeout(check, 1000);
              return;
            }
            resolve(summary ?? "");
            return;
          }
          if (Date.now() > deadline) {
            reject(new Error("Studio run did not complete within the timeout"));
            return;
          }
          setTimeout(check, 2000);
        };
        check();
      });
    });

    await app.takeScreenshot("studio-runner-results");
    await expect({ testID: "studio-runner-results-passed" }).toBeVisible({ timeout: 5_000 });

    console.log("[Studio E2E] Results:", resultsText);

    const failMatch = resultsText.match(/(\d+)\s*failed/);
    const passedMatch = resultsText.match(/(\d+)\s*passed/);
    const failCount = failMatch ? parseInt(failMatch[1]!, 10) : 0;
    const passedCount = passedMatch ? parseInt(passedMatch[1]!, 10) : 0;

    if (failCount > 0) {
      // Take screenshot showing failures
      await app.takeScreenshot("studio-runner-failures");
      throw new Error(
        `Studio test run had ${failCount} failure(s). Expected 0. Results: ${resultsText}`,
      );
    }

    if (passedCount === 0) {
      throw new Error(`Studio run completed without any passing flows. Results: ${resultsText}`);
    }

    const artifactIds = await app.evaluate(() => {
      const toggle = document.querySelector<HTMLElement>(
        '[data-testid^="studio-runner-result-"][data-testid$="-toggle"]',
      );
      const toggleTestId = toggle?.dataset.testid;
      if (!toggleTestId) {
        throw new Error("Could not find a Studio result row to inspect");
      }
      return { toggleTestId };
    });

    await app.tap({ testID: artifactIds.toggleTestId });

    const thumbnailIds = await app.evaluate(() => {
      return new Promise<{ thumbnailTestId: string; expandedImageTestId: string }>(
        (resolve, reject) => {
          const deadline = Date.now() + 15_000;
          const check = () => {
            const thumbnail = Array.from(
              document.querySelectorAll<HTMLElement>('[data-testid*="-thumbnail-"]'),
            ).find((candidate) => {
              const testId = candidate.dataset.testid ?? "";
              return (
                candidate.offsetParent !== null &&
                /-thumbnail-[^-]+(?:-[^-]+)*$/.test(testId) &&
                !testId.includes("-thumbnail-image-") &&
                !testId.includes("-thumbnail-name-")
              );
            });
            const thumbnailTestId = thumbnail?.dataset.testid;
            if (thumbnailTestId) {
              resolve({
                thumbnailTestId,
                expandedImageTestId: thumbnailTestId.replace(/-thumbnail-.+$/, "-expanded-image"),
              });
              return;
            }
            if (Date.now() > deadline) {
              reject(new Error("Studio result details never exposed screenshot thumbnails"));
              return;
            }
            setTimeout(check, 200);
          };
          check();
        },
      );
    });

    await expect({ testID: thumbnailIds.thumbnailTestId }).toBeVisible({ timeout: 5_000 });
    await app.tap({ testID: thumbnailIds.thumbnailTestId });
    await expect({ testID: thumbnailIds.expandedImageTestId }).toBeVisible({ timeout: 5_000 });

    console.log("[Studio E2E] All tests passed in Studio!");
  },
);
