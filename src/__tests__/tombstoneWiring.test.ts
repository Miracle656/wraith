/**
 * The tombstone detector is wired into the indexer loop (#137).
 *
 * These exist because the original failure here was invisible: the detection
 * logic was complete, correct and thoroughly unit-tested, and nothing ever
 * called it. A detector that never runs is indistinguishable from a chain on
 * which nothing has expired — the table simply stays empty forever and no test
 * goes red. So these assert the *call*, not the arithmetic.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const tombstoneExpiredContracts = jest.fn<
  (...args: unknown[]) => Promise<{ tombstones: unknown[]; inserted: number }>
>();

jest.mock("../indexer/tombstones", () => ({ tombstoneExpiredContracts }));

import { maybeTombstoneExpiredContracts } from "../indexer";

const CURRENT_LEDGER = 5_000_000;

/** Minimal LoopState stand-in — only the fields the helper reads. */
function loopState(overrides: Record<string, unknown> = {}) {
  return {
    network: "testnet",
    allContractIds: ["CAAA", "CBBB"],
    tombstoneCycleCount: 0,
    ...overrides,
  } as never;
}

/** The cadence the helper is compiled with (TOMBSTONE_CHECK_EVERY_CYCLES). */
const EVERY = parseInt(process.env.TOMBSTONE_CHECK_EVERY_CYCLES ?? "100", 10);

describe("maybeTombstoneExpiredContracts", () => {
  beforeEach(() => {
    tombstoneExpiredContracts.mockReset();
    tombstoneExpiredContracts.mockResolvedValue({ tombstones: [], inserted: 0 });
  });

  it("does not check on every poll — that would cost one RPC per contract per cycle", async () => {
    const loop = loopState();

    const ran = await maybeTombstoneExpiredContracts(loop, CURRENT_LEDGER);

    expect(ran).toBe(false);
    expect(tombstoneExpiredContracts).not.toHaveBeenCalled();
  });

  it("checks once the cadence is reached, and passes the watched contracts", async () => {
    const loop = loopState({ tombstoneCycleCount: EVERY - 1 });

    const ran = await maybeTombstoneExpiredContracts(loop, CURRENT_LEDGER);

    expect(ran).toBe(true);
    expect(tombstoneExpiredContracts).toHaveBeenCalledTimes(1);
    const [contractIds, ledger] = tombstoneExpiredContracts.mock.calls[0];
    expect(contractIds).toEqual(["CAAA", "CBBB"]);
    expect(ledger).toBe(CURRENT_LEDGER);
  });

  it("passes the loop's own network, so each loop asks its own chain", async () => {
    const loop = loopState({ network: "mainnet", tombstoneCycleCount: EVERY - 1 });

    await maybeTombstoneExpiredContracts(loop, CURRENT_LEDGER);

    expect(tombstoneExpiredContracts.mock.calls[0][3]).toBe("mainnet");
  });

  it("resets its counter so the check recurs rather than firing once forever", async () => {
    const loop = loopState({ tombstoneCycleCount: EVERY - 1 }) as unknown as {
      tombstoneCycleCount: number;
    };

    await maybeTombstoneExpiredContracts(loop as never, CURRENT_LEDGER);
    expect(loop.tombstoneCycleCount).toBe(0);

    await maybeTombstoneExpiredContracts(loop as never, CURRENT_LEDGER);
    expect(tombstoneExpiredContracts).toHaveBeenCalledTimes(1);
  });

  it("skips the RPC round-trip entirely when nothing is being watched", async () => {
    const loop = loopState({ allContractIds: [], tombstoneCycleCount: EVERY - 1 });

    const ran = await maybeTombstoneExpiredContracts(loop, CURRENT_LEDGER);

    expect(ran).toBe(false);
    expect(tombstoneExpiredContracts).not.toHaveBeenCalled();
  });

  it("swallows a failed check rather than stalling the indexer", async () => {
    // A missed liveness check is retried on the next cadence. A loop that dies
    // on an RPC hiccup is not self-healing, and stops indexing entirely.
    tombstoneExpiredContracts.mockRejectedValue(new Error("rpc down"));
    const loop = loopState({ tombstoneCycleCount: EVERY - 1 });

    await expect(
      maybeTombstoneExpiredContracts(loop, CURRENT_LEDGER),
    ).resolves.toBe(true);
  });
});
