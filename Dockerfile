# Single container running BOTH processes for Cloud Run:
#   - Flue agent HTTP server (binds Cloud Run's $PORT, satisfies health check)
#   - Telegram long-polling bot (background process, talks to Flue on localhost)
# Run with: --no-cpu-throttling --min-instances=1 --max-instances=1
# (max=1 because only one instance may long-poll Telegram, and Flue sessions
#  are in-memory per instance.)
FROM node:24-slim

WORKDIR /app

# procps provides `ps`, which concurrently's --kill-others needs to tear down
# the process tree. Without it, any process exit triggers `spawn ps ENOENT`
# and an unhandled crash instead of a clean shutdown.
RUN apt-get update \
  && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/*

# Install all deps (build needs tsc + flue cli; concurrently runs both procs)
COPY package.json package-lock.json ./
RUN npm ci

# Source + build
COPY tsconfig.json tsconfig.flue.json flue.config.ts ./
COPY src ./src
COPY .flue ./.flue
RUN npm run build

ENV NODE_ENV=production

# Cloud Run injects PORT (default 8080). Flue server binds it; the bot calls
# Flue over localhost. --kill-others so if either process dies the container
# exits and Cloud Run restarts it.
CMD ["sh", "-c", "FLUE_URL=http://localhost:${PORT:-8080} npx concurrently --kill-others --names agent,bot 'node dist/server.mjs' 'node dist/index.js'"]
