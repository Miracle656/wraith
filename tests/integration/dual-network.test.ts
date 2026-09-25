/**
 * Dual-network correctness harness (#172).
 *
 * Proves two indexer loops writing to one database never cross-contaminate.
 * Every assertion below fails if the corresponding `network` scoping is
 * removed — the column defaults to 'testnet', so an untagged write compiles
 * and inserts under the wrong chain instead of erroring.
 *
 * Method: drive the REAL loop code (`_pollOnceForTesting` /
 * `_pollWindowForTesting`, which dispatch to `pollOnce` / `pollParallel`)
 * with two independently controlled stub event sources. No raw `db` upserts
 * are used to simulate loop writes.
 *
 * Requires live Postgres (CI `docker-compose.test.yml`, `wraith_test:55432`).
 * Skipped without DATABASE_URL so unit runs stay green.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { PrismaClient } from "@prisma/client";
import {
  prisma,
  getLastIndexedLedger,
  rollbackToLedger,
  pruneOldTransfers,
} from "../../src/db";
import {
  _createLoopForTesting,
  _pollOnceForTesting,
  _pollWindowForTesting,
  _resetIndexerLoops,
  type LoopState,
} from "../../src/indexer";
import type { SourceSwitcher } from "../../src/indexer/sources";
import type { ParallelFetchFn } from "../../src/indexer/parallel";
import { _resetRpcClients, type RawEvent } from "../../src/rpc";
import { _resetTokenCache } from "../../src/tokenCache";
import { _clearSacCache } from "../../src/indexer/sac-detect";
import { createApp } from "../../src/api";

const HAS_DB = !!process.env.DATABASE_URL;
process.env.DATABASE_URL ??=
  "postgresql://wraith:wraith@localhost:55432/wraith_test";
process.env.DIRECT_DATABASE_URL ??=
  "postgresql://wraith:wraith@localhost:55432/wraith_test";

const describeDual = HAS_DB ? describe : describe.skip;

// ─── Identifiers ─────────────────────────────────────────────────────────────
// Disjoint, identifiable contracts per chain; deliberately different ledger
// heights (mainnet far behind testnet is the real-world shape).
const CTEST_A = "CTEST_DUAL_TOKEN_A";
const CTEST_B = "CTEST_DUAL_TOKEN_B";
const CTEST_NFT = "CTEST_DUAL_NFT";
const CMAIN_A = "CMAIN_DUAL_TOKEN_A";
const CMAIN_B = "CMAIN_DUAL_TOKEN_B";
const CMAIN_NFT = "CMAIN_DUAL_NFT";
const TEST_CONTRACTS = [CTEST_A, CTEST_B, CTEST_NFT];
const MAIN_CONTRACTS = [CMAIN_A, CMAIN_B, CMAIN_NFT];

// Valid G… addresses (checksum-correct) so Address.fromString works.
const T_FROM = "GDWCO35QUYQLGO6P7OLW4BZWNMMGGUWNPLRVPLCBVG7YNVDZKUDIW4KN";
const T_TO = "GCXOO7OIJZ2HEOZODLOEISNVO6CBPK4PISRJCZYRFT37H7XGHDLB3C7O";
const SHARED = "GB3XEYLJORUC2ZDVMFWC23TFOR3W64TLFVZWQYLSMVSAAAAAAAAABFSX";

const COLLISION_EVENT = "dual-collision-001";
const OLD_DAYS = 60;
const oldDate = () => new Date(Date.now() - OLD_DAYS * 24 * 3600 * 1000);
const nowDate = () => new Date();

// ─── Event builders ──────────────────────────────────────────────────────────
function fungibleEvent(opts: {
  contractId: string;
  from: string | null;
  to: string | null;
  amount: string;
  ledger: number;
  eventId: string;
  closedAt?: Date;
}): RawEvent {
  const topics = [nativeToScVal("transfer", { type: "symbol" })];
  // decoder: transfer needs topics[1]=from, topics[2]=to; mint/burn variants
  // differ — always emit the full transfer shape for determinism.
  topics.push(Address.fromString(opts.from ?? T_FROM).toScVal());
  topics.push(Address.fromString(opts.to ?? T_TO).toScVal());
  return {
    id: opts.eventId,
    type: "contract",
    ledger: opts.ledger,
    ledgerClosedAt: (opts.closedAt ?? nowDate()).toISOString(),
    contractId: opts.contractId,
    txHash: `tx-${opts.eventId}`,
    topic: topics,
    value: nativeToScVal(BigInt(opts.amount), { type: "i128" }),
  };
}

function nftEvent(opts: {
  contractId: string;
  from: string;
  to: string;
  tokenId: bigint;
  ledger: number;
  eventId: string;
  closedAt?: Date;
}): RawEvent {
  return {
    id: opts.eventId,
    type: "contract",
    ledger: opts.ledger,
    ledgerClosedAt: (opts.closedAt ?? nowDate()).toISOString(),
    contractId: opts.contractId,
    txHash: `tx-${opts.eventId}`,
    topic: [
      nativeToScVal("transfer", { type: "symbol" }),
      Address.fromString(opts.from).toScVal(),
      Address.fromString(opts.to).toScVal(),
      nativeToScVal(opts.tokenId, { type: "u128" }),
    ],
    value: xdr.ScVal.scvVoid(),
  };
}

// ─── Fixture event sets ──────────────────────────────────────────────────────
const testnetEvents: RawEvent[] = [
  fungibleEvent({ contractId: CTEST_A, from: T_FROM, to: SHARED, amount: "1000", ledger: 8000, eventId: "dual-t-001" }),
  fungibleEvent({ contractId: CTEST_A, from: SHARED, to: T_TO, amount: "400", ledger: 8001, eventId: "dual-t-002" }),
  // Same eventId on both chains — @@unique([network, eventId]) must keep both.
  fungibleEvent({ contractId: CTEST_B, from: T_FROM, to: T_TO, amount: "777", ledger: 8002, eventId: COLLISION_EVENT }),
  nftEvent({ contractId: CTEST_NFT, from: T_FROM, to: SHARED, tokenId: 42n, ledger: 8003, eventId: "dual-t-nft-001" }),
  // Old row for prune isolation (survives rollback to 3000: 100 < 3000).
  fungibleEvent({ contractId: CTEST_A, from: T_FROM, to: T_TO, amount: "11", ledger: 100, eventId: "dual-t-old-001", closedAt: oldDate() }),
];

const mainnetEvents: RawEvent[] = [
  fungibleEvent({ contractId: CMAIN_A, from: T_FROM, to: SHARED, amount: "5000", ledger: 2000, eventId: "dual-m-001" }),
  fungibleEvent({ contractId: CMAIN_A, from: SHARED, to: T_TO, amount: "1000", ledger: 2001, eventId: "dual-m-002" }),
  fungibleEvent({ contractId: CMAIN_B, from: T_FROM, to: T_TO, amount: "888", ledger: 2002, eventId: COLLISION_EVENT }),
  nftEvent({ contractId: CMAIN_NFT, from: T_FROM, to: SHARED, tokenId: 42n, ledger: 2003, eventId: "dual-m-nft-001" }),
  // Above the testnet rollback target (3000) — proves rollback scoping.
  fungibleEvent({ contractId: CMAIN_A, from: T_FROM, to: T_TO, amount: "55", ledger: 5000, eventId: "dual-m-high-001" }),
  fungibleEvent({ contractId: CMAIN_A, from: T_FROM, to: T_TO, amount: "22", ledger: 101, eventId: "dual-m-old-001", closedAt: oldDate() }),
];

// ─── Stubs ───────────────────────────────────────────────────────────────────
function stubSwitcher(events: RawEvent[], tip: number): SourceSwitcher {
  return {
    getLatestLedger: async () => tip,
    fetchEvents: async (from, to, contractIds, limit) => {
      const filtered = events.filter(
        (e) =>
          e.ledger >= from &&
          e.ledger <= to &&
          (contractIds.length === 0 || contractIds.includes(e.contractId)),
      );
      const highest = filtered.length
        ? Math.max(...filtered.map((e) => e.ledger))
        : to;
      return { events: filtered.slice(0, limit ?? 10000), highestLedger: highest };
    },
    getActiveSourceName: async () => "stub",
  };
}

/** Stub for the parallel path: mirrors fetchEvents but honours partitions. */
function stubFetchFn(events: RawEvent[]): ParallelFetchFn {
  return async (startLedger, contractIds, limit) => {
    const filtered = events.filter(
      (e) =>
        e.ledger >= startLedger &&
        (contractIds.length === 0 || contractIds.includes(e.contractId)),
    );
    const latest = filtered.length
      ? Math.max(...filtered.map((e) => e.ledger))
      : startLedger;
    return { events: filtered.slice(0, limit ?? 10000), latestLedger: latest };
  };
}

