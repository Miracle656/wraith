#!/usr/bin/env bash
# Promote the current canary to 100% stable traffic.
# Usage: promote.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVICE_NAME="${SERVICE_NAME:-wraith}"
CANARY_TAG="$(cat "${SCRIPT_DIR}/.canary_tag" 2>/dev/null || echo '')"

if [[ -z "$CANARY_TAG" ]]; then
  echo "[canary/promote] ERROR: no canary tag found — has deploy.sh been run?" >&2
  exit 1
fi

echo "==> [canary/promote] promoting canary ${CANARY_TAG} to stable (100% traffic)"

# Record the new stable tag
echo "$CANARY_TAG" > "${SCRIPT_DIR}/.stable_tag"
rm -f "${SCRIPT_DIR}/.canary_tag"

cat <<EOF
---
# Full promotion manifest — apply with: kubectl apply -f -
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

echo "==> [canary/promote] stable=${CANARY_TAG}  canary traffic=0%"
exit 0