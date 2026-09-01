/**
 * GraphQL subscription tests — issue #99
 *
 * Spins up a real HTTP + WS server in-process (no Docker) and exercises:
 *  1. connect / subscribe / receive / unsubscribe cycle for transferAdded
 *  2. contractId filter on transferAdded
 *  3. hostFnLogAdded delivers newly-logged host-fn invocations
 *  4. slow consumer doesn't crash the server (bounded queue)
 */
import http from "http";
import { WebSocket } from "ws";
import { attachGraphQLSubscriptions, SUBSCRIPTIONS_PATH } from "../subscriptions";
import { emitTransfer, emitHostFnLog } from "../../events";
import type { TransferEvent, HostFnLogEvent } from "../../events";

jest.mock("../../db", () => ({
  queryAllTransfers: jest.fn().mockResolvedValue({ total: 0, transfers: [], nextCursor: null }),
  queryByTxHash: jest.fn().mockResolvedValue([]),
  querySummary: jest.fn().mockResolvedValue([]),
  queryTransfers: jest.fn().mockResolvedValue({ total: 0, transfers: [], nextCursor: null }),
}));

function makeTransfer(overrides: Partial<TransferEvent> = {}): TransferEvent {
  return {
    contractId: "CTOKEN",
    eventType: "transfer",
    fromAddress: "GSENDER",
    toAddress: "GRECV",
    amount: "10000000",
    ledger: 100,
    ledgerClosedAt: new Date("2025-01-01T00:00:00Z"),
    txHash: "txhash",
    eventId: "ev-1",
    ...overrides,
  } as TransferEvent;
}

function makeHostFnLog(overrides: Partial<HostFnLogEvent> = {}): HostFnLogEvent {
  return {
    contractId: "CTOKEN",
    functionName: "swap",
    args: ["a", "b"],
    result: { ok: true },
    gasUsed: null,
    ledger: 100,
    ledgerClosedAt: new Date("2025-01-01T00:00:00Z"),
    txHash: "txhash",
    eventId: "hfl-1",
    network: "testnet",
    ...overrides,
  };
}

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer();
  attachGraphQLSubscriptions(server);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };

  return {
    url: `ws://localhost:${port}${SUBSCRIPTIONS_PATH}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

// Tracked so afterAll can force-close any socket a failed assertion left
// open — otherwise http.Server#close() hangs waiting for it and blows the
// hook timeout instead of reporting the real test failure.
const openSockets: WebSocket[] = [];

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    openSockets.push(ws);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function subscribeOp(
  ws: WebSocket,
  id: string,
  query: string,
  variables?: Record<string, unknown>
): void {
  ws.send(JSON.stringify({ id, type: "subscribe", payload: { query, variables } }));
}

function collectNext(ws: WebSocket, id: string, n: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const results: Record<string, unknown>[] = [];
    const handler = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.id !== id) return;
      if (msg.type === "next") {
        results.push(msg.payload.data);
        if (results.length >= n) {
          ws.off("message", handler);
          resolve(results);
        }
      } else if (msg.type === "error") {
        ws.off("message", handler);
        reject(new Error(JSON.stringify(msg.payload)));
      }
    };
    ws.on("message", handler);
  });
}

describe("GraphQL subscriptions /graphql/subscriptions", () => {
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeAll(async () => {
    const srv = await startServer();
    serverUrl = srv.url;
    closeServer = srv.close;
  });

  afterAll(async () => {
    for (const ws of openSockets.splice(0)) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
    }
    await closeServer();
  });

  it("rejects upgrade on an unknown /graphql sub-path with 404", async () => {
    const other = serverUrl.replace(SUBSCRIPTIONS_PATH, "/graphql/nope");
    await expect(connect(other)).rejects.toThrow();
  });

  it("streams a new transfer to a transferAdded subscriber", async () => {
    const ws = await connect(serverUrl);
    subscribeOp(ws, "1", "subscription { transferAdded { contractId eventId displayAmount } }");

    // Give the server a tick to register the subscription's async iterator
    // before emitting, mirroring the existing WS subscription test.
    await new Promise((r) => setTimeout(r, 20));

    const pending = collectNext(ws, "1", 1);
    emitTransfer(makeTransfer({ eventId: "ev-a" }), "testnet");

    const [msg] = await pending;
    const transfer = msg.transferAdded as Record<string, unknown>;
    expect(transfer.eventId).toBe("ev-a");
    expect(transfer.displayAmount).toBe("1.0000000");

    ws.close();
  });

  it("filters transferAdded by contractId", async () => {
    const ws = await connect(serverUrl);
    subscribeOp(
      ws,
      "2",
      "subscription($contractId: String) { transferAdded(contractId: $contractId) { contractId eventId } }",
      { contractId: "CWANTED" }
    );
    await new Promise((r) => setTimeout(r, 20));

    const pending = collectNext(ws, "2", 1);

    emitTransfer(makeTransfer({ contractId: "COTHER", eventId: "ev-skip" }), "testnet");
    emitTransfer(makeTransfer({ contractId: "CWANTED", eventId: "ev-match" }), "testnet");

    const [msg] = await pending;
    expect((msg.transferAdded as Record<string, unknown>).eventId).toBe("ev-match");

    ws.close();
  });

  it("streams hostFnLogAdded events", async () => {
    const ws = await connect(serverUrl);
    subscribeOp(ws, "3", "subscription { hostFnLogAdded { contractId functionName eventId } }");
    await new Promise((r) => setTimeout(r, 20));

    const pending = collectNext(ws, "3", 1);
    emitHostFnLog(makeHostFnLog({ eventId: "hfl-a" }), "testnet");

    const [msg] = await pending;
    expect((msg.hostFnLogAdded as Record<string, unknown>).eventId).toBe("hfl-a");
    expect((msg.hostFnLogAdded as Record<string, unknown>).functionName).toBe("swap");

    ws.close();
  });

  it("stops delivering after the client sends complete", async () => {
    const ws = await connect(serverUrl);
    subscribeOp(ws, "4", "subscription { transferAdded { eventId } }");
    await new Promise((r) => setTimeout(r, 20));

    let received = 0;
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === "4" && msg.type === "next") received++;
    });

    ws.send(JSON.stringify({ id: "4", type: "complete" }));
    await new Promise((r) => setTimeout(r, 20));

    emitTransfer(makeTransfer({ eventId: "ev-after-complete" }), "testnet");
    await new Promise((r) => setTimeout(r, 30));

    expect(received).toBe(0);
    ws.close();
  });

  it("backpressure — buffers many rapid transfers without crashing the server", async () => {
    const ws = await connect(serverUrl);
    subscribeOp(ws, "5", "subscription { transferAdded { eventId } }");
    await new Promise((r) => setTimeout(r, 20));

    const COUNT = 50;
    const pending = collectNext(ws, "5", COUNT);

    for (let i = 0; i < COUNT; i++) {
      emitTransfer(makeTransfer({ eventId: `bp-${i}` }), "testnet");
    }

    const msgs = await pending;
    expect(msgs).toHaveLength(COUNT);

    ws.close();
  });
});
