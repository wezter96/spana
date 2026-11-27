import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";

export interface WebServerConfig {
  /** Shell command to boot the dev/preview server (e.g. `"bun run dev"` or `"npm start"`). */
  command: string;
  /** HTTP(S) URL to poll until a response is received (e.g. `"http://127.0.0.1:3000/health"`). */
  url?: string;
  /** TCP port to poll on localhost when `url` is omitted. */
  port?: number;
  /** Working directory for the spawned server process (defaults to `process.cwd()`). */
  cwd?: string;
  /** Extra environment variables merged into `process.env` (or standalone when `inheritEnv: false`). */
  env?: Record<string, string>;
  /** Whether to inherit host `process.env` (default: `true`). Set `false` for clean env isolation. */
  inheritEnv?: boolean;
  /** Host env variable names to forward when `inheritEnv: false` (default: `["PATH"]`). */
  inheritEnvKeys?: string[];
  /** Maximum ms to wait for the server to become ready (default: 60_000). */
  timeout?: number;
  /** If true (default when not in CI), skip spawning if `url`/`port` is already reachable. */
  reuseExistingServer?: boolean;
  /** Pipe server stdout (`"pipe"` captures silently, `"inherit"` streams to console). Default: `"pipe"`. */
  stdout?: "pipe" | "ignore" | "inherit";
  /** Pipe server stderr. Default: `"pipe"`. */
  stderr?: "pipe" | "ignore" | "inherit";
  /** Accept any HTTP status < 500 as ready instead of only 2xx-3xx (default: false). */
  ignoreHTTPSErrors?: boolean;
  /** Graceful shutdown timeout in ms before escalating to SIGKILL (default: 3_000). */
  gracefulShutdownMs?: number;
}

export interface RunningWebServer {
  config: WebServerConfig;
  url?: string;
  port?: number;
  reused: boolean;
  pid?: number;
  /** Stop the spawned server cleanly (no-op when reused). */
  stop(): Promise<void>;
}

export interface StartWebServersOptions {
  cwd?: string;
  /** Override `process.env.CI` detection for `reuseExistingServer`. */
  isCI?: boolean;
  /** Poll interval in ms (default: 150). */
  pollIntervalMs?: number;
}

export async function isTcpPortOpen(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 400,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function isHttpUrlReady(url: string, timeoutMs = 1_000): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

export async function checkServerReady(config: WebServerConfig): Promise<boolean> {
  if (config.url) {
    return isHttpUrlReady(config.url);
  }
  if (typeof config.port === "number" && config.port > 0) {
    return isTcpPortOpen(config.port);
  }
  return false;
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid || pid === process.pid) return;
  try {
    // Negative PID kills the detached process group on POSIX (sh + child dev server)
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
      return;
    }
  } catch {
    // Fall back to direct PID kill
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited
  }
}

async function stopChildProcess(child: ChildProcess, gracefulMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", finish);
    child.once("close", finish);
    killProcessTree(child, "SIGTERM");
    const timer = setTimeout(() => {
      killProcessTree(child, "SIGKILL");
      finish();
    }, gracefulMs);
    timer.unref?.();
  });
}

/**
 * Start a single configured dev server, waiting until `url` or `port` becomes reachable.
 * Respects `reuseExistingServer` (defaults to `!isCI`).
 */
