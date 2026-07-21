#!/bin/sh
# Deploy the agent (Flue server + Telegram webhook pipeline) to Google Cloud Run.
#
# Scale-to-zero mode: Telegram pushes updates to /tg/webhook; QStash delivers
# the actual turn to /tg/process. No long-polling, so no always-on instance —
# idle cost is zero and light usage sits inside the Cloud Run free tier.
#
# Prereqs (run once, interactively):
#   gcloud auth login
#   gcloud config set project <YOUR_PROJECT_ID>
#
# After the FIRST deploy (or if the webhook secret changes), register the
# webhook with Telegram:
#   ./deploy-cloudrun.sh set-webhook
#
# Secrets are read from ./.env at deploy time and pushed as Cloud Run env vars
# via a temp file in the system tmpdir — nothing secret is written into the repo.
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
: "${SERVICE_URL:?Set SERVICE_URL in .env to the Cloud Run service URL}"
: "${TELEGRAM_WEBHOOK_SECRET:?Set TELEGRAM_WEBHOOK_SECRET in .env (random string)}"
: "${INTERNAL_API_SECRET:?Set INTERNAL_API_SECRET in .env (random string)}"
: "${QSTASH_TOKEN:?Set QSTASH_TOKEN in .env (Upstash console -> QStash)}"

if [ "$1" = "set-webhook" ]; then
  echo "Registering Telegram webhook -> ${SERVICE_URL}/tg/webhook"
  curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
    -H 'Content-Type: application/json' \
    -d "{\"url\":\"${SERVICE_URL}/tg/webhook\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\",\"drop_pending_updates\":false,\"allowed_updates\":[\"message\"]}"
  echo ""
  exit 0
fi

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
SERVICE_URL: "${SERVICE_URL}"
TELEGRAM_WEBHOOK_SECRET: "${TELEGRAM_WEBHOOK_SECRET}"
INTERNAL_API_SECRET: "${INTERNAL_API_SECRET}"
QSTASH_TOKEN: "${QSTASH_TOKEN}"
EOF

echo "Deploying '$SERVICE' to Cloud Run ($REGION, scale-to-zero)…"
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --cpu-throttling \
  --min-instances=0 \
  --max-instances=1 \
  --memory=1Gi \
  --port=8080 \
  --timeout=600 \
  --allow-unauthenticated \
  --env-vars-file="$ENVFILE"

echo "Done. Tail logs with:"
echo "  gcloud run services logs tail $SERVICE --region $REGION"
echo "If this was the first webhook deploy, run: ./deploy-cloudrun.sh set-webhook"
