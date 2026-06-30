-- Surface liquidity-pool deposits/withdrawals as LP-share transfers. The shares
-- have no symbol of their own, so each row carries the pool whose shares moved
-- (poolId = the emitting pool contract). A deposit mints shares to "toAddress"
-- (no from); a withdrawal burns shares from "fromAddress" (no to).
CREATE TABLE "wraith"."LpShareTransfer" (
    "id" SERIAL NOT NULL,
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

-- One row per event; replaying an overlapping ledger range never duplicates.
CREATE UNIQUE INDEX "LpShareTransfer_eventId_key" ON "wraith"."LpShareTransfer"("eventId");

CREATE INDEX "LpShareTransfer_poolId_idx" ON "wraith"."LpShareTransfer"("poolId");
CREATE INDEX "LpShareTransfer_toAddress_idx" ON "wraith"."LpShareTransfer"("toAddress");
CREATE INDEX "LpShareTransfer_fromAddress_idx" ON "wraith"."LpShareTransfer"("fromAddress");
CREATE INDEX "LpShareTransfer_ledger_idx" ON "wraith"."LpShareTransfer"("ledger");
CREATE INDEX "LpShareTransfer_txHash_idx" ON "wraith"."LpShareTransfer"("txHash");
CREATE INDEX "LpShareTransfer_poolId_action_idx" ON "wraith"."LpShareTransfer"("poolId", "action");
