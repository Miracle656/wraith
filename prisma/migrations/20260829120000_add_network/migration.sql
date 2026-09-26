-- Add a `network` dimension to every table so one database can hold both
-- testnet and mainnet without collisions (#159).
--
-- Existing rows are all testnet, so DEFAULT 'testnet' back-fills them
-- correctly rather than guessing.
--
-- NOTE ON IndexerState / BackfillCursor: `prisma migrate diff` generates
-- `ADD COLUMN "network" TEXT NOT NULL` for these two (no default, because the
-- new column is the primary key). That statement fails on a non-empty table —
-- Postgres cannot add a NOT NULL column with no default to existing rows. Both
-- are therefore hand-written below: add WITH a default, let the existing row
-- inherit it, then drop the default so future inserts must be explicit. This
-- preserves the indexer cursor; regenerating this migration with
-- `prisma migrate dev` would silently reintroduce the broken form and force a
-- full re-index from genesis.

-- ─── Drop old indexes (superseded by network-leading equivalents) ────────────
DROP INDEX "wraith"."TokenTransfer_eventId_key";
DROP INDEX "wraith"."TokenTransfer_toAddress_idx";
DROP INDEX "wraith"."TokenTransfer_fromAddress_idx";
DROP INDEX "wraith"."TokenTransfer_contractId_idx";
DROP INDEX "wraith"."TokenTransfer_ledger_idx";
DROP INDEX "wraith"."TokenTransfer_txHash_idx";
DROP INDEX "wraith"."TokenTransfer_toAddress_contractId_idx";
DROP INDEX "wraith"."TokenTransfer_fromAddress_contractId_idx";
DROP INDEX "wraith"."HostFnLog_eventId_key";
DROP INDEX "wraith"."HostFnLog_contractId_idx";
DROP INDEX "wraith"."HostFnLog_contractId_functionName_idx";
DROP INDEX "wraith"."HostFnLog_ledger_idx";
DROP INDEX "wraith"."HostFnLog_txHash_idx";
DROP INDEX "wraith"."NftTransfer_eventId_key";
DROP INDEX "wraith"."NftTransfer_contractId_idx";
DROP INDEX "wraith"."NftTransfer_tokenId_idx";
DROP INDEX "wraith"."NftTransfer_toAddress_idx";
DROP INDEX "wraith"."NftTransfer_fromAddress_idx";
DROP INDEX "wraith"."NftTransfer_contractId_tokenId_idx";
DROP INDEX "wraith"."NftMetadata_contractId_tokenId_key";
DROP INDEX "wraith"."AccountSummary_address_idx";
DROP INDEX "wraith"."AccountSummary_lastActivityAt_idx";
DROP INDEX "wraith"."AccountSummary_address_contractId_key";
DROP INDEX "wraith"."WebhookSubscription_active_idx";
DROP INDEX "wraith"."WebhookDelivery_eventId_idx";
DROP INDEX "wraith"."IndexerCheckpoint_batchId_key";

-- ─── Add the network column ──────────────────────────────────────────────────
ALTER TABLE "wraith"."TokenTransfer"       ADD COLUMN "network" TEXT NOT NULL DEFAULT 'testnet';
ALTER TABLE "wraith"."HostFnLog"           ADD COLUMN "network" TEXT NOT NULL DEFAULT 'testnet';
ALTER TABLE "wraith"."NftTransfer"         ADD COLUMN "network" TEXT NOT NULL DEFAULT 'testnet';
ALTER TABLE "wraith"."NftMetadata"         ADD COLUMN "network" TEXT NOT NULL DEFAULT 'testnet';
ALTER TABLE "wraith"."AccountSummary"      ADD COLUMN "network" TEXT NOT NULL DEFAULT 'testnet';
ALTER TABLE "wraith"."WebhookSubscription" ADD COLUMN "network" TEXT NOT NULL DEFAULT 'testnet';
ALTER TABLE "wraith"."WebhookDelivery"     ADD COLUMN "network" TEXT NOT NULL DEFAULT 'testnet';
ALTER TABLE "wraith"."IndexerCheckpoint"   ADD COLUMN "network" TEXT NOT NULL DEFAULT 'testnet';
ALTER TABLE "wraith"."RetentionJobRun"     ADD COLUMN "network" TEXT NOT NULL DEFAULT 'testnet';

-- ─── IndexerState: singleton (id = 1) → one row per network ──────────────────
-- Ordering matters: the column must exist and be populated before it can carry
-- a primary key, and `id` must go before the new key is added.
ALTER TABLE "wraith"."IndexerState" ADD COLUMN "network" TEXT NOT NULL DEFAULT 'testnet';
ALTER TABLE "wraith"."IndexerState" DROP CONSTRAINT "IndexerState_pkey";
ALTER TABLE "wraith"."IndexerState" DROP COLUMN "id";
ALTER TABLE "wraith"."IndexerState" ALTER COLUMN "network" DROP DEFAULT;
-- The table held at most one row (id defaulted to 1 and every caller wrote
-- `where: { id: 1 }`), so this cannot collide. If it somehow does, the
-- migration fails loudly here rather than silently discarding a cursor.
ALTER TABLE "wraith"."IndexerState" ADD CONSTRAINT "IndexerState_pkey" PRIMARY KEY ("network");

-- ─── BackfillCursor: same singleton → per-network conversion ─────────────────
ALTER TABLE "wraith"."BackfillCursor" ADD COLUMN "network" TEXT NOT NULL DEFAULT 'testnet';
ALTER TABLE "wraith"."BackfillCursor" DROP CONSTRAINT "BackfillCursor_pkey";
ALTER TABLE "wraith"."BackfillCursor" DROP COLUMN "id";
ALTER TABLE "wraith"."BackfillCursor" ALTER COLUMN "network" DROP DEFAULT;
ALTER TABLE "wraith"."BackfillCursor" ADD CONSTRAINT "BackfillCursor_pkey" PRIMARY KEY ("network");

-- ─── Recreate indexes with network leading ───────────────────────────────────
CREATE INDEX "TokenTransfer_network_toAddress_idx" ON "wraith"."TokenTransfer"("network", "toAddress");
CREATE INDEX "TokenTransfer_network_fromAddress_idx" ON "wraith"."TokenTransfer"("network", "fromAddress");
CREATE INDEX "TokenTransfer_network_contractId_idx" ON "wraith"."TokenTransfer"("network", "contractId");
CREATE INDEX "TokenTransfer_network_ledger_idx" ON "wraith"."TokenTransfer"("network", "ledger");
CREATE INDEX "TokenTransfer_network_txHash_idx" ON "wraith"."TokenTransfer"("network", "txHash");
CREATE INDEX "TokenTransfer_network_toAddress_contractId_idx" ON "wraith"."TokenTransfer"("network", "toAddress", "contractId");
CREATE INDEX "TokenTransfer_network_fromAddress_contractId_idx" ON "wraith"."TokenTransfer"("network", "fromAddress", "contractId");
CREATE UNIQUE INDEX "TokenTransfer_network_eventId_key" ON "wraith"."TokenTransfer"("network", "eventId");

CREATE INDEX "HostFnLog_network_contractId_idx" ON "wraith"."HostFnLog"("network", "contractId");
CREATE INDEX "HostFnLog_network_contractId_functionName_idx" ON "wraith"."HostFnLog"("network", "contractId", "functionName");
CREATE INDEX "HostFnLog_network_ledger_idx" ON "wraith"."HostFnLog"("network", "ledger");
CREATE INDEX "HostFnLog_network_txHash_idx" ON "wraith"."HostFnLog"("network", "txHash");
CREATE UNIQUE INDEX "HostFnLog_network_eventId_key" ON "wraith"."HostFnLog"("network", "eventId");

CREATE INDEX "NftTransfer_network_contractId_idx" ON "wraith"."NftTransfer"("network", "contractId");
CREATE INDEX "NftTransfer_network_tokenId_idx" ON "wraith"."NftTransfer"("network", "tokenId");
CREATE INDEX "NftTransfer_network_toAddress_idx" ON "wraith"."NftTransfer"("network", "toAddress");
CREATE INDEX "NftTransfer_network_fromAddress_idx" ON "wraith"."NftTransfer"("network", "fromAddress");
CREATE INDEX "NftTransfer_network_contractId_tokenId_idx" ON "wraith"."NftTransfer"("network", "contractId", "tokenId");
CREATE UNIQUE INDEX "NftTransfer_network_eventId_key" ON "wraith"."NftTransfer"("network", "eventId");

CREATE UNIQUE INDEX "NftMetadata_network_contractId_tokenId_key" ON "wraith"."NftMetadata"("network", "contractId", "tokenId");

CREATE INDEX "AccountSummary_network_address_idx" ON "wraith"."AccountSummary"("network", "address");
CREATE INDEX "AccountSummary_network_lastActivityAt_idx" ON "wraith"."AccountSummary"("network", "lastActivityAt");
CREATE UNIQUE INDEX "AccountSummary_network_address_contractId_key" ON "wraith"."AccountSummary"("network", "address", "contractId");

CREATE INDEX "WebhookSubscription_network_active_idx" ON "wraith"."WebhookSubscription"("network", "active");
CREATE INDEX "WebhookDelivery_network_eventId_idx" ON "wraith"."WebhookDelivery"("network", "eventId");

CREATE UNIQUE INDEX "IndexerCheckpoint_network_batchId_key" ON "wraith"."IndexerCheckpoint"("network", "batchId");
CREATE INDEX "RetentionJobRun_network_startedAt_idx" ON "wraith"."RetentionJobRun"("network", "startedAt");
