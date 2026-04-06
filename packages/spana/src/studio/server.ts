import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { onError } from "@orpc/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { RPCHandler } from "@orpc/server/fetch";
import { ManagedRuntime, Layer } from "effect";
import { studioRouter } from "./api.js";
import { killActiveChildren } from "./routers/tests.js";
import type { StudioContext } from "./context.js";
import type { ProvConfig } from "../schemas/config.js";

export interface StudioOptions {
  port: number;
  open: boolean;
  config: ProvConfig;
  staticDir?: string;
}

export async function startStudio(options: StudioOptions) {
  const { port, open, config, staticDir } = options;
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

  app.use("/*", cors({ origin: `http://localhost:${port}`, credentials: true }));

  // RPC handler must come BEFORE static files to handle /rpc/* paths
  app.all("/rpc", async (c) => {
    const context: StudioContext = { runtime, config };
    const result = await rpcHandler.handle(c.req.raw, {
      prefix: "/rpc",
      context,
    });
    if (result.matched) {
      return c.newResponse(result.response.body, result.response);
    }
    return c.notFound();
  });

  app.all("/rpc/*", async (c) => {
    const context: StudioContext = { runtime, config };
    const result = await rpcHandler.handle(c.req.raw, {
      prefix: "/rpc",
      context,
    });
    if (result.matched) {
      return c.newResponse(result.response.body, result.response);
    }
    return c.notFound();
  });

  // Serve artifact files (screenshots, hierarchies) from spana-output
  app.get("/artifacts/*", async (c) => {
    const artifactPath = decodeURIComponent(c.req.path.replace("/artifacts/", ""));
    const configOutputDir = config.artifacts?.outputDir ?? "spana-output";
    const outputDir = configOutputDir.startsWith("/")
      ? configOutputDir
      : join(process.cwd(), configOutputDir);
    const filePath = join(outputDir, artifactPath);

    // Security: ensure path stays within outputDir
    if (!filePath.startsWith(outputDir)) {
      return c.text("Forbidden", 403);
    }

    if (existsSync(filePath)) {
      const content = await readFile(filePath);
      const ext = filePath.substring(filePath.lastIndexOf("."));
      const mime =
        ext === ".png"
          ? "image/png"
          : ext === ".json"
            ? "application/json"
            : "application/octet-stream";
      return c.body(content, 200, { "Content-Type": mime });
    }
    return c.notFound();
  });

  if (staticDir) {
    const mimeTypes: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
    };

    app.get("/*", async (c) => {
      const urlPath = c.req.path === "/" ? "/index.html" : c.req.path;
      const filePath = join(staticDir, urlPath);

      if (existsSync(filePath)) {
        const content = await readFile(filePath);
        const ext = urlPath.substring(urlPath.lastIndexOf("."));
        return c.body(content, 200, {
          "Content-Type": mimeTypes[ext] ?? "application/octet-stream",
        });
      }

      // SPA fallback: serve index.html for unmatched routes
      const indexPath = join(staticDir, "index.html");
      const html = await readFile(indexPath);
      return c.body(html, 200, { "Content-Type": "text/html" });
    });
  }

  const server = serve({ fetch: app.fetch, port });

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
    killActiveChildren();
    server.close();
    await runtime.dispose();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return { server, shutdown };
}
