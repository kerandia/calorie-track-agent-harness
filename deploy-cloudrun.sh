#!/bin/sh
# Deploy the agent (Flue server + Telegram bot) to Google Cloud Run.
#
# Prereqs (run once, interactively):
#   gcloud auth login
#   gcloud config set project <YOUR_PROJECT_ID>
#
# Secrets are read from ./.env at deploy time and pushed as Cloud Run env vars
# via a temp file in the system tmpdir — nothing secret is written into the repo.
# (Hardening later: move these to Secret Manager with --set-secrets.)
set -e

SERVICE="${SERVICE:-calorie-agent}"
REGION="${REGION:-europe-west3}"   # Frankfurt; override with REGION=...

if [ ! -f ./.env ]; then
  echo "ERROR: ./.env not found. Run from the repo root with your filled-in .env." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

: "${DASHBOARD_URL:?Set DASHBOARD_URL in .env to your Vercel URL}"

ENVFILE="$(mktemp)"
trap 'rm -f "$ENVFILE"' EXIT
cat > "$ENVFILE" <<EOF
TELEGRAM_BOT_TOKEN: "${TELEGRAM_BOT_TOKEN}"
OPENROUTER_API_KEY: "${OPENROUTER_API_KEY}"
NEBIUS_API_KEY: "${NEBIUS_API_KEY}"
UPSTASH_REDIS_REST_URL: "${UPSTASH_REDIS_REST_URL}"
UPSTASH_REDIS_REST_TOKEN: "${UPSTASH_REDIS_REST_TOKEN}"
UPSTASH_VECTOR_REST_URL: "${UPSTASH_VECTOR_REST_URL}"
UPSTASH_VECTOR_REST_TOKEN: "${UPSTASH_VECTOR_REST_TOKEN}"
UPSTASH_BOX_API_KEY: "${UPSTASH_BOX_API_KEY}"
VISION_MODEL: "${VISION_MODEL:-google/gemma-4-26b-a4b-it:free}"
DASHBOARD_URL: "${DASHBOARD_URL}"
EOF

echo "Deploying '$SERVICE' to Cloud Run ($REGION)…"
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --no-cpu-throttling \
  --min-instances=1 \
  --max-instances=1 \
  --memory=1Gi \
  --port=8080 \
  --no-allow-unauthenticated \
  --env-vars-file="$ENVFILE"

echo "Done. Tail logs with:"
echo "  gcloud run services logs tail $SERVICE --region $REGION"
