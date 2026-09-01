import { createServer, type Server } from "http";
import request from "supertest";
import WebSocket from "ws";
import { createApp } from "../api";
import { attachWebSocketServer, resolveSocketNetwork } from "../ws";
import { emitTransfer } from "../events";
import type { TransferRecord } from "../db";

jest.mock("../db", () => ({
  getAccountSummary: jest.fn().mockResolvedValue([]),
  getLastIndexedLedger: jest.fn().mockResolvedValue(1),
  getNftMetadata: jest.fn(),
  getNftOwner: jest.fn(),
  prisma: { $queryRaw: jest.fn() },
  queryAllTransfers: jest.fn().mockResolvedValue({ total: 0, transfers: [], nextCursor: null }),
  queryByTxHash: jest.fn().mockResolvedValue([]),
  queryNftTransfers: jest.fn().mockResolvedValue({ total: 0, transfers: [], nextCursor: null }),
  querySummary: jest.fn().mockResolvedValue([]),
  queryTransfers: jest.fn().mockResolvedValue({ total: 0, transfers: [], nextCursor: null }),
  toDisplayAmount: jest.requireActual("../db").toDisplayAmount,
}));

jest.mock("../rpc", () => ({ getLatestLedger: jest.fn().mockResolvedValue(1) }));

jest.mock("../indexer", () => ({
  getAllIndexerStats: jest.fn().mockReturnValue({}),
  runningNetworks: jest.fn().mockReturnValue([]),
  getIndexerStats: jest.fn().mockReturnValue({ uptimeSeconds: 0, totalIndexed: 0 }),
}));

import { queryTransfers, queryByTxHash } from "../db";

const mockQueryTransfers = queryTransfers as jest.MockedFunction<typeof queryTransfers>;
const mockQueryByTxHash = queryByTxHash as jest.MockedFunction<typeof queryByTxHash>;

const ALICE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const transfer = (overrides: Partial<TransferRecord> = {}): TransferRecord => ({
  contractId: "CTOKEN",
  eventType: "transfer",
  fromAddress: null,
  toAddress: ALICE,
  amount: "10000000",
  ledger: 100,
  ledgerClosedAt: new Date("2025-01-01T00:00:00Z"),
  txHash: "txhash",
  eventId: "ev-1",
  ...overrides,
});

const gql = (query: string, variables?: Record<string, unknown>) =>
  request(createApp())
    .post("/graphql")
    .set("Content-Type", "application/json")
    .send({ query, variables });

describe("GraphQL network selection (#163)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NETWORKS = "testnet,mainnet";
    process.env.STELLAR_NETWORK = "testnet";
    mockQueryTransfers.mockResolvedValue({ total: 0, transfers: [], nextCursor: null } as never);
    mockQueryByTxHash.mockResolvedValue([] as never);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("inherits the HTTP-level selector through the resolver context", async () => {
    await gql(`{ transfers(address: "${ALICE}", direction: INCOMING) { total } }`).query({
      network: "mainnet",
    });

    expect(mockQueryTransfers).toHaveBeenCalledWith(
      expect.objectContaining({ network: "mainnet" }),
    );
  });

  it("lets a field-level network argument override the request selector", async () => {
    // So one document can compare both chains in a single round-trip.
    await gql(`{ transfers(address: "${ALICE}", direction: INCOMING, network: MAINNET) { total } }`);

    expect(mockQueryTransfers).toHaveBeenCalledWith(
      expect.objectContaining({ network: "mainnet" }),
    );
  });

  it("applies the argument to transferByTx too", async () => {
    await gql(`{ transferByTx(txHash: "deadbeef", network: MAINNET) { eventId } }`);

    expect(mockQueryByTxHash).toHaveBeenCalledWith("deadbeef", "mainnet");
  });

  it("defaults to the configured network when nothing is specified", async () => {
    await gql(`{ transfers(address: "${ALICE}", direction: INCOMING) { total } }`);

    expect(mockQueryTransfers).toHaveBeenCalledWith(
      expect.objectContaining({ network: "testnet" }),
    );
  });

  it("errors on a network the deployment does not serve", async () => {
    process.env.NETWORKS = "testnet";

    const res = await gql(
      `{ transfers(address: "${ALICE}", direction: INCOMING, network: MAINNET) { total } }`,
    );

    expect(res.body.errors?.[0]?.message).toContain('Network "mainnet" is not enabled');
    expect(mockQueryTransfers).not.toHaveBeenCalled();
  });

  it("rejects a value that is not in the Network enum at the schema level", async () => {
    const res = await gql(`{ transfers(address: "${ALICE}", network: SOLANA) { total } }`);

    expect(res.body.errors?.[0]?.message).toMatch(/SOLANA/);
    expect(mockQueryTransfers).not.toHaveBeenCalled();
  });
});

