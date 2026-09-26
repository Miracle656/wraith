-- Track contract liveness: one tombstone row per contract whose persistent
-- storage instance entry has expired (liveUntilLedger fell behind the current
-- ledger). Downstream consumers watch this table for a "contract gone" signal.
--
-- Ordered AFTER 20260829120000_add_network deliberately. That migration
-- back-filled a `network` column onto the tables that existed when it was
-- written; this table did not, so it carries its own from the start rather
-- than being silently left as the one network-blind table in the schema.
CREATE TABLE "wraith"."ContractTombstone" (
    "id" SERIAL NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "contractId" TEXT NOT NULL,
    "liveUntilLedger" INTEGER NOT NULL,
    "detectedLedger" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractTombstone_pkey" PRIMARY KEY ("id")
);

-- One tombstone per contract PER NETWORK; first expiry detection wins and
-- re-detection is a no-op. Scoping by network matters: the same contract id can
-- exist on both chains with different TTLs, and a global unique would let a
-- testnet expiry permanently suppress the mainnet tombstone.
CREATE UNIQUE INDEX "ContractTombstone_network_contractId_key" ON "wraith"."ContractTombstone"("network", "contractId");

CREATE INDEX "ContractTombstone_network_detectedLedger_idx" ON "wraith"."ContractTombstone"("network", "detectedLedger");
