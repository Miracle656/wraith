# Database Schema Management

How wraith brings a database up to the schema the running code expects, and
what to do when it cannot.

The short version: **the schema is applied by a guarded `prisma db push` at
startup, after the database has been compared with the generated client, and
the result is verified before the service opens its listeners.** The committed
migrations under `prisma/migrations/` are not the deploy mechanism, because
they cannot build this database. `docs/drift-recovery.md` — this file — records
why, with the evidence.

## What runs at startup, in order

1. **Migration-history audit** (`schema.migrations.audit`). Reads
   `_prisma_migrations` if it exists and reports it against the migration
   directories on disk: table present or absent, applied count, failed count,
   unrecorded migrations, and migrations recorded in the database but missing
   from this build. Read-only. It never writes, baselines or resolves anything.
2. **Drift detection** (`schema.drift.detected`). Reads
   `information_schema.columns` and compares it with every model and scalar
   column in the generated Prisma client (`src/schemaState.ts`). A table or
   column the code writes but the database lacks is listed by name.
3. **Guarded convergence** (`schema.converge.*`). Runs `prisma db push` without
   `--accept-data-loss`. Additive changes — a new table, a new nullable column
   — apply. A refusal is only consented to when every warning is an added
   unique constraint (an index either builds or fails on duplicates; it drops
   nothing). Any other warning — dropped column, narrowed type, rename — exits
   non-zero with the diff printed.
4. **Verification** (`schema.verified`, or `schema.drift.unresolved`). Runs the
   detection again after the push. Anything still missing is fatal: the
   process exits instead of serving routes whose writes would fail. On the
   offramp that failure mode is the worst one in the service — the provider
   order exists, the money moved, and only our insert would have recorded it.

The `_prisma_migrations` audit is diagnostic and its failure does not stop
startup; the drift check is what gates serving. If the check itself cannot run
(e.g. the database is unreachable), startup fails: an unverified schema is
exactly the state this exists to rule out.

## Why `db push`, and not `migrate deploy`

This was investigated against a throwaway PostgreSQL 16 database on
**2026-10-21**, at commit `6f5846e` (main). The commands and their results:

### A fresh database cannot be built by the migrations

```sh
npx prisma migrate deploy
# Applying migration `20250101000000_add_backfill_cursor`
# Error: P3018 … Database error code: 3F000
# ERROR: schema "wraith" does not exist
```

No migration creates the `wraith` schema, so the first one fails. Creating the
schema by hand and marking the failed migration rolled back gets one step
further:

```sh
CREATE SCHEMA wraith;
npx prisma migrate resolve --rolled-back 20250101000000_add_backfill_cursor
npx prisma migrate deploy
# Applying `20250101000000_add_backfill_cursor`
# Applying `20260624120000_partition_retention_runs`
# Applying `20260626120000_add_token_transfer_is_sac`
# Error: P3018 … Database error code: 42P01
# ERROR: relation "wraith"."TokenTransfer" does not exist
```

The migrations `ALTER` tables that no migration creates. At this commit the
fourteen models other than `RetentionJobRun`, `BackfillCursor`,
`ContractTombstone`, `LpShareTransfer` and `TokenMetadata` have no
`CREATE TABLE` in `prisma/migrations/` at all — `TokenTransfer`, `HostFnLog`,
`NftTransfer`, `NftMetadata`, `AccountSummary`, `WebhookSubscription`,
`WebhookDelivery`, `IndexerState`, `IndexerCheckpoint`, `OfframpOrder` and
`NgnOrder` were created by `db push`. The migration files are a history of
*changes* to a database that already existed, not an init script.

### A `db push` database has no usable migration history

```sh
npx prisma db push
# 🚀 Your database is now in sync with your Prisma schema. Done in 316ms
# 16 tables created in the wraith schema
```

`_prisma_migrations` was then absent from **both** `public` and `wraith`. This
is the expected state of a database this service has provisioned: `db push`
applies the schema directly and records nothing. A live database may instead
hold a partial history if someone ran a migration by hand. Both cases are
reported by the startup audit; neither can be trusted to say what is applied.