export async function startWebServer(
  config: WebServerConfig,
  opts: StartWebServersOptions = {},
): Promise<RunningWebServer> {
  if (!config.command || config.command.trim().length === 0) {
    throw new Error("webServer.command must be a non-empty string.");
  }

  const isCI = opts.isCI ?? Boolean(process.env["CI"]);
  const reuse = config.reuseExistingServer ?? !isCI;
  const timeoutMs = config.timeout ?? 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 150;
  const gracefulShutdownMs = config.gracefulShutdownMs ?? 3_000;
  const targetUrl = config.url ?? (config.port ? `http://127.0.0.1:${config.port}` : undefined);

  if (reuse && (config.url || config.port)) {
    const alreadyUp = await checkServerReady(config);
    if (alreadyUp) {
      return {
        config,
        url: targetUrl,
        port: config.port,
        reused: true,
        stop: async () => {},
      };
    }
  }

  const outputTail: string[] = [];
  const pushOutput = (chunk: Buffer | string) => {
    const text = chunk.toString();
    outputTail.push(text);
    if (outputTail.length > 40) outputTail.shift();
  };

  const stdoutMode = config.stdout ?? "pipe";
  const stderrMode = config.stderr ?? "pipe";

  let spawnEnv: NodeJS.ProcessEnv;
  if (config.inheritEnv === false) {
    spawnEnv = {};
    for (const key of config.inheritEnvKeys ?? ["PATH"]) {
      if (process.env[key] !== undefined) {
        spawnEnv[key] = process.env[key];
      }
    }
    if (config.env) {
      Object.assign(spawnEnv, config.env);
    }
  } else {
    spawnEnv = { ...process.env, ...config.env };
  }

  const child = spawn(config.command, {
    cwd: config.cwd ?? opts.cwd ?? process.cwd(),
    env: spawnEnv,
    shell: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", stdoutMode, stderrMode],
  });

  if (stdoutMode === "pipe" && child.stdout) {
    child.stdout.on("data", pushOutput);
  }
  if (stderrMode === "pipe" && child.stderr) {
    child.stderr.on("data", pushOutput);
  }

  let exitedEarly: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let spawnError: Error | null = null;
  child.once("error", (err) => {
    spawnError = err;
  });
  child.once("exit", (code, signal) => {
    exitedEarly = { code, signal };
  });

  // If neither url nor port was specified, wait briefly to ensure the process didn't immediately crash.
  if (!config.url && !config.port) {
    await new Promise((r) => setTimeout(r, Math.min(300, timeoutMs)));
    if (spawnError) {
      throw new Error(`webServer failed to spawn "${config.command}": ${String(spawnError)}`);
    }
    if (exitedEarly !== null) {
      const info = exitedEarly as { code: number | null; signal: NodeJS.Signals | null };
      throw new Error(
        `webServer "${config.command}" exited immediately (code=${info.code}, signal=${info.signal}).\n${outputTail.join("")}`,
      );
    }
    return {
      config,
      reused: false,
      pid: child.pid,
      stop: () => stopChildProcess(child, gracefulShutdownMs),
    };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(`webServer failed to spawn "${config.command}": ${String(spawnError)}`);
    }
    if (exitedEarly !== null) {
      const info = exitedEarly as { code: number | null; signal: NodeJS.Signals | null };
      throw new Error(
        `webServer "${config.command}" exited before ${targetUrl} became ready (code=${info.code}, signal=${info.signal}).\n${outputTail.join("")}`,
      );
    }
    if (await checkServerReady(config)) {
      return {
        config,
        url: targetUrl,
        port: config.port,
        reused: false,
        pid: child.pid,
        stop: () => stopChildProcess(child, gracefulShutdownMs),
      };
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  await stopChildProcess(child, gracefulShutdownMs);
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for webServer "${config.command}" at ${targetUrl}.\n${outputTail.join("")}`,
  );
}

/**
 * Start one or more configured web servers in sequence, rolling back already-started
 * servers if a later one fails to become ready.
 */
export async function startWebServers(
  input: WebServerConfig | WebServerConfig[] | undefined,
  opts: StartWebServersOptions = {},
): Promise<{ servers: RunningWebServer[]; stopAll(): Promise<void> }> {
  if (!input) {
    return { servers: [], stopAll: async () => {} };
  }
  const configs = Array.isArray(input) ? input : [input];
  const started: RunningWebServer[] = [];

  try {
    for (const cfg of configs) {
      const handle = await startWebServer(cfg, opts);
      started.push(handle);
    }
  } catch (err) {
    for (const handle of started.toReversed()) {
      await handle.stop().catch(() => {});
    }
    throw err;
  }

  return {
    servers: started,
    stopAll: async () => {
      for (const handle of started.toReversed()) {
        await handle.stop().catch(() => {});
      }
    },
  };
}
