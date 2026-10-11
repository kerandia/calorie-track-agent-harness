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
# iMessage (Photon Spectrum), once: register ${SERVICE_URL}/im/webhook with
# Photon and save its signing secret into .env, then deploy so the service
# gets SPECTRUM_WEBHOOK_SECRET:
#   ./deploy-cloudrun.sh imessage-webhook && ./deploy-cloudrun.sh
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
: "${FISH_AUDIO_TOKEN:?Set FISH_AUDIO_TOKEN in .env (fish.audio -> API keys)}"

if [ "$1" = "set-webhook" ]; then
  echo "Registering Telegram webhook -> ${SERVICE_URL}/tg/webhook"
  curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
    -H 'Content-Type: application/json' \
    -d "{\"url\":\"${SERVICE_URL}/tg/webhook\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\",\"drop_pending_updates\":false,\"allowed_updates\":[\"message\"]}"
  echo ""
  exit 0
fi

if [ "$1" = "imessage-webhook" ]; then
  : "${SPECTRUM_PROJECT_ID:?Set SPECTRUM_PROJECT_ID in .env (Photon dashboard -> project Settings)}"
  : "${SPECTRUM_PROJECT_SECRET:?Set SPECTRUM_PROJECT_SECRET in .env (Photon dashboard -> project Settings)}"
  if [ -n "${SPECTRUM_WEBHOOK_SECRET:-}" ]; then
    echo "SPECTRUM_WEBHOOK_SECRET is already in .env. To re-register, delete the old webhook in the Photon dashboard and remove that line first." >&2
    exit 1
  fi
  WEBHOOK_URL="${SERVICE_URL%/}/im/webhook"
  echo "Registering Photon webhook -> ${WEBHOOK_URL}"
  RESP="$(curl -sS -X POST "https://spectrum.photon.codes/projects/${SPECTRUM_PROJECT_ID}/webhooks/" \
    -u "${SPECTRUM_PROJECT_ID}:${SPECTRUM_PROJECT_SECRET}" \
    -H 'Content-Type: application/json' \
    -d "{\"webhookUrl\":\"${WEBHOOK_URL}\"}")"
  # The signing secret is returned only in this response, so it goes straight into .env.
  SIGNING_SECRET="$(printf '%s' "$RESP" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{process.stdout.write(JSON.parse(s)?.data?.signingSecret??"")}catch{}})')"
  if [ -z "$SIGNING_SECRET" ]; then
    echo "ERROR: Photon webhook registration failed: $RESP" >&2
    exit 1
  fi
  printf '\nSPECTRUM_WEBHOOK_SECRET=%s\n' "$SIGNING_SECRET" >> ./.env
  echo "Saved SPECTRUM_WEBHOOK_SECRET to .env. Now deploy: ./deploy-cloudrun.sh"
  exit 0
fi

ENVFILE="$(mktemp)"
trap 'rm -f "$ENVFILE"' EXIT
cat > "$ENVFILE" <<EOF
TELEGRAM_BOT_TOKEN: "${TELEGRAM_BOT_TOKEN}"
OPENROUTER_API_KEY: "${OPENROUTER_API_KEY}"
NEBIUS_API_KEY: "${NEBIUS_API_KEY}"
NEBIUS_REASONING_EFFORT: "${NEBIUS_REASONING_EFFORT:-low}"
UPSTASH_REDIS_REST_URL: "${UPSTASH_REDIS_REST_URL}"
UPSTASH_REDIS_REST_TOKEN: "${UPSTASH_REDIS_REST_TOKEN}"
UPSTASH_VECTOR_REST_URL: "${UPSTASH_VECTOR_REST_URL}"
UPSTASH_VECTOR_REST_TOKEN: "${UPSTASH_VECTOR_REST_TOKEN}"
UPSTASH_BOX_API_KEY: "${UPSTASH_BOX_API_KEY}"
UPSTASH_BLOB_TOKEN: "${UPSTASH_BLOB_TOKEN:-}"
MAPROOM_API_KEY: "${MAPROOM_API_KEY:-}"
VISION_MODEL: "${VISION_MODEL:-google/gemma-4-26b-a4b-it:free}"
DASHBOARD_URL: "${DASHBOARD_URL}"
SERVICE_URL: "${SERVICE_URL}"
TELEGRAM_WEBHOOK_SECRET: "${TELEGRAM_WEBHOOK_SECRET}"
INTERNAL_API_SECRET: "${INTERNAL_API_SECRET}"
QSTASH_TOKEN: "${QSTASH_TOKEN}"
FISH_AUDIO_TOKEN: "${FISH_AUDIO_TOKEN}"
FISH_TTS_MODEL: "${FISH_TTS_MODEL:-s2.1-pro-free}"
FISH_VOICE_ID: "${FISH_VOICE_ID:-}"
STT_MODEL: "${STT_MODEL:-x-ai/grok-stt-1.0}"
SPECTRUM_PROJECT_ID: "${SPECTRUM_PROJECT_ID:-}"
SPECTRUM_PROJECT_SECRET: "${SPECTRUM_PROJECT_SECRET:-}"
SPECTRUM_WEBHOOK_SECRET: "${SPECTRUM_WEBHOOK_SECRET:-}"
GOOGLE_MAPS_API_KEY: "${GOOGLE_MAPS_API_KEY:-}"
EXA_API_KEY: "${EXA_API_KEY:-}"
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
