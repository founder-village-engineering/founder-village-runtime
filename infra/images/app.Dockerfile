FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS build
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

# Export the host tools from the same target-platform dependency install and
# TypeScript build as the application. These files run directly on Ubuntu.
FROM build AS host-tools
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN mkdir /tools /release \
    && cp -a /usr/local/bin/node /app/node_modules /app/dist /tools/ \
    && rm -rf /tools/node_modules/.bin /tools/node_modules/@fv/admin-web /tools/dist/tests \
    && test -z "$(find /tools ! -type f ! -type d -print -quit)" \
    && cd /tools \
    && { printf 'node\0'; find dist node_modules -type f -print0 | LC_ALL=C sort -z; } > /tmp/runtime-files \
    && xargs -0 sha256sum --zero < /tmp/runtime-files > /release/runtime.sha256 \
    && tar --format=ustar --mtime=@0 --owner=0 --group=0 --numeric-owner --hard-dereference \
        -cf /release/runtime.tar --null -T /tmp/runtime-files

FROM scratch AS host-tools-export
COPY --from=host-tools /release/ /

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
