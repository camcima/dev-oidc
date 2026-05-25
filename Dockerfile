# syntax=docker/dockerfile:1.6
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json tsup.config.ts ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Default issuer URL when the operator hasn't passed --public-url explicitly.
# `--host 0.0.0.0` (in CMD) requires an explicit publicUrl, so without this
# env var the default container would refuse to start. Override at runtime
# (e.g. `-e DEV_OIDC_PUBLIC_URL=https://idp.example.com:8443`) when relying
# parties resolve dev-oidc through a different name than 0.0.0.0.
ENV DEV_OIDC_PUBLIC_URL=http://localhost:8095
# Auto-mkcert provisioning caches leaf certs at $XDG_CACHE_HOME/dev-oidc/certs.
# Anchoring it to /data ensures the cache persists when an operator mounts a
# volume at /data (the documented signing-key persistence path), so cert
# fingerprints stay stable across `docker compose down` / `up`.
ENV XDG_CACHE_HOME=/data

# mkcert is used for auto-provisioning TLS certs at startup. It reads the
# user's CAROOT (mounted from the host at /home/node/.local/share/mkcert)
# and signs leaves for the configured hostnames. Alpine 3.23 has no apk
# package for mkcert, so we download the official release binary. Pinned
# version, multi-arch via TARGETARCH (linux/amd64 + linux/arm64). ~5MB.
# The download is verified against a pinned per-arch SHA256 so a tampered or
# swapped release asset fails the build. Update both digests when bumping
# MKCERT_VERSION.
ARG TARGETARCH
ARG MKCERT_VERSION=v1.4.4
ARG MKCERT_SHA256_amd64=6d31c65b03972c6dc4a14ab429f2928300518b26503f58723e532d1b0a3bbb52
ARG MKCERT_SHA256_arm64=b98f2cc69fd9147fe4d405d859c57504571adec0d3611c3eefd04107c7ac00d0
RUN apk add --no-cache ca-certificates && \
    case "$TARGETARCH" in \
      amd64) expected="$MKCERT_SHA256_amd64" ;; \
      arm64) expected="$MKCERT_SHA256_arm64" ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac && \
    wget -qO /usr/local/bin/mkcert \
      "https://github.com/FiloSottile/mkcert/releases/download/${MKCERT_VERSION}/mkcert-${MKCERT_VERSION}-linux-${TARGETARCH}" && \
    echo "${expected}  /usr/local/bin/mkcert" | sha256sum -c - && \
    chmod +x /usr/local/bin/mkcert && \
    { /usr/local/bin/mkcert -version 2>/dev/null || /usr/local/bin/mkcert --help >/dev/null; }

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/dist ./dist
# Create /data (for file-backed signing key persistence) and give it to
# `node` so anonymous/named volumes mounted here are owned by the runtime
# user. Without this, mounting an empty volume at /data leaves it
# root-owned and the node process cannot write the signing key.
RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 8095
# Bind to 0.0.0.0 so the published port is reachable from the host. The CLI
# refuses to start when binding bind-all without an explicit publicUrl, so
# `DEV_OIDC_PUBLIC_URL` (set above) provides the default issuer URL. Override
# either env var or pass `--public-url` to CMD when integrating with a
# different name.
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["start", "--config", "/config/config.json", "--host", "0.0.0.0"]
