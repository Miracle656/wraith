import type { Server } from "node:http";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Stop accepting new connections and wait for in-flight requests to finish.
 *
 * `server.close()` only invokes its callback once every connection has ended,
 * so a single stuck request would otherwise block shutdown indefinitely — and
 * on Render that turns a SIGTERM into a hard kill at the end of the grace
 * period, denying Prisma a clean disconnect. The timeout bounds the wait, and
 * once it fires the remaining connections are dropped rather than left to hold
 * the process open.
 */
export function drainServer(
  server: Server,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const rawTimeout = opts.timeoutMs ?? Number(process.env.SHUTDOWN_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout
      : DEFAULT_SHUTDOWN_TIMEOUT_MS;

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      // Grace period elapsed: stop waiting and drop whatever is still open so
      // shutdown cannot be held hostage by a request that never completes.
      server.closeAllConnections();
      finish();
    }, timeoutMs);

    server.close(() => finish());
  });
}
