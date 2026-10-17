import { createShutdownHandler } from '../index';

type MockServer = {
  close: jest.Mock<(result: (err?: Error | void) => void) => void>
};

function makeServer(closeImpl: (resolve: () => void) => void): MockServer {
  const close = jest.fn((callback: (err?: Error | void) => void) => {
    closeImpl(() => callback());
  });
  return { close } as unknown as MockServer;
}

describe('shutdown handler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('drains in-flight requests by closing the server and waiting for close', async () => {
    const order: string[] = [];
    const server = makeServer((resolve) => {
      order.push('close-started');
      setTimeout(() => {
        order.push('close-done');
        resolve();
      }, 500);
    });
    const onShutdown = jest.fn();
    const handler = createShutdown({ server, onShutdown, timeoutMs: 5000 });

    const promise = handler();
    await Promise.resolve();
    expect(server.close).toHaveBeenCalled(1);
    expect(order).toEqual(['close-started']);

    jest.advanceTimersByTime(500);
    await promise;

    expect(order).toEqual(['close-started', 'close-done']);
    expect(onShutdown).toHaveBeenCalled(1);
  });

  it('bounds the drain with a timeout when a request is stuck', async () => {
    const server = makeServer(() => {
      // Never calls back — simulates a stuck in-flight request.
    });
    const onShutdown = jest.fn();
    const handler = createShutdown({ server, onShutdown, timeoutMs: 1000 });

    const promise = handler();
    await Promise.resolve();
    expect(server.close).toHaveBeenCalled(1);

    jest.advanceTimersByTime(999);
    expect(onShutdown).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await promise;

    expect(onShutdown).toHaveBeenCalled(1);
  });

  it('runs onShutdown even if server.close reports an error', async () => {
    const server = makeServer((resolve) => {
      resolve();
    });
    const onShutdown = jest.fn();
    const handler = createShutdown({ server, onShutdown, timeoutMs: 1000 });

    const promise = handler();
    await Promise.resolve();
    await promise;

    expect(onShutdown).toHaveBeenCalled(1);
  });
});
