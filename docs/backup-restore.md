# Backup & restore

Wraith is an indexer, so its Postgres data is always re-derivable by
re-indexing from chain — but a `pg_dump` restore is minutes, not days. The
[`db-backup.yml`](../.github/workflows/db-backup.yml) workflow runs nightly
(03:00 UTC) and on manual dispatch, and takes a logical backup of each
network's database independently, since mainnet and testnet each have their
own Postgres instance (see [`docs/DUAL_NETWORK.md`](DUAL_NETWORK.md)).

## What it does

For each network with its backup secrets configured, the workflow:

1. Runs `pg_dump --format=custom --no-owner --no-privileges` against that
   network's database (via [`ops/backup/dump.sh`](../ops/backup/dump.sh)).
2. Gzips the dump.
3. **Encrypts it** with AES-256 using `BACKUP_PASSPHRASE`, and deletes the
   cleartext copy before the upload step runs.
4. Uploads the `.dump.gz.gpg` as a GitHub Actions artifact named
   `wraith-db-backup-<network>-<run_id>`, retained for 14 days.

A network missing either secret is skipped with a workflow warning rather than
failing the run — this lets the workflow exist before both databases are
provisioned.

### Why the dump is encrypted

**This repository is public, and Actions artifacts on a public repository are
downloadable by anyone with the run URL — no login, no permissions.**

A Wraith dump is not just indexed chain data. It contains the
`WebhookSubscription` table, whose `secret` column holds the *plaintext HMAC
signing key* for each subscriber, next to that subscriber's delivery URL.
Published unencrypted, that artifact would let a stranger forge webhook
deliveries that pass signature verification against every subscriber — and
hand them the subscriber list on the way past. Fourteen days of retention,
regenerated nightly.

So encryption is mandatory rather than opt-in, in three places that each fail
closed:

- `dump.sh` refuses to run at all without `BACKUP_PASSPHRASE`;
- it deletes the cleartext `.gz` and re-checks it is gone before exiting;
- the upload glob is `*.dump.gz.gpg`, not `*.dump.gz*`, with
  `if-no-files-found: error` — so if encryption ever silently fails, the job
  fails instead of publishing the cleartext dump.

The passphrase is the only thing standing between the artifact and a reader.
Store it wherever the database credentials live; **if it is lost, every
retained backup is unrecoverable** — which is survivable here only because
Wraith can re-derive its data by re-indexing from chain.

## Required secrets

| Secret | Purpose |
|---|---|
| `DATABASE_URL_TESTNET` | Connection string for the testnet database |
| `DATABASE_URL_MAINNET` | Connection string for the mainnet database |
| `BACKUP_PASSPHRASE` | Symmetric passphrase the dumps are encrypted with. Required — a network is skipped without it. Shared across both networks. |

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
2. Decrypt it, then decompress:
   ```bash
   # Reads the passphrase from stdin so it never lands in your shell history
   # or in `ps` output.
   gpg --batch --quiet --decrypt --passphrase-fd 0      --output wraith-<network>-<timestamp>.dump.gz      wraith-<network>-<timestamp>.dump.gz.gpg
   gunzip wraith-<network>-<timestamp>.dump.gz
   ```
   The decrypted dump contains live webhook signing secrets. Restore it and
   delete it; do not leave it sitting in a Downloads folder.
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
That dry run is also the only thing that proves `BACKUP_PASSPHRASE` is the
passphrase the artifacts were actually encrypted with — an untested backup and
no backup differ only in how confident you are.
This should be re-verified whenever the Prisma schema changes in a way that
affects `pg_restore` compatibility (e.g. extensions, custom types).
