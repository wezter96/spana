/**
 * Opt-in local Appium server lifecycle management.
 *
 * When `execution.appium.autoStart` is true (or `--appium-auto-start` is
 * passed), spana spawns a local `appium` subprocess, waits for it to
 * become ready, and returns a URL + cleanup function. The server is torn
 * down on process exit (including Ctrl-C and test failures) via the
 * runCleanups mechanism in test-command.ts.
 *
 * This is for dev iteration on Appium driver bugs without burning cloud
 * minutes. Never starts implicitly — opt-in only.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

export interface AutoStartedAppium {
  url: string;
  stop: () => Promise<void>;
}

export interface AutoStartOptions {
  /** Max ms to wait for the server to become ready. Default: 30000 */
  readyTimeout?: number;
  /** Executable name. Default: "appium" */
  binary?: string;
  /** Extra CLI args to pass through to appium. */
  extraArgs?: readonly string[];
  /** Optional logger for server stdout/stderr (default: noop). */
  log?: (line: string) => void;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error("Failed to allocate free port for Appium"));
      }
    });
  });
}

/**
 * Spawns a local Appium server on a free port and waits for it to be ready.
 *
 * @throws if the `appium` binary is not found, or if the server doesn't
 *         become ready within the timeout.
 */
export async function startLocalAppium(opts: AutoStartOptions = {}): Promise<AutoStartedAppium> {
  const binary = opts.binary ?? "appium";
  const readyTimeout = opts.readyTimeout ?? 30_000;
  const log = opts.log ?? (() => {});

  const port = await findFreePort();
  const url = `http://127.0.0.1:${port}`;

  log(`[appium] starting on ${url}`);

  let child: ChildProcess;
  try {
    child = spawn(binary, ["--port", String(port), "--base-path", "/", ...(opts.extraArgs ?? [])], {
      stdio: ["ignore", "pipe", "pipe"],
      // Detach so we can kill the whole process group on teardown.
      detached: false,
    });
  } catch (e) {
    throw new Error(
      `Failed to spawn \`${binary}\`: ${e instanceof Error ? e.message : String(e)}. ` +
        `Install Appium globally (npm i -g appium) and its drivers, or point --appium-url at an existing server.`,
      { cause: e },
    );
  }

  child.stdout?.setEncoding("utf-8");
  child.stderr?.setEncoding("utf-8");
  child.stdout?.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) if (line) log(`[appium] ${line}`);
  });
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) if (line) log(`[appium] ${line}`);
  });

  // Fail fast if the child exits before we see readiness.
  let exitError: Error | null = null;
  child.once("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      exitError = new Error(`Appium server exited early with code ${code}`);
    } else if (signal) {
      exitError = new Error(`Appium server exited early with signal ${signal}`);
    }
  });

  child.once("error", (err) => {
    exitError = err;
  });

  try {
    const deadline = Date.now() + readyTimeout;
    while (Date.now() < deadline) {
      if (exitError) throw exitError;
      try {
        const res = await fetch(`${url}/status`, {
          signal: AbortSignal.timeout(500),
        });
        if (res.ok) {
          const body = (await res.json()) as { value?: { ready?: boolean } };
          if (body.value?.ready !== false) {
            log(`[appium] ready on ${url}`);
            break;
          }
        }
      } catch {
        /* server not up yet, keep polling */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (exitError) throw exitError;
    if (Date.now() >= deadline) {
      throw new Error(`Local Appium server did not become ready`);
    }
  } catch (e) {
    // Clean up the child before propagating.
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    if (e instanceof Error && /did not become ready/i.test(e.message)) {
      throw new Error(
        `Local Appium server at ${url} did not become ready within ${readyTimeout}ms. ` +
          `Check that \`${binary}\` is installed and that required drivers (xcuitest, uiautomator2) are installed.`,
        { cause: e },
      );
    }
    throw e;
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    log(`[appium] stopping ${url}`);
    child.kill("SIGTERM");
    // Wait up to 5s for graceful shutdown, then SIGKILL.
    const killDeadline = Date.now() + 5_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < killDeadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (child.exitCode === null && child.signalCode === null) {
      log(`[appium] forcing kill`);
      child.kill("SIGKILL");
    }
  };

  return { url, stop };
}
