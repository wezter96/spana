import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

type ReadyMatcher = RegExp | string;

function matchesReady(output: string, readyWhen: ReadyMatcher[]): boolean {
  return readyWhen.some((matcher) =>
    typeof matcher === "string" ? output.includes(matcher) : matcher.test(output),
  );
}

function normalizeRecord(value: unknown, fieldName: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error(`${fieldName} must be an object.`);
}

export function readOptionRecord(value: unknown, fieldName: string): Record<string, unknown> {
  return normalizeRecord(value, fieldName) ?? {};
}

export function hasConfig(value: unknown): boolean {
  const record = normalizeRecord(value, "config");
  return record !== undefined && Object.keys(record).length > 0;
}

export function parseAppiumCredentials(
  appiumUrl: string,
  label: string,
): { url: URL; username: string; password: string } {
  const url = new URL(appiumUrl);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);

  if (!username || !password) {
    throw new Error(`${label} helper features require credentials in execution.appium.serverUrl.`);
  }

  return { url, username, password };
}

export async function uploadMultipartJson(options: {
  url: string;
  auth: string;
  fileField: string;
  filePath: string;
  fileName?: string;
  fields?: Record<string, string>;
}): Promise<Record<string, unknown>> {
  const body = new FormData();
  const bytes = await readFile(options.filePath);
  body.set(options.fileField, new Blob([bytes]), options.fileName ?? basename(options.filePath));

  for (const [key, value] of Object.entries(options.fields ?? {})) {
    body.set(key, value);
  }

  const response = await fetch(options.url, {
    method: "POST",
    headers: {
      Authorization: options.auth,
    },
    body,
  });

  const text = await response.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Upload request returned invalid JSON: ${text}`);
  }

  if (!response.ok) {
    const message =
      (typeof json["message"] === "string" && json["message"]) ||
      (typeof json["error"] === "string" && json["error"]) ||
      text;
    throw new Error(`Upload request failed with ${response.status}: ${message}`);
  }

  return json;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const onExit = () => {
      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("close", onExit);
    };

    child.once("exit", onExit);
    child.once("close", onExit);
  });
}

export async function stopManagedProcess(child: ChildProcess, label: string): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  if (await waitForExit(child, 5_000)) {
    return;
  }

  child.kill("SIGKILL");
  if (!(await waitForExit(child, 1_000))) {
    throw new Error(`Timed out waiting for ${label} to stop.`);
  }
}

export async function startManagedProcess(options: {
  label: string;
  command: string;
  args: string[];
  readyWhen: ReadyMatcher[];
}): Promise<() => Promise<void>> {
  const child = spawn(options.command, options.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise<void>((resolve, reject) => {
    let output = "";

    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (matchesReady(output, options.readyWhen)) {
        cleanup();
        resolve();
      }
    };

    const onError = (error: Error) => {
      cleanup();
      reject(new Error(`Failed to start ${options.label}: ${error.message}`));
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      const suffix = output.trim() ? `\n${output.trim()}` : "";
      reject(
        new Error(
          `${options.label} exited before it became ready (code=${code ?? "null"}, signal=${signal ?? "null"}).${suffix}`,
        ),
      );
    };

    const timeout = setTimeout(() => {
      cleanup();
      void stopManagedProcess(child, options.label).catch(() => {});
      reject(new Error(`Timed out waiting for ${options.label} to become ready.`));
    }, 30_000);

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });

  return async () => {
    await stopManagedProcess(child, options.label);
  };
}
