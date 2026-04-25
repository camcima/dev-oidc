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
# Bind to 0.0.0.0 so the published port is reachable from the host. Override
# --public-url at run time (e.g. `-e DEV_OIDC_PUBLIC_URL=http://host.docker.internal:8095 ...`)
# if relying parties resolve dev-oidc through a different name than they
# advertise via OIDC discovery.
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["start", "--config", "/config/config.json", "--host", "0.0.0.0"]
