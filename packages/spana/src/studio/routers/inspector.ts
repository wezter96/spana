import { z } from "zod";
import { publicProcedure } from "../procedures.js";
import { connect, type Session, type ConnectOptions } from "../../agent/session.js";
import type { Platform } from "../../schemas/selector.js";
import type { ProvConfig } from "../../schemas/config.js";

const sessions = new Map<string, Session>();

function sessionKey(platform: string, deviceId?: string): string {
  return `${platform}:${deviceId ?? "default"}`;
}

function connectOptsFromConfig(
  platform: Platform,
  config: ProvConfig,
  deviceId?: string,
): ConnectOptions {
  const opts: ConnectOptions = { platform, device: deviceId };
  if (platform === "web") {
    const rawUrl = config.apps?.web?.url;
    opts.baseUrl =
      typeof rawUrl === "function"
        ? rawUrl({ workerIndex: 0, parallelIndex: 0 })
        : (rawUrl ?? "http://localhost:3000");
    opts.browser = config.execution?.web?.browser;
    opts.storageState = config.execution?.web?.storageState;
    opts.headless = false; // Studio needs visible browser for screenshots
  } else if (platform === "android") {
    opts.packageName = config.apps?.android?.packageName ?? "";
  } else if (platform === "ios") {
    opts.bundleId = config.apps?.ios?.bundleId ?? "";
  }
  return opts;
}

export async function getOrCreateSession(
  platform: Platform,
  config: ProvConfig,
  deviceId?: string,
): Promise<Session> {
  const key = sessionKey(platform, deviceId);
  const existing = sessions.get(key);
  if (existing) return existing;

  const opts = connectOptsFromConfig(platform, config, deviceId);
  const session = await connect(opts);
  sessions.set(key, session);
  return session;
}

export async function disconnectSession(platform: Platform, deviceId?: string): Promise<void> {
  const key = sessionKey(platform, deviceId);
  const session = sessions.get(key);
  sessions.delete(key);
  if (session) {
    await session.disconnect();
  }
}

export async function runWithRecoveredSession<T>(
  action: () => Promise<T>,
  resetSession: () => Promise<void>,
): Promise<T> {
  try {
    return await action();
  } catch {
    await resetSession();
  }

  try {
    return await action();
  } catch (error) {
    await resetSession();
    throw error;
  }
}

const inspectorInput = z.object({
  platform: z.enum(["web", "android", "ios"]),
  deviceId: z.string().optional(),
});

export const inspectorRouter = {
  screenshot: publicProcedure.input(inspectorInput).handler(async ({ input, context }) => {
    const data = await runWithRecoveredSession(
      async () => {
        const session = await getOrCreateSession(input.platform, context.config, input.deviceId);
        return session.screenshot();
      },
      () => disconnectSession(input.platform, input.deviceId),
    );
    return { image: Buffer.from(data).toString("base64") };
  }),

  hierarchy: publicProcedure.input(inspectorInput).handler(async ({ input, context }) => {
    return runWithRecoveredSession(
      async () => {
        const session = await getOrCreateSession(input.platform, context.config, input.deviceId);
        return session.hierarchy();
      },
      () => disconnectSession(input.platform, input.deviceId),
    );
  }),

  selectors: publicProcedure.input(inspectorInput).handler(async ({ input, context }) => {
    return runWithRecoveredSession(
      async () => {
        const session = await getOrCreateSession(input.platform, context.config, input.deviceId);
        return session.selectors();
      },
      () => disconnectSession(input.platform, input.deviceId),
    );
  }),

  disconnect: publicProcedure.input(inspectorInput).handler(async ({ input }) => {
    await disconnectSession(input.platform, input.deviceId);
    return { disconnected: true };
  }),
};
