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
    opts.baseUrl = config.apps?.web?.url ?? "http://localhost:3000";
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

async function getOrCreateSession(
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

const inspectorInput = z.object({
  platform: z.enum(["web", "android", "ios"]),
  deviceId: z.string().optional(),
});

export const inspectorRouter = {
  screenshot: publicProcedure.input(inspectorInput).handler(async ({ input, context }) => {
    const session = await getOrCreateSession(input.platform, context.config, input.deviceId);
    const data = await session.screenshot();
    const base64 = Buffer.from(data).toString("base64");
    return { image: base64 };
  }),

  hierarchy: publicProcedure.input(inspectorInput).handler(async ({ input, context }) => {
    const session = await getOrCreateSession(input.platform, context.config, input.deviceId);
    return session.hierarchy();
  }),

  selectors: publicProcedure.input(inspectorInput).handler(async ({ input, context }) => {
    const session = await getOrCreateSession(input.platform, context.config, input.deviceId);
    return session.selectors();
  }),

  disconnect: publicProcedure.input(inspectorInput).handler(async ({ input }) => {
    const key = sessionKey(input.platform, input.deviceId);
    const session = sessions.get(key);
    if (session) {
      await session.disconnect();
      sessions.delete(key);
    }
    return { disconnected: true };
  }),
};
