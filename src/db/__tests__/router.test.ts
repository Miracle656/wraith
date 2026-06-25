import { PrismaClient, Prisma } from "@prisma/client";
import { withReadReplicas } from "../router";

jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client");
  const mPrismaClient = jest.fn(() => ({
    $queryRaw: jest.fn(),
    $extends: jest.fn().mockImplementation((config) => config),
    user: { findMany: jest.fn(), count: jest.fn() }
  }));
  return { ...actual, PrismaClient: mPrismaClient };
});

describe("withReadReplicas router", () => {
  let primary: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    primary = new PrismaClient();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("returns primary directly if no replica URLs provided", () => {
    const router = withReadReplicas(primary, { replicaUrls: [] });
    expect(router).toBe(primary);
  });

  it("intercepts reads and routes them to a replica", async () => {
    const router: any = withReadReplicas(primary, { replicaUrls: ["replica1"] });
    const allOps = router.query.$allModels.$allOperations;
    const queryMock = jest.fn().mockResolvedValue("primary-result");
    
    // The second PrismaClient created is the replica
    const replicaClient = (PrismaClient as jest.Mock).mock.results[1].value;
    replicaClient.user.findMany.mockResolvedValue("replica-result");

    // Top-level client has $transaction
    jest.spyOn(Prisma, "getExtensionContext").mockReturnValue({ $transaction: jest.fn() } as any);

    const result = await allOps.call({}, {
      model: "user",
      operation: "findMany",
      args: { where: { id: 1 } },
      query: queryMock
    });

    expect(result).toBe("replica-result");
    expect(queryMock).not.toHaveBeenCalled();
    expect(replicaClient.user.findMany).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it("routes writes to the primary", async () => {
    const router: any = withReadReplicas(primary, { replicaUrls: ["replica1"] });
    const allOps = router.query.$allModels.$allOperations;
    const queryMock = jest.fn().mockResolvedValue("primary-write-result");
    
    const result = await allOps.call({}, {
      model: "user",
      operation: "create",
      args: { data: { name: "test" } },
      query: queryMock
    });

    expect(result).toBe("primary-write-result");
    expect(queryMock).toHaveBeenCalledWith({ data: { name: "test" } });
  });

  it("bypasses replicas when inside a transaction", async () => {
    const router: any = withReadReplicas(primary, { replicaUrls: ["replica1"] });
    const allOps = router.query.$allModels.$allOperations;
    const queryMock = jest.fn().mockResolvedValue("primary-tx-result");
    
    // Transaction client lacks $transaction method
    jest.spyOn(Prisma, "getExtensionContext").mockReturnValue({} as any); 
    
    const result = await allOps.call({}, {
      model: "user",
      operation: "findMany",
      args: {},
      query: queryMock
    });

    expect(result).toBe("primary-tx-result");
    expect(queryMock).toHaveBeenCalled();
  });

  it("round-robins across healthy replicas", async () => {
    const router: any = withReadReplicas(primary, { replicaUrls: ["rep1", "rep2"] });
    const allOps = router.query.$allModels.$allOperations;
    const queryMock = jest.fn();
    
    const rep1 = (PrismaClient as jest.Mock).mock.results[1].value;
    const rep2 = (PrismaClient as jest.Mock).mock.results[2].value;
    rep1.user.count.mockResolvedValue(1);
    rep2.user.count.mockResolvedValue(2);

    jest.spyOn(Prisma, "getExtensionContext").mockReturnValue({ $transaction: jest.fn() } as any);

    // 1st request -> rep1
    const res1 = await allOps.call({}, { model: "user", operation: "count", args: {}, query: queryMock });
    // 2nd request -> rep2
    const res2 = await allOps.call({}, { model: "user", operation: "count", args: {}, query: queryMock });
    // 3rd request -> rep1
    const res3 = await allOps.call({}, { model: "user", operation: "count", args: {}, query: queryMock });

    expect(res1).toBe(1);
    expect(res2).toBe(2);
    expect(res3).toBe(1);
  });

  it("marks replica unhealthy and falls back to primary on query failure", async () => {
    const router: any = withReadReplicas(primary, { replicaUrls: ["rep1"] });
    const allOps = router.query.$allModels.$allOperations;
    const queryMock = jest.fn().mockResolvedValue("primary-fallback");
    
    const rep1 = (PrismaClient as jest.Mock).mock.results[1].value;
    // Simulate replica query failing
    rep1.user.findMany.mockRejectedValue(new Error("Connection lost"));

    jest.spyOn(Prisma, "getExtensionContext").mockReturnValue({ $transaction: jest.fn() } as any);

    const result = await allOps.call({}, { model: "user", operation: "findMany", args: {}, query: queryMock });

    // Should catch the replica error and fallback to primary query
    expect(result).toBe("primary-fallback");
    expect(queryMock).toHaveBeenCalled();
  });

  it("marks replica unhealthy if background health check fails", async () => {
    const router: any = withReadReplicas(primary, { replicaUrls: ["rep1"], healthCheckIntervalMs: 1000 });
    const allOps = router.query.$allModels.$allOperations;
    const queryMock = jest.fn().mockResolvedValue("primary-fallback");
    
    const rep1 = (PrismaClient as jest.Mock).mock.results[1].value;
    rep1.$queryRaw.mockRejectedValueOnce(new Error("DB down"));

    // Advance timers so health check runs
    await jest.advanceTimersByTimeAsync(1000);

    jest.spyOn(Prisma, "getExtensionContext").mockReturnValue({ $transaction: jest.fn() } as any);

    // Next request should hit primary because rep1 is marked unhealthy
    const result = await allOps.call({}, { model: "user", operation: "findMany", args: {}, query: queryMock });
    expect(result).toBe("primary-fallback");
  });
});
