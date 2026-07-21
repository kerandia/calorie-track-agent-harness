# Single process for Cloud Run: the Flue server (dist/server.mjs) owns the
# whole HTTP surface via .flue/app.ts —
#   /tg/webhook   Telegram webhook (fast ack → QStash)
#   /tg/process   QStash-delivered agent turns (replies via sendMessage)
#   /agents/*     Flue agent routes (gated by INTERNAL_API_SECRET)
# No long-polling bot anymore → deploy with --min-instances=0 (scale to zero).
FROM node:24-slim

WORKDIR /app

# Install all deps (build needs tsc + flue cli)
COPY package.json package-lock.json ./
RUN npm ci

# Source + build
COPY tsconfig.json tsconfig.flue.json flue.config.ts ./
COPY src ./src
COPY .flue ./.flue
RUN npm run build

ENV NODE_ENV=production

# Cloud Run injects PORT (default 8080); the Flue server binds it.
CMD ["node", "dist/server.mjs"]
