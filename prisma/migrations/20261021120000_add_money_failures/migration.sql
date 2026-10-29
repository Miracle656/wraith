-- A durable record of money-affecting failures: offramp orders that ended
-- failed (the naira payout did not complete), onramp/bill orders that failed
-- after the user paid, and webhook events reconciliation gave up on.
--
-- Deliberately separate from ordinary request errors: a 400 for a malformed
-- bank code never lands here, because nothing moved. This table is what makes
-- "what broke today" answerable without a log search.
--
-- Carries no bank details, no amounts, no wallet addresses and never a NIN:
-- the row names the rail, the order and what failed, and that is all this
-- surface needs.
CREATE TABLE "wraith"."MoneyFailure" (
  "id" SERIAL NOT NULL,
  "network" TEXT NOT NULL DEFAULT 'testnet',
  "rail" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "orderId" TEXT,
  "publicId" TEXT,
  "providerCode" TEXT,
  "message" TEXT NOT NULL,
  "occurrences" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MoneyFailure_pkey" PRIMARY KEY ("id")
);

-- One row per (network, kind, order): the webhook, the status poll and a
-- redelivery describing the same failed order increment `occurrences` rather
-- than adding a second row. One failed payout is one incident.
CREATE UNIQUE INDEX "MoneyFailure_network_kind_orderId_key"
  ON "wraith"."MoneyFailure"("network", "kind", "orderId");

-- "Recent failures, newest first" — the only access path, from
-- GET /ops/failures. `network` leads so a per-network operator view can use
-- the index for its filter too.
CREATE INDEX "MoneyFailure_network_createdAt_idx"
  ON "wraith"."MoneyFailure"("network", "createdAt");
