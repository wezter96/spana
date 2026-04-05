import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ManagedRuntime, Layer } from "effect";
import { studioRouter } from "./api.js";
import type { StudioContext } from "./context.js";
import type { ProvConfig } from "../schemas/config.js";

export interface StudioOptions {
  port: number;
  open: boolean;
  config: ProvConfig;
  staticDir?: string;
}

export async function startStudio(options: StudioOptions) {
  const { port, open, config: _config, staticDir } = options;
  const app = new Hono();

  const StudioLayer = Layer.empty;
  const runtime = ManagedRuntime.make(StudioLayer);

  const rpcHandler = new RPCHandler(studioRouter, {
    interceptors: [
      onError((error) => {
        console.error("[studio]", error);
      }),
    ],
  });

  app.use("/*", cors({ origin: `http://localhost:${port}` }));

  app.use("/rpc/*", async (c) => {
    const context: StudioContext = { runtime };
    const result = await rpcHandler.handle(c.req.raw, {
      prefix: "/rpc",
      context,
    });
    if (result.matched) {
      return c.newResponse(result.response.body, result.response);
    }
    return c.notFound();
  });

  if (staticDir) {
    app.use("/*", serveStatic({ root: staticDir }));
    app.get("/*", serveStatic({ root: staticDir, path: "index.html" }));
  }

  const server = Bun.serve({ port, fetch: app.fetch });

  console.log(`\n  Spana Studio running at http://localhost:${port}\n`);

  if (open) {
    const { exec } = await import("node:child_process");
    const cmd =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${cmd} http://localhost:${port}`, (error) => {
      if (error) {
        console.warn(`[studio] Failed to open browser:`, error.message);
      }
    });
  }

  const shutdown = async () => {
    console.log("\n  Shutting down Spana Studio...\n");
    await runtime.dispose();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return { server, shutdown };
}
