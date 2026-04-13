import { Effect } from "effect";
import { createPromiseApp } from "../api/app.js";
import type { PromiseApp } from "../api/app.js";
import { createPromiseExpect } from "../api/expect.js";
import type { PromiseExpectation } from "../api/expect.js";
import { parseWebHierarchy } from "../drivers/playwright-parser.js";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { ExtendedSelector } from "../schemas/selector.js";
import type { BrowserName, StorybookConfig } from "../schemas/config.js";
import type { CoordinatorConfig } from "../smart/coordinator.js";

export interface SecondarySessionOptions {
  name: string;
  platform: "web";
  baseUrl?: string;
  headless?: boolean;
  browser?: BrowserName;
  storageState?: string;
  verboseLogging?: boolean;
  storybook?: StorybookConfig;
}

export interface SecondarySession {
  readonly name: string;
  readonly platform: "web";
  readonly app: PromiseApp;
  readonly expect: (selector: ExtendedSelector) => PromiseExpectation;
  disconnect(): Promise<void>;
}

export interface Sessions {
  open(opts: SecondarySessionOptions): Promise<SecondarySession>;
}

export type DriverFactory = (opts: SecondarySessionOptions) => Promise<RawDriverService>;

export function createSessions(
  manager: SessionManager,
  driverFactory: DriverFactory,
  coordinatorConfig?: CoordinatorConfig,
): Sessions {
  const coordConfig: CoordinatorConfig = coordinatorConfig ?? { parse: parseWebHierarchy };

  return {
    async open(opts: SecondarySessionOptions): Promise<SecondarySession> {
      const existing = manager.all().find((s) => s.name === opts.name);
      if (existing) {
        throw new Error(`Session "${opts.name}" already exists`);
      }

      const driver = await driverFactory(opts);
      const baseUrl = opts.baseUrl ?? "http://localhost:3000";

      await Effect.runPromise(driver.launchApp(baseUrl));

      const app = createPromiseApp(driver, baseUrl, coordConfig, undefined, {
        platform: "web",
      });
      const expect = createPromiseExpect(driver, coordConfig);

      const session: SecondarySession = {
        name: opts.name,
        platform: "web",
        app,
        expect,
        async disconnect() {
          await Effect.runPromise(driver.killApp(baseUrl));
          manager.remove(opts.name);
        },
      };

      const cleanup = async () => {
        await Effect.runPromise(driver.killApp(baseUrl));
      };

      manager.register(session, cleanup);
      return session;
    },
  };
}

export class SessionManager {
  private sessions: Array<{ session: SecondarySession; cleanup: () => Promise<void> }> = [];

  all(): SecondarySession[] {
    return this.sessions.map((s) => s.session);
  }

  register(session: SecondarySession, cleanup: () => Promise<void>): void {
    this.sessions.push({ session, cleanup });
  }

  remove(name: string): void {
    this.sessions = this.sessions.filter((s) => s.session.name !== name);
  }

  async disconnectAll(): Promise<void> {
    const errors: unknown[] = [];
    // Disconnect in reverse order (LIFO)
    for (const entry of [...this.sessions].toReversed()) {
      try {
        await entry.cleanup();
      } catch (err) {
        errors.push(err);
      }
    }
    this.sessions = [];
    if (errors.length > 0) {
      console.warn(
        `SessionManager: ${errors.length} error(s) during cleanup:`,
        errors.map((e) => (e instanceof Error ? e.message : String(e))),
      );
    }
  }
}
