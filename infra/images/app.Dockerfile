FROM node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY services/admin-web/package.json services/admin-web/package.json
RUN npm ci
COPY config/applications.json config/frontends.json config/
COPY packages packages
COPY services services
COPY scripts scripts
COPY tests tests
# Solana's optional typing peer can keep the native compiler after npm prune.
RUN npm run build && npm prune --omit=dev \
    && rm -rf node_modules/typescript node_modules/@typescript/typescript-linux-*
FROM cgr.dev/chainguard/glibc-dynamic:latest@sha256:838b58dceeba88a5dc8b088bca1a2e1e8e26ebe88d5e23a87137de09cc910e61
ARG FV_REVISION=local
LABEL org.opencontainers.image.revision=${FV_REVISION}
ENV NODE_ENV=production
ENV PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp
WORKDIR /app
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build --chown=65532:65532 /app/dist dist
COPY --from=build --chown=65532:65532 /app/node_modules node_modules
COPY --from=build --chown=65532:65532 /app/services/admin-web/dist services/admin-web/dist
COPY package.json ./
COPY config/local-domains.json config/local-domains.json
COPY database database
COPY hasura hasura
USER 65532:65532
HEALTHCHECK --interval=15s --timeout=3s CMD ["node", "dist/scripts/healthcheck.js"]
CMD ["node","dist/services/api/main.js"]
