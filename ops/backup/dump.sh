#!/usr/bin/env bash
# Dump a Postgres database, gzip it, and encrypt the result.
# Usage: NETWORK=mainnet DATABASE_URL=postgresql://... BACKUP_PASSPHRASE=... dump.sh
#
# Encryption is mandatory, not opt-in. This repository is public, and GitHub
# Actions artifacts on a public repository are downloadable by anyone with the
# run URL — no login, no permissions. A Wraith dump contains the
# WebhookSubscription table, whose `secret` column is the plaintext HMAC key
# used to sign deliveries, alongside every subscriber URL. An unencrypted
# artifact would therefore let a stranger forge signed webhooks to every
# subscriber, and hand them the subscriber list on the way past.
#
# The dump is symmetrically encrypted with AES-256 so the artifact is inert
# without the passphrase. Losing the passphrase means losing the backups, so
# store it wherever the database credentials live.
set -euo pipefail

NETWORK="${NETWORK:?NETWORK is required (testnet or mainnet)}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
# Refuse to produce anything if the passphrase is missing rather than silently
# falling back to a plaintext dump — a failed backup is recoverable, a leaked
# one is not.
BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required — this dump must not be written unencrypted}"
OUT_DIR="${OUT_DIR:-backups}"

mkdir -p "$OUT_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_FILE="${OUT_DIR}/wraith-${NETWORK}-${STAMP}.dump"

echo "==> [backup/dump] dumping ${NETWORK} database"
pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$DUMP_FILE"

echo "==> [backup/dump] compressing ${DUMP_FILE}"
gzip "$DUMP_FILE"

echo "==> [backup/dump] encrypting ${DUMP_FILE}.gz"
# --passphrase-fd 0 keeps the passphrase off the process list, where any other
# process on the runner could read it from `ps`.
printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --yes --quiet \
  --symmetric --cipher-algo AES256 \
  --passphrase-fd 0 \
  --output "${DUMP_FILE}.gz.gpg" \
  "${DUMP_FILE}.gz"

# Remove the cleartext copy before the upload step can see it.
rm -f "${DUMP_FILE}.gz"

# Belt and braces: if the cleartext file somehow survived, fail rather than
# hand the upload step something it should never publish.
if [[ -e "${DUMP_FILE}.gz" ]]; then
  echo "::error::cleartext dump still present after encryption — refusing to continue" >&2
  exit 1
fi

echo "==> [backup/dump] wrote ${DUMP_FILE}.gz.gpg"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "dump_path=${DUMP_FILE}.gz.gpg" >> "$GITHUB_OUTPUT"
fi
