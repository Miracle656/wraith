-- Cache token symbol / name / decimals so the indexer does not re-query the
-- same contract's metadata on every transfer it sees.
--
-- Keyed on (network, contractId), not contractId alone: a contract id is only
-- unique within a chain, so a testnet token deployed at the same address as a
-- mainnet one would otherwise share a row — serving the wrong symbol and, more
-- damagingly, the wrong `decimals`, which silently rescales every amount
-- rendered from it.
--
-- Ordered after 20260829120000_add_network, which back-filled `network` onto
-- the tables that existed when it was written; this was not one of them.
CREATE TABLE "wraith"."TokenMetadata" (
    "network" TEXT NOT NULL DEFAULT 'testnet',
    "contractId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenMetadata_pkey" PRIMARY KEY ("network", "contractId")
);
