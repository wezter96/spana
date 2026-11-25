import { createServer, type AddressInfo } from "node:net";

const allocated = new Set<number>();
const counters = new Map<number, number>();

/** Allocate a port starting from a base, incrementing to avoid collisions */
export function allocatePort(base: number): number {
  const counter = counters.get(base) ?? 0;

  // Try from base up to base + counter, looking for a free one
  for (let i = 0; i <= counter; i++) {
    if (!allocated.has(base + i)) {
      allocated.add(base + i);
      return base + i;
    }
  }

  // All previous are taken, allocate next
  let port = base + counter;
  while (allocated.has(port)) {
    port++;
  }
  allocated.add(port);
  counters.set(base, port - base + 1);
  return port;
}

/** Probe the OS TCP stack to verify a port is genuinely bindable on `host`. */
export async function isPortAvailable(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/** Fail loudly if an explicitly requested port is already bound by another process. */
export async function assertPortAvailable(
  port: number,
  label = "daemon",
  host = "127.0.0.1",
): Promise<void> {
  const free = await isPortAvailable(port, host);
  if (!free) {
    throw new Error(
      `Port clash: ${host}:${port} is already in use (cannot start ${label}). ` +
        `Stop the conflicting process or let Spana auto-assign a free port.`,
    );
  }
}

/**
 * Allocate a genuinely free OS TCP port (safe across concurrent OS processes!),
 * starting near `preferredBase` and falling back to an OS ephemeral port (`0`).
 */
export async function allocateFreePort(
  preferredBase = 9322,
  maxAttempts = 128,
  host = "127.0.0.1",
): Promise<number> {
  for (let offset = 0; offset < maxAttempts; offset++) {
    const candidate = preferredBase + offset;
    if (allocated.has(candidate)) continue;
    if (await isPortAvailable(candidate, host)) {
      allocated.add(candidate);
      return candidate;
    }
  }

  // Fallback: ask the OS kernel for any free ephemeral port
  const ephemeral = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.once("listening", () => {
      const addr = server.address() as AddressInfo | null;
      const port = addr?.port ?? 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("OS failed to allocate an ephemeral TCP port"));
      });
    });
    server.listen(0, host);
  });
  allocated.add(ephemeral);
  return ephemeral;
}

/** Release a port back to the pool */
export function releasePort(port: number): void {
  allocated.delete(port);
}

/** Reset all state (for testing) */
export function resetAllocator(): void {
  allocated.clear();
  counters.clear();
}
