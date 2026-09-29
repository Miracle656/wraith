const mockStopOhlcRefreshWorker = jest.fn();
const mockStartOhlcRefreshWorker = jest.fn(() => mockStopOhlcRefreshWorker);
const mockStartAllIndexers = jest.fn();
const mockDisconnect = jest.fn().mockResolvedValue(undefined);
const mockListen = jest.fn();

jest.mock("dotenv/config", () => ({}));
jest.mock("http", () => ({ createServer: () => ({ listen: mockListen }) }));
jest.mock("child_process", () => ({ execSync: jest.fn() }));
jest.mock("../api", () => ({ createApp: jest.fn() }));
jest.mock("../indexer", () => ({ startAllIndexers: mockStartAllIndexers }));
jest.mock("../db", () => ({ prisma: { $disconnect: mockDisconnect } }));
jest.mock("../ws", () => ({ attachWebSocketServer: jest.fn() }));
jest.mock("../graphql/subscriptions", () => ({
  attachGraphQLSubscriptions: jest.fn(),
  SUBSCRIPTIONS_PATH: "/graphql/subscriptions",
}));
jest.mock("../workers/webhooks", () => ({ startWebhookWorker: jest.fn() }));
jest.mock("../jobs/retention", () => ({ startPartitionRetentionJob: jest.fn() }));
jest.mock("../workers/ohlc-refresh", () => ({
  startOhlcRefreshWorker: mockStartOhlcRefreshWorker,
}));

describe("OHLC refresh startup wiring", () => {
  const originalEnv = { ...process.env };
  const signalHandlers = new Map<string | symbol, () => Promise<void>>();

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OHLC_REFRESH_INTERVAL_MS;
    delete process.env.SKIP_INDEXER;
    signalHandlers.clear();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(process, "exit").mockImplementation(() => undefined as never);
    jest.spyOn(process, "on").mockImplementation((event, listener) => {
      signalHandlers.set(event, listener as () => Promise<void>);
      return process;
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  function startService(): void {
    jest.isolateModules(() => {
      require("../index");
    });
  }

  it.each([undefined, "", "0", "-1", "1.5", "60000ms", "1e3", "0x10", "Infinity", "2147483648"])(
    "does not start the worker for a missing, disabled or invalid interval (%s)",
    (interval) => {
      if (interval !== undefined) process.env.OHLC_REFRESH_INTERVAL_MS = interval;

      startService();

      expect(mockStartOhlcRefreshWorker).not.toHaveBeenCalled();
      expect(mockStartAllIndexers).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["1", "60000", "2147483647", " 60000 "])(
    "starts one worker with a valid interval (%s)",
    (interval) => {
      process.env.OHLC_REFRESH_INTERVAL_MS = interval;

      startService();

      expect(mockStartOhlcRefreshWorker).toHaveBeenCalledTimes(1);
      expect(mockStartOhlcRefreshWorker).toHaveBeenCalledWith(Number(interval));
      expect(mockStartAllIndexers).toHaveBeenCalledTimes(1);
    },
  );

  it("skips OHLC refresh in API-only mode even with a valid interval", () => {
    process.env.OHLC_REFRESH_INTERVAL_MS = "60000";
    process.env.SKIP_INDEXER = "true";

    startService();

    expect(mockStartOhlcRefreshWorker).not.toHaveBeenCalled();
    expect(mockStartAllIndexers).not.toHaveBeenCalled();
    expect(mockListen).toHaveBeenCalledTimes(1);
  });

  it.each(["SIGINT", "SIGTERM"])("stops OHLC refresh before disconnecting on %s", async (signal) => {
    process.env.OHLC_REFRESH_INTERVAL_MS = "60000";
    startService();

    await signalHandlers.get(signal)!();

    expect(mockStopOhlcRefreshWorker).toHaveBeenCalledTimes(1);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mockStopOhlcRefreshWorker.mock.invocationCallOrder[0]).toBeLessThan(
      mockDisconnect.mock.invocationCallOrder[0],
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
