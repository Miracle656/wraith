# Drift Recovery: migrating from `db push` to `prisma migrate deploy`

> **⚠️ Required before merging this PR into production**
>
> The live database was provisioned by `prisma db push`, so `_prisma_migrations`
> is empty. When this change lands, `prisma migrate deploy` will abort with
> **P3005** and the service will not come up. You must baseline the production
> database (Option A below) **before** deploying this commit — the ordering is
> not optional.
>
> Note: this database is shared with Lens. Getting the ordering wrong affects
> both services.

This guide covers how to bring a database that was previously managed by
`prisma db push` under proper migration control.

---

## Background

Until this change (`fix/issue-192-migrate-deploy-on-boot`), wraith called

```
npx prisma db push --accept-data-loss
```

on every startup. `db push` diffs the Prisma schema against the live database
and applies the delta directly — it never writes to the `_prisma_migrations`
table, so the database has no migration history. Eight committed migration files
in `prisma/migrations/` were present but never applied.

The new boot path is:

```
npx prisma migrate deploy
```

which is idempotent, safe, and records every applied migration so future deploys
are incremental rather than full-schema diffs.

---

## Symptoms of a drifted database

`prisma migrate deploy` will abort with **P3005** if it detects that the
database schema is non-empty but the `_prisma_migrations` table is missing or
empty — i.e., the database was provisioned by `db push`.

```
Error: P3005
The database schema is not empty. Read more about how to baseline
an existing production database:
https://pris.ly/d/migrate-baseline
```

The service will exit with a non-zero code and log:

```
[wraith] FATAL: prisma migrate deploy failed — the database schema is out of sync.
  Run `npx prisma migrate status` to inspect pending migrations.
  See docs/drift-recovery.md for recovery steps if the database was previously
  managed by `db push`.
```

---

## Recovery steps

### Option A — Baseline in place (zero downtime, recommended for production)

Baselining tells Prisma "the schema already matches the final migration; mark
all migrations as applied without re-running them."

1. **Check current drift**

   ```sh
   npx prisma migrate status
   ```

   All migrations will show as "not applied" on a `db push`-managed database.

2. **Baseline the database against the latest migration**

   Identify the name of the latest migration directory, e.g.
   `20260901140000_add_token_metadata`, then run:

   ```sh
   npx prisma migrate resolve \
     --applied 20260901140000_add_token_metadata
   ```

   Repeat for every earlier migration, working oldest → newest, or use a
   shell loop:

   ```sh
   ls -d prisma/migrations/*/ | sort | while read m; do
     npx prisma migrate resolve --applied "$(basename "$m")"
   done
   ```

   The `-d */` pattern matches only directories, so `migration_lock.toml` is
   never passed to `migrate resolve` (which errors out on non-migration names).

3. **Verify**

   ```sh
   npx prisma migrate status
   # All migrations should now show: "applied"
   ```

4. **Deploy normally**

   Restart the service. `prisma migrate deploy` will find all migrations already
   applied and exit immediately — zero SQL executed against the database.

---

### Option B — Fresh database (dev / staging only)

If the database holds no data worth keeping (local dev, a throwaway staging
environment), a clean reset is faster:

```sh
npx prisma migrate reset --force --skip-seed
```

This drops the entire schema, re-creates it from scratch via the migration
files, and leaves a fully-baselined `_prisma_migrations` table. **Never run
this against production.**

---

### Option C — DB_PUSH_DEV escape hatch (local iteration only)

If you need `db push` behaviour during rapid local schema iteration, set the
`DB_PUSH_DEV` environment variable:

```sh
DB_PUSH_DEV=true npm run dev
```

This skips `migrate deploy` and falls back to `prisma db push` (without
`--accept-data-loss`). **This flag must never be set in production or staging.**

---

## Verifying a fresh database reaches the current schema

On a brand-new, empty database `prisma migrate deploy` should apply all eight
migrations and produce a schema identical to what `db push` would have created:

```sh
# 1. Point at an empty database
export DATABASE_URL="postgresql://user:pass@host/empty_db"

# 2. Deploy migrations
npx prisma migrate deploy

# 3. Confirm all migrations applied
npx prisma migrate status
```

All eight entries in `prisma/migrations/` should be marked **applied**.

---

## Further reading

- [Prisma baseline docs](https://pris.ly/d/migrate-baseline)
- [prisma migrate deploy reference](https://www.prisma.io/docs/orm/reference/prisma-cli-reference#migrate-deploy)
- [prisma migrate resolve reference](https://www.prisma.io/docs/orm/reference/prisma-cli-reference#migrate-resolve)
