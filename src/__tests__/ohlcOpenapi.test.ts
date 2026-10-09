describe("OHLC OpenAPI opt-in", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OHLC_REFRESH_INTERVAL_MS;
    delete process.env.SKIP_INDEXER;
    process.env.NETWORKS = "testnet";
    process.env.STELLAR_NETWORK = "testnet";
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  function generatePaths(): Record<string, unknown> {
    let paths: Record<string, unknown> = {};
    jest.isolateModules(() => {
      paths = require("../openapi/build").buildOpenApiDocument().paths;
    });
    return paths;
  }

  it.each([undefined, "", "0", "-1", "1.5", "60000ms", "2147483648"])(
    "omits candles without a valid opt-in (%s)",
    (interval) => {
      if (interval !== undefined) process.env.OHLC_REFRESH_INTERVAL_MS = interval;

      const paths = generatePaths();

      expect(paths).not.toHaveProperty("/candles/{bucket}/{contractId}");
      expect(paths).not.toHaveProperty("/candles/refresh");
    },
  );

  it("documents only the read route when enabled", () => {
    process.env.OHLC_REFRESH_INTERVAL_MS = "60000";

    const paths = generatePaths();

    expect(paths["/candles/{bucket}/{contractId}"]).toHaveProperty("get");
    expect(paths).not.toHaveProperty("/candles/refresh");
  });

  it("omits candles when API-only mode disables the worker", () => {
    process.env.OHLC_REFRESH_INTERVAL_MS = "60000";
    process.env.SKIP_INDEXER = "true";

    expect(generatePaths()).not.toHaveProperty("/candles/{bucket}/{contractId}");
  });

  it.each(["testnet,mainnet", "mainnet"])(
    "omits candles for an incompatible network configuration (%s)",
    (networks) => {
      process.env.OHLC_REFRESH_INTERVAL_MS = "60000";
      process.env.NETWORKS = networks;

      expect(generatePaths()).not.toHaveProperty("/candles/{bucket}/{contractId}");
    },
  );
});
