import type { RawDriverService } from "../drivers/raw-driver.js";
import type { FlowDefinition } from "../api/flow.js";
import type { Platform } from "../schemas/selector.js";
import { createPromiseApp } from "../api/app.js";
import { createPromiseExpect } from "../api/expect.js";
import type { CoordinatorConfig } from "../smart/coordinator.js";

export interface TestResult {
  name: string;
  platform: Platform;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: Error;
}

export interface EngineConfig {
  appId: string;
  platform: Platform;
  coordinatorConfig: CoordinatorConfig;
  autoLaunch?: boolean;
  flowTimeout?: number;
}

export async function executeFlow(
  flow: FlowDefinition,
  driver: RawDriverService,
  config: EngineConfig,
): Promise<TestResult> {
  const start = Date.now();
  const { platform, coordinatorConfig, appId } = config;
  const autoLaunch = flow.config.autoLaunch ?? config.autoLaunch ?? true;
  const timeout = flow.config.timeout ?? config.flowTimeout ?? 60_000;

  try {
    const app = createPromiseApp(driver, appId, coordinatorConfig);
    const expect = createPromiseExpect(driver, coordinatorConfig);

    if (autoLaunch) {
      await app.launch();
    }

    // Execute with timeout
    await Promise.race([
      flow.fn({ app, expect, platform }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Flow "${flow.name}" timed out after ${timeout}ms`)), timeout),
      ),
    ]);

    return {
      name: flow.name,
      platform,
      status: "passed",
      durationMs: Date.now() - start,
    };
  } catch (error) {
    return {
      name: flow.name,
      platform,
      status: "failed",
      durationMs: Date.now() - start,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
