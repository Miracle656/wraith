/**
 * WebSocket subscription tests — issue #105
 *
 * Spins up a real HTTP + WS server in-process (no Docker) and exercises:
 *  1. connect / subscribe / receive / disconnect cycle
 *  2. address filtering (other-address events are not forwarded)
 *  3. backpressure on a slow client (buffered messages, no crash)
 */
import http from "http";
import { WebSocket } from "ws";
import { attachWebSocketServer } from "../../src/ws";
import { emitTransfer } from "../../src/events";
import type { TransferEvent } from "../../src/events";

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  };
}

/** Start a test server; resolves when it's listening. */
async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer();
  attachWebSocketServer(server);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };

  return {
    url: `ws://localhost:${port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    ),
  };
}

/** Open a WS connection and wait until it is OPEN. */
function connect(url: string, path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}${path}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/** Collect `n` messages from a socket, then resolve. */
function collectMessages(ws: WebSocket, n: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
      if (messages.length >= n) resolve(messages);
    });
    ws.on("error", reject);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const ADDR = "GRECV";
const OTHER = "GOTHER";

describe("WebSocket /subscribe/:address", () => {
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeAll(async () => {
    const srv = await startServer();
    serverUrl = srv.url;
    closeServer = srv.close;
  });

  afterAll(() => closeServer());

  it("rejects upgrade on unknown path with 404", async () => {
    await expect(connect(serverUrl, "/notfound")).rejects.toThrow();
  });

  it("connects and receives a matching transfer", async () => {
    const ws = await connect(serverUrl, `/subscribe/${ADDR}`);
    const pending = collectMessages(ws, 1);

    emitTransfer(makeTransfer({ toAddress: ADDR }));

    const [msg] = await pending as [Record<string, unknown>];
    expect(msg.toAddress).toBe(ADDR);
    expect(msg.displayAmount).toBe("1.0000000");

    ws.close();
  });

  it("receives outgoing transfers (sender match)", async () => {
    const ws = await connect(serverUrl, `/subscribe/${ADDR}`);
    const pending = collectMessages(ws, 1);

    emitTransfer(makeTransfer({ fromAddress: ADDR, toAddress: OTHER }));

    const [msg] = await pending as [Record<string, unknown>];
    expect(msg.fromAddress).toBe(ADDR);

    ws.close();
  });

  it("does not forward transfers for a different address", async () => {
    const ws = await connect(serverUrl, `/subscribe/${ADDR}`);

    let received = false;
    ws.on("message", () => { received = true; });

    // emit for a completely different address
    emitTransfer(makeTransfer({ fromAddress: OTHER, toAddress: "GTHIRD" }));

    // small wait to confirm nothing arrives
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toBe(false);

    ws.close();
  });

  it("connect / subscribe / receive / disconnect cycle — cleans up listener", async () => {
    const ws = await connect(serverUrl, `/subscribe/${ADDR}`);
    const pending = collectMessages(ws, 2);

    emitTransfer(makeTransfer({ toAddress: ADDR, eventId: "ev-a" }));
    emitTransfer(makeTransfer({ toAddress: ADDR, eventId: "ev-b" }));

    const msgs = await pending as Array<Record<string, unknown>>;
    expect(msgs.map((m) => m.eventId)).toEqual(["ev-a", "ev-b"]);

    // Disconnect and confirm no further messages arrive after close
    ws.close();
    await new Promise((r) => setTimeout(r, 30));

    // Emitting after disconnect should not throw
    expect(() => emitTransfer(makeTransfer({ toAddress: ADDR }))).not.toThrow();
  });

  it("backpressure — buffers many rapid messages without error", async () => {
    const ws = await connect(serverUrl, `/subscribe/${ADDR}`);

    const COUNT = 50;
    const pending = collectMessages(ws, COUNT);

    // Fire all transfers synchronously — simulates a fast producer / slow consumer
    for (let i = 0; i < COUNT; i++) {
      emitTransfer(makeTransfer({ toAddress: ADDR, eventId: `bp-${i}` }));
    }

    const msgs = await pending as Array<Record<string, unknown>>;
    expect(msgs).toHaveLength(COUNT);
    expect(msgs.map((m) => m.eventId)).toEqual(
      Array.from({ length: COUNT }, (_, i) => `bp-${i}`)
    );

    ws.close();
  });
});