async function cleanDualRows() {
  const eventIds = [...testnetEvents, ...mainnetEvents].map((e) => e.id);
  const extra = [
    "dual-t-par-001",
    "dual-t-par-002",
    "dual-m-par-001",
    "dual-m-par-002",
    "dual-m-extra-001",
  ];
  const contracts = [...TEST_CONTRACTS, ...MAIN_CONTRACTS];
  await prisma.hostFnLog.deleteMany({ where: { eventId: { in: [...eventIds, ...extra] } } });
  await prisma.tokenTransfer.deleteMany({ where: { eventId: { in: [...eventIds, ...extra] } } });
  await prisma.nftTransfer.deleteMany({ where: { eventId: { in: [...eventIds, ...extra] } } });
  await prisma.nftMetadata.deleteMany({ where: { contractId: { in: contracts } } });
  await prisma.accountSummary.deleteMany({ where: { contractId: { in: contracts } } });
  await prisma.lpShareTransfer.deleteMany({ where: { eventId: { in: [...eventIds, ...extra] } } });
  await prisma.tokenMetadata.deleteMany({ where: { contractId: { in: contracts } } });
}

describeDual("Dual-network correctness harness (#172)", () => {
  let testLoop: LoopState;
  let mainLoop: LoopState;
  let savedIndexerState: Array<{ network: string; lastIndexedLedger: number }> = [];

  beforeAll(async () => {
    // Fast-fail RPC so stray metadata/SAC lookups never hang on live network.
    process.env.SOROBAN_RPC_URL_TESTNET = "http://127.0.0.1:1";
    process.env.SOROBAN_RPC_URL_MAINNET = "http://127.0.0.1:1";
    _resetRpcClients();
    _resetIndexerLoops();
    _resetTokenCache();
    _clearSacCache();

    savedIndexerState = await prisma.indexerState.findMany();
    await cleanDualRows();
    await prisma.indexerState.deleteMany();

    // Seed token metadata so pollOnce hits DB, not RPC, for our contracts.
    for (const c of [CTEST_A, CTEST_B]) {
      await prisma.tokenMetadata.upsert({
        where: { network_contractId: { network: "testnet", contractId: c } },
        create: { network: "testnet", contractId: c, symbol: "TST", name: "Test", decimals: 7 },
        update: {},
      });
    }
    for (const c of [CMAIN_A, CMAIN_B]) {
      await prisma.tokenMetadata.upsert({
        where: { network_contractId: { network: "mainnet", contractId: c } },
        create: { network: "mainnet", contractId: c, symbol: "MNT", name: "Main", decimals: 7 },
        update: {},
      });
    }

    testLoop = _createLoopForTesting("testnet", {
      sacContractIds: [CTEST_A, CTEST_B],
      nftContractIds: [CTEST_NFT],
      sourceSwitcher: stubSwitcher(testnetEvents, 8005),
    });
    mainLoop = _createLoopForTesting("mainnet", {
      sacContractIds: [CMAIN_A, CMAIN_B],
      nftContractIds: [CMAIN_NFT],
      sourceSwitcher: stubSwitcher(mainnetEvents, 5005),
    });

    // Drive both loops to completion over fixed ranges (single-worker path).
    // Lower bounds include the old prune rows (ledgers 100/101).
    await _pollOnceForTesting(testLoop, 99, 8005);
    await _pollOnceForTesting(mainLoop, 100, 5005);
  }, 60_000);

  afterAll(async () => {
    await cleanDualRows();
    await prisma.indexerState.deleteMany();
    for (const row of savedIndexerState) {
      await prisma.indexerState.upsert({
        where: { network: row.network },
        create: row,
        update: { lastIndexedLedger: row.lastIndexedLedger },
      });
    }
    _resetIndexerLoops();
    _resetRpcClients();
    await prisma.$disconnect();
  });

  it("tags every row with its loop network across all five tables", async () => {
    for (const t of await prisma.tokenTransfer.findMany({ where: { eventId: { startsWith: "dual-" } } })) {
      if (t.contractId.startsWith("CTEST")) expect(t.network).toBe("testnet");
      else if (t.contractId.startsWith("CMAIN")) expect(t.network).toBe("mainnet");
      else throw new Error(`unexpected contract ${t.contractId}`);
    }
    for (const h of await prisma.hostFnLog.findMany({ where: { eventId: { startsWith: "dual-" } } })) {
      if (h.contractId.startsWith("CTEST")) expect(h.network).toBe("testnet");
      else if (h.contractId.startsWith("CMAIN")) expect(h.network).toBe("mainnet");
      else throw new Error(`unexpected contract ${h.contractId}`);
    }
    for (const n of await prisma.nftTransfer.findMany({ where: { eventId: { startsWith: "dual-" } } })) {
      if (n.contractId.startsWith("CTEST")) expect(n.network).toBe("testnet");
      else expect(n.network).toBe("mainnet");
    }
    const metas = await prisma.nftMetadata.findMany({
      where: { contractId: { in: [...TEST_CONTRACTS, ...MAIN_CONTRACTS] } },
    });
    expect(metas.length).toBeGreaterThanOrEqual(2);
    expect(metas.filter((r) => r.network === "testnet").length).toBeGreaterThanOrEqual(1);
    expect(metas.filter((r) => r.network === "mainnet").length).toBeGreaterThanOrEqual(1);
    for (const r of metas) {
      if (r.contractId.startsWith("CTEST")) expect(r.network).toBe("testnet");
      else if (r.contractId.startsWith("CMAIN")) expect(r.network).toBe("mainnet");
      else throw new Error(`unexpected contract ${r.contractId}`);
    }
    for (const s of await prisma.accountSummary.findMany({ where: { contractId: { in: [...TEST_CONTRACTS, ...MAIN_CONTRACTS] } } })) {
      if (s.contractId.startsWith("CTEST")) expect(s.network).toBe("testnet");
      else expect(s.network).toBe("mainnet");
    }

    // Row counts prove nothing was dropped or merged: 4 testnet fungible +
    // 1 NFT, 5 mainnet fungible + 1 NFT (collision counted on both sides).
    expect(await prisma.tokenTransfer.count({ where: { network: "testnet", contractId: { in: TEST_CONTRACTS } } })).toBe(4);
    expect(await prisma.tokenTransfer.count({ where: { network: "mainnet", contractId: { in: MAIN_CONTRACTS } } })).toBe(5);
    expect(await prisma.nftTransfer.count({ where: { network: "testnet", eventId: { startsWith: "dual-" } } })).toBe(1);
    expect(await prisma.nftTransfer.count({ where: { network: "mainnet", eventId: { startsWith: "dual-" } } })).toBe(1);
    // Host logs mirror every event (fungible + NFT).
    expect(await prisma.hostFnLog.count({ where: { network: "testnet", eventId: { startsWith: "dual-" } } })).toBe(5);
    expect(await prisma.hostFnLog.count({ where: { network: "mainnet", eventId: { startsWith: "dual-" } } })).toBe(6);
  });

  it("holds one cursor per network with differing values", async () => {
    const t = await getLastIndexedLedger("testnet");
    const m = await getLastIndexedLedger("mainnet");
    expect(t).toBe(8003);
    expect(m).toBe(5000);
    expect(t).not.toBe(m);
    const rows = await prisma.indexerState.findMany({ orderBy: { network: "asc" } });
    expect(rows.map((r) => r.network).sort()).toEqual(["mainnet", "testnet"]);
  });

  it("keeps the same eventId as two rows, one per network", async () => {
    const rows = await prisma.tokenTransfer.findMany({ where: { eventId: COLLISION_EVENT }, orderBy: { network: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.network).sort()).toEqual(["mainnet", "testnet"]);
    expect(rows[0].contractId).not.toBe(rows[1].contractId);
  });

  it("keeps AccountSummary independent per network for a shared address", async () => {
    const rows = await prisma.accountSummary.findMany({
      where: { address: SHARED, contractId: { in: [CTEST_A, CMAIN_A] } },
      orderBy: { network: "asc" },
    });
    expect(rows).toHaveLength(2);
    const t = rows.find((r) => r.network === "testnet")!;
    const m = rows.find((r) => r.network === "mainnet")!;
    // testnet: +1000 / -400; mainnet: +5000 / -1000 — neither includes the other.
    expect(t.totalReceived).toBe("1000");
    expect(t.totalSent).toBe("400");
    expect(m.totalReceived).toBe("5000");
    expect(m.totalSent).toBe("1000");
  });

  it("covers INGEST_WORKERS > 1 through the indexer dispatch without cross-tagging", async () => {
    const tPar: RawEvent[] = [
      fungibleEvent({ contractId: CTEST_A, from: T_FROM, to: T_TO, amount: "10", ledger: 8100, eventId: "dual-t-par-001" }),
      fungibleEvent({ contractId: CTEST_B, from: T_FROM, to: T_TO, amount: "20", ledger: 8101, eventId: "dual-t-par-002" }),
    ];
    const mPar: RawEvent[] = [
      fungibleEvent({ contractId: CMAIN_A, from: T_FROM, to: T_TO, amount: "30", ledger: 5100, eventId: "dual-m-par-001" }),
      fungibleEvent({ contractId: CMAIN_B, from: T_FROM, to: T_TO, amount: "40", ledger: 5101, eventId: "dual-m-par-002" }),
    ];
    await _pollWindowForTesting(testLoop, 8100, 8101, 4, stubFetchFn(tPar));
    await _pollWindowForTesting(mainLoop, 5100, 5101, 4, stubFetchFn(mPar));

    for (const id of ["dual-t-par-001", "dual-t-par-002"]) {
      const row = await prisma.tokenTransfer.findFirst({ where: { eventId: id } });
      expect(row?.network).toBe("testnet");
    }
    for (const id of ["dual-m-par-001", "dual-m-par-002"]) {
      const row = await prisma.tokenTransfer.findFirst({ where: { eventId: id } });
      expect(row?.network).toBe("mainnet");
    }
    expect(await getLastIndexedLedger("testnet")).toBe(8101);
    expect(await getLastIndexedLedger("mainnet")).toBe(5101);
  });

  it("leaves the killed loop untouched when the other advances", async () => {
    const tCursorBefore = await getLastIndexedLedger("testnet");
    const tCountBefore = await prisma.tokenTransfer.count({ where: { network: "testnet" } });
    const extra: RawEvent[] = [
      fungibleEvent({ contractId: CMAIN_A, from: T_FROM, to: T_TO, amount: "66", ledger: 5200, eventId: "dual-m-extra-001" }),
    ];
    mainLoop.sourceSwitcher = stubSwitcher([...mainnetEvents, ...extra], 5200);
    await _pollOnceForTesting(mainLoop, 5102, 5200);

    expect(await getLastIndexedLedger("testnet")).toBe(tCursorBefore);
    expect(await prisma.tokenTransfer.count({ where: { network: "testnet" } })).toBe(tCountBefore);
    expect(await getLastIndexedLedger("mainnet")).toBe(5200);
    expect(await prisma.tokenTransfer.findFirst({ where: { eventId: "dual-m-extra-001" } })).toMatchObject({ network: "mainnet" });
  });

  it("reports both networks with differing cursors on /status", async () => {
    const app = createApp();
    const res = await request(app).get("/status").expect(200);
    const nets = res.body.networks as Record<string, { lastIndexedLedger: number }>;
    expect(nets.testnet).toBeDefined();
    expect(nets.mainnet).toBeDefined();
    expect(nets.testnet.lastIndexedLedger).toBe(await getLastIndexedLedger("testnet"));
    expect(nets.mainnet.lastIndexedLedger).toBe(await getLastIndexedLedger("mainnet"));
    expect(nets.testnet.lastIndexedLedger).not.toBe(nets.mainnet.lastIndexedLedger);
  });

  it("rollbackToLedger on testnet deletes no mainnet rows", async () => {
    const mainBefore = {
      transfers: await prisma.tokenTransfer.count({ where: { network: "mainnet" } }),
      nft: await prisma.nftTransfer.count({ where: { network: "mainnet" } }),
      host: await prisma.hostFnLog.count({ where: { network: "mainnet" } }),
    };
    await rollbackToLedger(3000, "testnet");

    // Testnet high rows gone, low old row survives.
    expect(await prisma.tokenTransfer.findFirst({ where: { eventId: "dual-t-001" } })).toBeNull();
    expect(await prisma.tokenTransfer.findFirst({ where: { eventId: "dual-t-old-001" } })).not.toBeNull();
    // Mainnet untouched — including rows above 3000.
    expect(await prisma.tokenTransfer.count({ where: { network: "mainnet" } })).toBe(mainBefore.transfers);
    expect(await prisma.nftTransfer.count({ where: { network: "mainnet" } })).toBe(mainBefore.nft);
    expect(await prisma.hostFnLog.count({ where: { network: "mainnet" } })).toBe(mainBefore.host);
    expect(await prisma.tokenTransfer.findFirst({ where: { eventId: "dual-m-high-001" } })).not.toBeNull();
    expect(await getLastIndexedLedger("testnet")).toBe(3000);
  });

  it("pruneOldTransfers on testnet deletes no mainnet rows", async () => {
    const mainCountBefore = await prisma.tokenTransfer.count({ where: { network: "mainnet" } });
    const deleted = await pruneOldTransfers("testnet");
    expect(deleted).toBeGreaterThan(0);
    expect(await prisma.tokenTransfer.findFirst({ where: { eventId: "dual-t-old-001" } })).toBeNull();
    expect(await prisma.tokenTransfer.findFirst({ where: { eventId: "dual-m-old-001" } })).not.toBeNull();
    expect(await prisma.tokenTransfer.count({ where: { network: "mainnet" } })).toBe(mainCountBefore);
  });
});

// Local PrismaClient import keeps TS happy when DATABASE_URL is unset.
void PrismaClient;
