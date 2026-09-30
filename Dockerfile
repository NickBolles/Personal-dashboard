# syntax=docker/dockerfile:1.7
# Jarvis dashboard — standalone Next.js server + SQLite (WAL) on a volume.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 ships prebuilt binaries for linux x64/arm64; build tools are a fallback.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
WORKDIR /app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ARG JARVIS_VERSION=dev
ENV JARVIS_VERSION=${JARVIS_VERSION}
RUN npm run build && node scripts/prepare-standalone.mjs

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    JARVIS_DATA_DIR=/data
ARG JARVIS_VERSION=dev
ENV JARVIS_VERSION=${JARVIS_VERSION}
RUN groupadd --system --gid 1001 jarvis && useradd --system --uid 1001 --gid jarvis jarvis \
  && mkdir -p /data && chown jarvis:jarvis /data
COPY --from=build --chown=jarvis:jarvis /app/.next/standalone ./
COPY --from=build --chown=jarvis:jarvis /app/scripts/backup.mjs ./scripts/backup.mjs
USER jarvis
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
