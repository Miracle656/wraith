-- Tag each transfer with whether the emitting contract is a Stellar Asset
-- Contract (SAC) wrapping a classic asset, vs. a native Soroban token (#136).
ALTER TABLE "wraith"."TokenTransfer"
  ADD COLUMN "isSac" BOOLEAN NOT NULL DEFAULT false;
