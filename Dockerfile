# Controlled target site for the SupaScraper self-healing demo.
#
# FALLBACK ONLY. The active deployment uses Render's native Node runtime, see
# render.yaml. This Dockerfile exists so the target can move to any container
# host without rework.
#
# Note: this image has never been built, because Docker is not installed on the
# development machine. Its individual assumptions were verified separately
# (workspace-scoped build, dev-dependency pruning), but the layer sequence is
# unproven. Build it locally before relying on it.

FROM node:22-alpine AS builder
WORKDIR /app

# Copy manifests first so dependency installation caches independently of source.
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/target-site/package.json ./apps/target-site/
COPY apps/supascraper/package.json ./apps/supascraper/

RUN npm ci

COPY packages ./packages
COPY apps ./apps

# Building the target workspace also builds its shared project reference.
RUN npm run build --workspace @supascraper/target-site \
    && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production
# /tmp is writable by the unprivileged runtime user. Scenario state is
# intentionally ephemeral: a restart returns the target to baseline.
ENV TARGET_STATE_PATH=/tmp/target-scenario.json

COPY --from=builder --chown=node:node /app ./

USER node
EXPOSE 3001

CMD ["node", "apps/target-site/dist/server.js"]
