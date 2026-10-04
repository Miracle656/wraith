-- ─────────────────────────────────────────────────────────────────────────────
-- Baseline migration: establishes the "wraith" schema and every table that
-- pre-dates the network dimension (20260829120000_add_network).
--
-- WHY THIS EXISTS
-- ───────────────
-- The migration history was missing an initial migration. The first committed
-- migration (20250101000000_add_backfill_cursor) opens with
--
--   CREATE TABLE "wraith"."BackfillCursor" …
--
-- which fails on an empty database because the schema does not exist yet, and
-- the second migration (20260829120000_add_network) opens with DROP INDEX
-- statements on tables that no migration had ever created.
--
-- This migration is the prerequisite for every migration that follows.  It
-- reproduces the schema state that `prisma db push` produced before the repo
-- adopted `migrate deploy` — i.e. all tables in their *pre-network* form,
-- exactly as the later migrations expect to find them.
--
-- Tables created AFTER add_network (ContractTombstone, LpShareTransfer,
-- TokenMetadata, OfframpOrder) are NOT created here — they have their own
-- dedicated migration files that already run on a fresh DB without issue.
-- ─────────────────────────────────────────────────────────────────────────────

-- Schema (required before any "wraith".<table> reference).
CREATE SCHEMA IF NOT EXISTS "wraith";

-- ─── IndexerState ─────────────────────────────────────────────────────────────
-- Pre-network form: singleton row keyed by id = 1.
-- 20260829120000_add_network converts this to a per-network primary key.
CREATE TABLE "wraith"."IndexerState" (
    "id"                INTEGER NOT NULL DEFAULT 1,
    "lastIndexedLedger" INTEGER NOT NULL,
    "updatedAt"         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndexerState_pkey" PRIMARY KEY ("id")
);

-- ─── TokenTransfer ────────────────────────────────────────────────────────────
CREATE TABLE "wraith"."TokenTransfer" (
    "id"             SERIAL NOT NULL,
    "contractId"     TEXT NOT NULL,
    "eventType"      TEXT NOT NULL,
    "fromAddress"    TEXT,
    "toAddress"      TEXT,
    "amount"         TEXT NOT NULL,
    "ledger"         INTEGER NOT NULL,
    "ledgerClosedAt" TIMESTAMP(3) NOT NULL,
    "txHash"         TEXT NOT NULL,
    "eventId"        TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenTransfer_pkey" PRIMARY KEY ("id")
);

-- Old (pre-network) unique / indexes — dropped and replaced by add_network.
CREATE UNIQUE INDEX "TokenTransfer_eventId_key"            ON "wraith"."TokenTransfer"("eventId");
CREATE INDEX        "TokenTransfer_toAddress_idx"          ON "wraith"."TokenTransfer"("toAddress");
CREATE INDEX        "TokenTransfer_fromAddress_idx"        ON "wraith"."TokenTransfer"("fromAddress");
CREATE INDEX        "TokenTransfer_contractId_idx"         ON "wraith"."TokenTransfer"("contractId");
CREATE INDEX        "TokenTransfer_ledger_idx"             ON "wraith"."TokenTransfer"("ledger");
CREATE INDEX        "TokenTransfer_txHash_idx"             ON "wraith"."TokenTransfer"("txHash");
CREATE INDEX        "TokenTransfer_toAddress_contractId_idx"   ON "wraith"."TokenTransfer"("toAddress", "contractId");
CREATE INDEX        "TokenTransfer_fromAddress_contractId_idx" ON "wraith"."TokenTransfer"("fromAddress", "contractId");

