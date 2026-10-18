# Database Schema Management

This document explains how wraith manages database schema changes and how to recover from schema drift.

## Current Approach: Schema-Guarded `db push`

Wraith uses `prisma db push` on startup with intelligent guards to prevent data loss:

- **Additive changes** (new tables, new nullable columns) apply automatically
- **Destructive changes** (dropped columns, renamed fields, type changes) are blocked
- **Unique constraint additions** are allowed (not data loss - they either succeed or fail on duplicates)
- The service refuses to start if a destructive change is detected

See `src/schemaGuard.ts` for the implementation and `src/__tests__/schemaGuard.test.ts` for tests.

## Background

The database was initially provisioned using `prisma db push`, which applies schema changes directly without recording migration history. While `prisma/migrations/` contains migration files, they were never applied to the live database.

The migration history is incomplete:
- `prisma/migrations` holds 7 migrations covering 5 tables
- The schema defines 15+ tables
- Some tables (TokenTransfer, AccountSummary, IndexerState, OfframpOrder) have no migration at all

This makes switching to `prisma migrate deploy` non-trivial without first baselining the production database.

## Symptoms of Schema Drift

If the database schema drifts from what Prisma expects, `prisma db push` will report warnings:

```
⚠️ The following changes were detected:
  • A column named `old_column` was removed
  • The type of `amount` changed from TEXT to BIGINT
```

The schema guard will:
1. Refuse to apply the change
2. Log the full diff
3. Exit with a non-zero code
4. The service will not start

## Recovery Steps

### Scenario 1: Only Unique Constraints Are Being Added

If all warnings are for added unique constraints (which are not data loss), the schema guard will automatically apply them with `--accept-data-loss`.

Example safe change:
```
• A unique constraint covering the columns `[network,publicId]` on the table `OfframpOrder` will be added.
```

### Scenario 2: A Destructive Change Was Accidentally Committed

If a destructive change was committed (e.g., dropped column, renamed field), the service will refuse to start:

```
[wraith] Schema convergence refused: the pending change is destructive.
[wraith] Nothing was dropped. Read the diff above — a rename or a type
[wraith] change needs a deliberate migration, not --accept-data-loss.
```

**Recovery:**

1. Revert the schema change in `prisma/schema.prisma`
2. Deploy the revert
3. If data was already lost, restore from backup
4. Design a proper migration for the desired change

### Scenario 3: Baseline an Existing Database

If you need to establish migration history for a database that was previously managed by `db push`:

1. **Check current state**

   ```sh
   npx prisma migrate status
   ```

2. **Baseline against the latest migration**

   Identify the latest migration directory, then run:

   ```sh
   npx prisma migrate resolve --applied <migration_name>
   ```

   Repeat for every migration, working oldest → newest:

   ```sh
   ls -d prisma/migrations/*/ | sort | while read m; do
     npx prisma migrate resolve --applied "$(basename "$m")"
   done
   ```

3. **Verify**

   ```sh
   npx prisma migrate status
   # All migrations should show: "applied"
   ```

After baselining, you can switch to `prisma migrate deploy` if desired (though this is not currently wraith's approach).

## Development

For rapid local schema iteration, you can temporarily disable the schema guard by modifying `src/index.ts`, but this should never be done in production.

## Further Reading

- [Prisma db push reference](https://www.prisma.io/docs/orm/reference/prisma-cli-reference#db-push)
- [Prisma migrate resolve reference](https://www.prisma.io/docs/orm/reference/prisma-cli-reference#migrate-resolve)
- [Prisma baseline docs](https://pris.ly/d/migrate-baseline)
