#!/usr/bin/env bash
# Deploy a canary build with the configured initial traffic weight.
# Usage: deploy.sh <image_tag>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${SCRIPT_DIR}/config.yaml"

IMAGE_TAG="${1:?Usage: deploy.sh <image_tag>}"
CANARY_WEIGHT="${CANARY_WEIGHT:-10}"
SERVICE_NAME="${SERVICE_NAME:-wraith}"
REGISTRY="${REGISTRY:-ghcr.io/miracle656/wraith}"

echo "==> [canary/deploy] image=${REGISTRY}:${IMAGE_TAG}  weight=${CANARY_WEIGHT}%"

# ── Record previous stable tag for rollback ────────────────────────────────
PREVIOUS_TAG="$(cat "${SCRIPT_DIR}/.stable_tag" 2>/dev/null || echo '')"
CURRENT_TAG="$(cat "${SCRIPT_DIR}/.canary_tag" 2>/dev/null || echo '')"

if [[ -z "$PREVIOUS_TAG" && -n "$CURRENT_TAG" ]]; then
  PREVIOUS_TAG="$CURRENT_TAG"
fi
echo "$PREVIOUS_TAG" > "${SCRIPT_DIR}/.previous_stable_tag"
echo "$IMAGE_TAG"    > "${SCRIPT_DIR}/.canary_tag"

echo "    stable=${PREVIOUS_TAG:-<none>}  canary=${IMAGE_TAG}"

# ── Render weighted routing manifest ──────────────────────────────────────
# In a real cluster this would be a kubectl/helm call; here we emit the config
# so it can be applied by the CI runner or an operator.
cat <<EOF
---
# Canary routing config — apply with: kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: IngressRouteWeighted
metadata:
  name: ${SERVICE_NAME}-canary
spec:
  routes:
    - match: PathPrefix(\`/\`)
      services:
        - name: ${SERVICE_NAME}-stable
          weight: $((100 - CANARY_WEIGHT))
        - name: ${SERVICE_NAME}-canary
          weight: ${CANARY_WEIGHT}
EOF

echo "==> [canary/deploy] canary deployed at ${CANARY_WEIGHT}% traffic"
exit 0