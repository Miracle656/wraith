import { createServer, type Server } from 'node:http';
import { drainServer } from '../shutdown';

const getPort = (server: Server): number => {
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('server address unavailable');
  }
  return addr.port;
};

describe('drainServer', () => {
  it('waits for in-flight requests to finish', async () => {
    let release: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });

    const server = createServer(async (_req, res) => {
      await inFlight;
      res.end('ok');
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = getPort(server);

    const req = fetch(`http://127.0.0.1:${port}/`);
    // Give the request a moment to reach the handler before draining.
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    const drain = drainServer(server, { timeoutMs: 2000 });
    release?.();

    const res = await req;
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(await res.text()).toBe('ok');
    await drain;
  });

  it('resolves after the timeout when a request is stuck', async () => {
    const server = createServer(async (_req, res) => {
      // Never respond; simulates a stuck in-flight request.
      void res;
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = getPort(server);

    // Kick off a request that will never complete.
    const req = fetch(`http://127.0.0.1:${port}/`).catch(() => undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    const start = Date.now();
    await drainServer(server, { timeoutMs: 100 });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(1000);
    await req;
  });
});