On that fully-current database:

```sh
npx prisma migrate status
# Following migrations have not yet been applied: (all 8)
npx prisma migrate deploy
# Error: P3005 — The database schema is not empty.
```

So `migrate deploy` lists every migration as pending even though the schema is
current, and then refuses rather than trying to recreate tables. That refusal is
the only safe part of the story: if someone baselines only *some* migrations
with `migrate resolve --applied`, deploy would run the remaining `CREATE TABLE`
statements against tables that already exist.

### What that means for the choice

- `migrate deploy` cannot provision a fresh database, so `npm start` on a new
  environment would not work.
- It refuses this database with P3005, so it cannot be adopted without a
  baseline.
- Automatically baselining every committed migration as applied would silence
  exactly the signal that matters — an unrecorded migration may be one that was
  never applied. That is the failure this issue exists to prevent, not a fix for
  it.
- `db push` can converge either database, and its destructive-change guard keeps
  it from dropping or rewriting a table.

Switching to migrations therefore needs a separate piece of work: a real init
migration that creates the schema and every table, tested against an empty
database, *then* a deliberate baseline of the live one. Until that exists, the
startup audit above records the state rather than pretending it is clean.

## What is deliberately not automated

- **No `migrate resolve --applied`.** Marking a migration as applied without
  applying it hides the one genuinely pending.
- **No `migrate reset`.** It drops the schema. This database holds offramp
  orders: records of real naira paid to real bank accounts.
- **No `--accept-data-loss` on a production path.** The unique-constraint retry
  in `src/index.ts` consents only when every warning is an added unique
  constraint, which can fail but cannot delete a row.
- **No automatic baselining.** See `_prisma_migrations` above.

## What the drift check does and does not prove

It proves the database has every table and scalar column this build's Prisma
client expects, in the schema that holds the application's tables. It does not
compare types, defaults, indexes or constraints; `db push` applies those, and
its refusal on destructive changes is what keeps a type change from being
applied silently. It also ignores extra tables and columns (partitions,
operational tables) so that legitimate database objects outside the Prisma
schema do not cause a false failure.

## When convergence refuses to start

The guard exits non-zero and logs `schema.converge.refused_destructive` when a
pending change is anything other than additive. Nothing was dropped.

**Recovery:**

1. Read the `prisma db push` diff printed above the error.
2. Revert the destructive change in `prisma/schema.prisma`, or design a
   deliberate transition.
3. Deploy the revert.
4. If data was lost before the guard was in place, restore from backup.

Adding a migration file is still expected for any schema change (this repo
commits them under `prisma/migrations/`), even though startup applies the
schema via `db push`. `migrate dev` cannot replay this history — it fails on the
same missing tables as `migrate deploy` — so changes are written as
timestamped SQL by hand, matching the existing directories. The
`RUN_MIGRATION_IDEMPOTENCY=1` integration test remains skipped for the same
reason: the migrations do not apply cleanly from scratch.

## Operational queries

```sql
-- Is there a history table at all, and where?
SELECT table_schema, table_name
  FROM information_schema.tables
 WHERE table_name = '_prisma_migrations';

-- If it exists: what does it claim?
SELECT migration_name, finished_at, rolled_back_at
  FROM public._prisma_migrations
 ORDER BY started_at;
```

The startup audit emits the same findings as structured log events
(`schema.migrations.audit`, `schema.migrations.history_absent`,
`schema.migrations.unrecorded`, `schema.migrations.unexpected`,
`schema.migrations.failed_rows`), so no database access is needed to see them.

## Further reading

- [Prisma db push reference](https://www.prisma.io/docs/orm/reference/prisma-cli-reference#db-push)
- [Prisma migrate baseline docs](https://pris.ly/d/migrate-baseline)
- [Prisma migrate resolve reference](https://www.prisma.io/docs/orm/reference/prisma-cli-reference#migrate-resolve)
