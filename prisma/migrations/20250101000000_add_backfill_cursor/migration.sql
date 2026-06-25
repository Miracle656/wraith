CREATE TABLE "wraith"."BackfillCursor" (
    "id"          INTEGER NOT NULL DEFAULT 1,
    "startLedger" INTEGER NOT NULL,
    "endLedger"   INTEGER NOT NULL,
    "nextLedger"  INTEGER NOT NULL,
    "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackfillCursor_pkey" PRIMARY KEY ("id")
);
