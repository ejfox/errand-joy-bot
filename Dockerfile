# errand-joy-bot gate. The relay is deployed separately (ops/relay-deploy.md).
# Build context excludes secrets and state via .dockerignore.
ARG DENO_VERSION=2.6.3
FROM denoland/deno:${DENO_VERSION}

WORKDIR /app
ENV DENO_DIR=/app/.deno-cache \
    NO_COLOR=1 \
    DRY_RUN=1 \
    DATA_DIR=/app/data \
    CONFIG_PATH=/app/config.toml

COPY deno.json deno.lock ./
COPY gate/ gate/
COPY ops/docker-entrypoint.sh ops/docker-entrypoint.sh

# Fetch every module at build time; the gate runs --cached-only and never fetches code.
RUN deno cache gate/main.ts \
 && mkdir -p /app/data \
 && chown -R deno:deno /app/data /app/.deno-cache

USER deno
ENTRYPOINT ["bash", "/app/ops/docker-entrypoint.sh"]