-- ─── HostFnLog ────────────────────────────────────────────────────────────────
CREATE TABLE "wraith"."HostFnLog" (
    "id"             SERIAL NOT NULL,
    "contractId"     TEXT NOT NULL,
    "functionName"   TEXT NOT NULL,
    "args"           JSONB NOT NULL,
    "result"         JSONB,
    "gasUsed"        BIGINT,
    "ledger"         INTEGER NOT NULL,
    "ledgerClosedAt" TIMESTAMP(3) NOT NULL,
    "txHash"         TEXT NOT NULL,
    "eventId"        TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HostFnLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HostFnLog_eventId_key"                    ON "wraith"."HostFnLog"("eventId");
CREATE INDEX        "HostFnLog_contractId_idx"                 ON "wraith"."HostFnLog"("contractId");
CREATE INDEX        "HostFnLog_contractId_functionName_idx"    ON "wraith"."HostFnLog"("contractId", "functionName");
CREATE INDEX        "HostFnLog_ledger_idx"                     ON "wraith"."HostFnLog"("ledger");
CREATE INDEX        "HostFnLog_txHash_idx"                     ON "wraith"."HostFnLog"("txHash");

-- ─── NftTransfer ─────────────────────────────────────────────────────────────
CREATE TABLE "wraith"."NftTransfer" (
    "id"             SERIAL NOT NULL,
    "contractId"     TEXT NOT NULL,
    "tokenId"        TEXT NOT NULL,
    "fromAddress"    TEXT,
    "toAddress"      TEXT,
    "ledger"         INTEGER NOT NULL,
    "ledgerClosedAt" TIMESTAMP(3) NOT NULL,
    "txHash"         TEXT NOT NULL,
    "eventId"        TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NftTransfer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NftTransfer_eventId_key"                  ON "wraith"."NftTransfer"("eventId");
CREATE INDEX        "NftTransfer_contractId_idx"               ON "wraith"."NftTransfer"("contractId");
CREATE INDEX        "NftTransfer_tokenId_idx"                  ON "wraith"."NftTransfer"("tokenId");
CREATE INDEX        "NftTransfer_toAddress_idx"                ON "wraith"."NftTransfer"("toAddress");
CREATE INDEX        "NftTransfer_fromAddress_idx"              ON "wraith"."NftTransfer"("fromAddress");
CREATE INDEX        "NftTransfer_contractId_tokenId_idx"       ON "wraith"."NftTransfer"("contractId", "tokenId");

-- ─── NftMetadata ──────────────────────────────────────────────────────────────
CREATE TABLE "wraith"."NftMetadata" (
    "id"         SERIAL NOT NULL,
    "contractId" TEXT NOT NULL,
    "tokenId"    TEXT NOT NULL,
    "name"       TEXT,
    "tokenUri"   TEXT,
    "fetchedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NftMetadata_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NftMetadata_contractId_tokenId_key"       ON "wraith"."NftMetadata"("contractId", "tokenId");

-- ─── AccountSummary ───────────────────────────────────────────────────────────
CREATE TABLE "wraith"."AccountSummary" (
    "id"             SERIAL NOT NULL,
    "address"        TEXT NOT NULL,
    "contractId"     TEXT NOT NULL,
    "totalSent"      TEXT NOT NULL DEFAULT '0',
    "totalReceived"  TEXT NOT NULL DEFAULT '0',
    "net"            TEXT NOT NULL DEFAULT '0',
    "txCount"        INTEGER NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3) NOT NULL,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountSummary_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountSummary_address_contractId_key"    ON "wraith"."AccountSummary"("address", "contractId");
CREATE INDEX        "AccountSummary_address_idx"               ON "wraith"."AccountSummary"("address");
CREATE INDEX        "AccountSummary_lastActivityAt_idx"        ON "wraith"."AccountSummary"("lastActivityAt");

-- ─── WebhookSubscription ──────────────────────────────────────────────────────
CREATE TABLE "wraith"."WebhookSubscription" (
    "id"        SERIAL NOT NULL,
    "url"       TEXT NOT NULL,
    "secret"    TEXT NOT NULL,
    "filter"    JSONB,
    "active"    BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebhookSubscription_active_idx"                  ON "wraith"."WebhookSubscription"("active");

-- ─── WebhookDelivery ──────────────────────────────────────────────────────────
CREATE TABLE "wraith"."WebhookDelivery" (
    "id"             SERIAL NOT NULL,
    "subscriptionId" INTEGER NOT NULL,
    "eventId"        TEXT NOT NULL,
    "payload"        JSONB NOT NULL,
    "status"         TEXT NOT NULL DEFAULT 'pending',
    "attempts"       INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt"    TIMESTAMP(3),
    "lastStatusCode" INTEGER,
    "lastError"      TEXT,
    "deliveredAt"    TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WebhookDelivery_subscriptionId_fkey"
        FOREIGN KEY ("subscriptionId")
        REFERENCES "wraith"."WebhookSubscription"("id")
        ON DELETE CASCADE
);

CREATE INDEX "WebhookDelivery_subscriptionId_idx"              ON "wraith"."WebhookDelivery"("subscriptionId");
CREATE INDEX "WebhookDelivery_status_nextRetryAt_idx"          ON "wraith"."WebhookDelivery"("status", "nextRetryAt");
CREATE INDEX "WebhookDelivery_eventId_idx"                     ON "wraith"."WebhookDelivery"("eventId");

-- ─── IndexerCheckpoint ────────────────────────────────────────────────────────
CREATE TABLE "wraith"."IndexerCheckpoint" (
    "id"          SERIAL NOT NULL,
    "batchId"     TEXT NOT NULL,
    "lastLedger"  INTEGER NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerCheckpoint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IndexerCheckpoint_batchId_key"            ON "wraith"."IndexerCheckpoint"("batchId");
