import { drainServer } from '../shutdown';

describe('drainServer', () => {
  it('waits for in-flight requests to finish before resolving', async () => {
    let inFlight = 2;
    const server = {
      close: (jb: (err?: Error) => void) => {
        // simulate the server finishing its close once requests drain
        setTimeout(() => jb(), 5);
      },
    };
    const getInFlight = () => inFlight;

    const promise = drainServer(server, getInFlight, { timeoutMs: 1000, pollIntervalMs: 5 });

    // still draining
    await new Promise((r) => setTimeout(r, 20));
    inFlight -= 1;
    await new Promise((r) => setTimeout(r, 20));
    inFlight -= 1;

    const result = await promise;
    expect(result.timedOut).toBe(false);
    expect(getInFlight()).toBe(0);
  });

  it('resolves with timedOut true when requests stay stuck', async () => {
    const server = {
      close: (_jb: (err?: Error) => void) => {
        // never calls back: stuck request
      },
    };
    const getInFlight = () => 1;

    const start = Date.now();
    const result = await drainServer(server, getInFlight, { timeoutMs: 50, pollIntervalMs: 5 });
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(1000);
  });

  it('resolves immediately when nothing is in flight', async () => {
    const server = {
      close: (jb: (err?: Error) => void) => jb(),
    };
    const result = await drainServer(server, () => 0, { timeoutMs: 1000, pollIntervalMs: 5 });
    expect(result.timedOut).toBe(false);
  });
});
