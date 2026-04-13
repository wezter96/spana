import type { PromiseApp } from "../api/app.js";
import type { PromiseExpectation } from "../api/expect.js";
import type { ExtendedSelector } from "../schemas/selector.js";
import type { BrowserName, StorybookConfig } from "../schemas/config.js";

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
