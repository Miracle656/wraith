-- Store the CAP-84 uint64 muxed contract destination ID as a nullable string (#351).
-- Additive and nullable so `prisma db push` applies without data-loss warnings at boot.
ALTER TABLE "wraith"."TokenTransfer"
  ADD COLUMN "toMuxedId" TEXT;

CREATE INDEX "TokenTransfer_network_toAddress_toMuxedId_idx"
  ON "wraith"."TokenTransfer"("network", "toAddress", "toMuxedId");
