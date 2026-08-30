# Backup & restore

Wraith is an indexer, so its Postgres data is always re-derivable by
re-indexing from chain — but a `pg_dump` restore is minutes, not days. The
[`db-backup.yml`](../.github/workflows/db-backup.yml) workflow runs nightly
(03:00 UTC) and on manual dispatch, and takes a logical backup of each
network's database independently, since mainnet and testnet each have their
own Postgres instance (see [`docs/DUAL_NETWORK.md`](DUAL_NETWORK.md)).

## What it does

For each network with a backup secret configured, the workflow:

1. Runs `pg_dump --format=custom --no-owner --no-privileges` against that
   network's database (via [`ops/backup/dump.sh`](../ops/backup/dump.sh)).
2. Gzips the dump.
3. Uploads it as a GitHub Actions artifact named
   `wraith-db-backup-<network>-<run_id>`, retained for 14 days.

A network without its secret set is skipped with a workflow warning rather
than failing the run — this lets the workflow exist before both databases are
provisioned.

## Required secrets

| Secret | Purpose |
|---|---|
| `DATABASE_URL_TESTNET` | Connection string for the testnet database |
| `DATABASE_URL_MAINNET` | Connection string for the mainnet database |

These are backup-only credentials, separate from the `DATABASE_URL` a given
deployment runs with (each deployment only knows about its own network's
database — see the env matrix in `docs/DUAL_NETWORK.md`). Use a role with
read access sufficient for `pg_dump`; it does not need write access.

Set them in the repo's **Settings → Secrets and variables → Actions**. Never
commit a real connection string.

## Running it manually

Trigger the workflow from the **Actions** tab (`Nightly DB backup` →
**Run workflow**) and pick `both`, `testnet`, or `mainnet`. Useful right
before a risky migration or deploy.

## Restoring from a backup

1. Download the artifact from the workflow run (**Actions** → the run →
   **Artifacts**), or via `gh run download <run-id> -n wraith-db-backup-<network>-<run_id>`.
2. Decompress it:
   ```bash
   gunzip wraith-<network>-<timestamp>.dump.gz
   ```
3. Provision (or reuse) a target Postgres instance — e.g. a fresh Neon
   database — and restore into it:
   ```bash
   pg_restore --clean --if-exists --no-owner --no-privileges \
     --dbname="$TARGET_DATABASE_URL" \
     wraith-<network>-<timestamp>.dump
   ```
   `--clean --if-exists` drops conflicting objects first, so this is also
   safe to run against a database that already has the old schema in it.
4. Point the deployment at the restored database: update `DATABASE_URL` (and
   `DIRECT_DATABASE_URL` if set separately, e.g. for a pooled connection) for
   that network's service, then redeploy/restart it.
5. Sanity-check: hit `/status` and `/healthz` on the restored deployment and
   confirm `IndexerState`/`BackfillCursor` rows look sane for that network. If
   the restore lags behind the chain tip, the indexer will catch up on its
   own via backfill — no manual action needed.

### Per-network dumps

Never restore a testnet dump into the mainnet database or vice versa. Every
row in this schema is tagged with a `network` column ([`docs/DUAL_NETWORK.md`](DUAL_NETWORK.md#L1)),
but the two networks still use physically separate database instances in the
recommended deployment, so cross-restoring would overwrite one network's
current data with the other's stale snapshot rather than merging anything.

## Verifying the runbook

Before relying on this in production, run the restore steps above once
against a scratch Postgres instance using a real nightly artifact, and
confirm the restored data matches what `/status` reports for that network.
This should be re-verified whenever the Prisma schema changes in a way that
affects `pg_restore` compatibility (e.g. extensions, custom types).