describe("resolveSocketNetwork (#163)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NETWORKS = "testnet,mainnet";
    process.env.STELLAR_NETWORK = "testnet";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("defaults to the configured network with no query string", () => {
    expect(resolveSocketNetwork(`/subscribe/${ALICE}`)).toEqual({ network: "testnet" });
  });

  it("reads ?network= off the upgrade URL", () => {
    expect(resolveSocketNetwork(`/subscribe/${ALICE}?network=mainnet`)).toEqual({
      network: "mainnet",
    });
  });

  it("returns a close reason rather than a silent default for a bad value", () => {
    // A subscriber cannot be told after the fact — they would sit on a socket
    // that never delivers anything.
    const result = resolveSocketNetwork(`/subscribe/${ALICE}?network=mainet`);
    expect("error" in result && result.error).toContain('Invalid network: "mainet"');
  });

  it("returns a close reason for a network the deployment does not serve", () => {
    process.env.NETWORKS = "testnet";
    const result = resolveSocketNetwork(`/subscribe/${ALICE}?network=mainnet`);
    expect("error" in result && result.error).toContain("is not enabled");
  });
});

describe("WebSocket /subscribe network filter (#163)", () => {
  let server: Server;
  let url: string;
  const originalEnv = { ...process.env };

  beforeAll((done) => {
    process.env.NETWORKS = "testnet,mainnet";
    process.env.STELLAR_NETWORK = "testnet";
    server = createServer();
    attachWebSocketServer(server);
    server.listen(0, () => {
      const addr = server.address();
      url = `ws://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      done();
    });
  });

  afterAll((done) => {
    process.env = { ...originalEnv };
    server.close(() => done());
  });

  const connect = (path: string): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`${url}${path}`);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });

  it("delivers only the network the subscriber asked for", async () => {
    const ws = await connect(`/subscribe/${ALICE}?network=mainnet`);
    const received: string[] = [];
    ws.on("message", (data) => received.push(JSON.parse(data.toString()).eventId));

    // Both loops publish onto the same emitter in a dual-network process.
    emitTransfer(transfer({ eventId: "testnet-row" }), "testnet");
    emitTransfer(transfer({ eventId: "mainnet-row" }), "mainnet");
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual(["mainnet-row"]);
    ws.close();
  });

  it("defaults to the configured network when no selector is given", async () => {
    const ws = await connect(`/subscribe/${ALICE}`);
    const received: string[] = [];
    ws.on("message", (data) => received.push(JSON.parse(data.toString()).eventId));

    emitTransfer(transfer({ eventId: "testnet-row" }), "testnet");
    emitTransfer(transfer({ eventId: "mainnet-row" }), "mainnet");
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual(["testnet-row"]);
    ws.close();
  });

  it("closes the socket with a reason on an invalid selector", async () => {
    const ws = await connect(`/subscribe/${ALICE}?network=mainet`);
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    expect(closed.code).toBe(1008);
    expect(closed.reason).toContain('Invalid network: "mainet"');
  });
});
