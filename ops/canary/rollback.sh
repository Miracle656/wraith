#!/usr/bin/env bash
# Rollback: restore the previous stable tag and send 100% traffic to it.
# Called automatically by the canary workflow when monitor.sh exits 1.
# Usage: rollback.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVICE_NAME="${SERVICE_NAME:-wraith}"
PREVIOUS_TAG="$(cat "${SCRIPT_DIR}/.previous_stable_tag" 2>/dev/null || echo '')"
CANARY_TAG="$(cat "${SCRIPT_DIR}/.canary_tag"        2>/dev/null || echo '')"

if [[ -z "$PREVIOUS_TAG" ]]; then
  echo "[canary/rollback] ERROR: no previous stable tag found — cannot rollback" >&2
  exit 1
fi

echo "==> [canary/rollback] rolling back  canary=${CANARY_TAG}  -> stable=${PREVIOUS_TAG}"

# Clear canary tag; stable tag stays pointing at the known-good image
rm -f "${SCRIPT_DIR}/.canary_tag"

cat <<EOF
---
# Rollback manifest — apply with: kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: IngressRouteWeighted
metadata:
  name: ${SERVICE_NAME}-canary
spec:
  routes:
    - match: PathPrefix(\`/\`)
      services:
        - name: ${SERVICE_NAME}-stable
          weight: 100
        - name: ${SERVICE_NAME}-canary
          weight: 0
EOF

echo "==> [canary/rollback] stable=${PREVIOUS_TAG} restored to 100% traffic"
exit 0