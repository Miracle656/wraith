#!/usr/bin/env bash
# Dump a Postgres database and gzip the result.
# Usage: NETWORK=mainnet DATABASE_URL=postgresql://... dump.sh
set -euo pipefail

NETWORK="${NETWORK:?NETWORK is required (testnet or mainnet)}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
OUT_DIR="${OUT_DIR:-backups}"

mkdir -p "$OUT_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_FILE="${OUT_DIR}/wraith-${NETWORK}-${STAMP}.dump"

echo "==> [backup/dump] dumping ${NETWORK} database"
pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$DUMP_FILE"

echo "==> [backup/dump] compressing ${DUMP_FILE}"
gzip "$DUMP_FILE"

echo "==> [backup/dump] wrote ${DUMP_FILE}.gz"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "dump_path=${DUMP_FILE}.gz" >> "$GITHUB_OUTPUT"
fi
