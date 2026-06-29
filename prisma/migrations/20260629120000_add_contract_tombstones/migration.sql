-- Track contract liveness: one tombstone row per contract whose persistent
-- storage instance entry has expired (liveUntilLedger fell behind the current
-- ledger). Downstream consumers watch this table for a "contract gone" signal.
CREATE TABLE "wraith"."ContractTombstone" (
    "id" SERIAL NOT NULL,
    "contractId" TEXT NOT NULL,
    "liveUntilLedger" INTEGER NOT NULL,
    "detectedLedger" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractTombstone_pkey" PRIMARY KEY ("id")
);

-- One tombstone per contract; first expiry detection wins, re-detection is a no-op.
CREATE UNIQUE INDEX "ContractTombstone_contractId_key" ON "wraith"."ContractTombstone"("contractId");

CREATE INDEX "ContractTombstone_detectedLedger_idx" ON "wraith"."ContractTombstone"("detectedLedger");
