-- Surface liquidity-pool deposits/withdrawals as LP-share transfers. The shares
-- have no symbol of their own, so each row carries the pool whose shares moved
-- (poolId = the emitting pool contract). A deposit mints shares to "toAddress"
-- (no from); a withdrawal burns shares from "fromAddress" (no to).
--
-- Ordered AFTER 20260829120000_add_network deliberately: that migration
-- back-filled `network` onto the tables that existed when it was written, and
-- this one did not, so it carries its own column from the start.
CREATE TABLE "wraith"."LpShareTransfer" (
    "id" SERIAL NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "poolId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromAddress" TEXT,
    "toAddress" TEXT,
    "shares" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "ledgerClosedAt" TIMESTAMP(3) NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LpShareTransfer_pkey" PRIMARY KEY ("id")
);

-- One row per event PER NETWORK; replaying an overlapping ledger range never
-- duplicates. Scoped by network for the same reason every other table is: a
-- global unique on eventId would let a testnet event suppress its mainnet
-- namesake, and skipDuplicates would swallow it without a trace.
CREATE UNIQUE INDEX "LpShareTransfer_network_eventId_key" ON "wraith"."LpShareTransfer"("network", "eventId");

CREATE INDEX "LpShareTransfer_network_poolId_idx" ON "wraith"."LpShareTransfer"("network", "poolId");
CREATE INDEX "LpShareTransfer_network_toAddress_idx" ON "wraith"."LpShareTransfer"("network", "toAddress");
CREATE INDEX "LpShareTransfer_network_fromAddress_idx" ON "wraith"."LpShareTransfer"("network", "fromAddress");
CREATE INDEX "LpShareTransfer_network_ledger_idx" ON "wraith"."LpShareTransfer"("network", "ledger");
CREATE INDEX "LpShareTransfer_network_txHash_idx" ON "wraith"."LpShareTransfer"("network", "txHash");
CREATE INDEX "LpShareTransfer_network_poolId_action_idx" ON "wraith"."LpShareTransfer"("network", "poolId", "action");
