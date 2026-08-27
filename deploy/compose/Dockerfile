# The one production image: the tool gateway over Streamable HTTP (§3.1).
# brain-mcp is not a separate service — the gateway spawns it as a stdio
# child from the vault's config/servers.yaml, inside this container.
# Build context is the repo root; .dockerignore keeps .env and vault/ out.
# Image pinned by digest (§9.3).
FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6

# The consolidator commits every write to the vault's own git repo (§5.7);
# without the binary each ingest parks in the retry queue.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Workspace install needs every package.json; sources are small, so copy the
# workspaces whole rather than choreographing per-package COPY layers.
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages ./packages
COPY adapters ./adapters
RUN bun install --frozen-lockfile --production

COPY deploy/compose/entrypoint.sh /app/deploy/compose/entrypoint.sh

# uid 1000, ships with the base image. /data is the volume; the host (or the
# smoke script) must make it writable by this uid.
USER bun

ENV NODE_ENV=production
EXPOSE 8090

ENTRYPOINT ["/app/deploy/compose/entrypoint.sh"]
