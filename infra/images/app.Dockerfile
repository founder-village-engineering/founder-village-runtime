FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY services/admin-web/package.json services/admin-web/package.json
RUN npm ci
COPY packages packages
COPY services services
COPY scripts scripts
COPY tests tests
RUN npm run build && npm prune --omit=dev
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:cb87acc574abe719b6e5c547384defa2f7b1f24af9605d3f618cf852495d8be2
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
COPY config/applications.json config/frontends.json dist/config/
COPY config/local-domains.json config/local-domains.json
COPY database database
COPY hasura hasura
USER 65532:65532
HEALTHCHECK --interval=15s --timeout=3s CMD ["node", "dist/scripts/healthcheck.js"]
CMD ["node","dist/services/api/main.js"]
