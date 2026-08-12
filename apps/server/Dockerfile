FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY turbo.json tsconfig.base.json eslint.config.js ./
COPY packages/ packages/
COPY apps/ apps/
RUN npm ci
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
RUN apk add --no-cache tini curl
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app
COPY --from=build --chown=appuser:appgroup /app/node_modules node_modules
COPY --from=build --chown=appuser:appgroup /app/apps/server/dist apps/server/dist
COPY --from=build --chown=appuser:appgroup /app/apps/server/migrations apps/server/migrations
COPY --from=build --chown=appuser:appgroup /app/apps/server/scripts apps/server/scripts
COPY --from=build --chown=appuser:appgroup /app/apps/server/package.json apps/server/package.json
COPY --from=build --chown=appuser:appgroup /app/packages/core/dist packages/core/dist
COPY --from=build --chown=appuser:appgroup /app/packages/core/package.json packages/core/package.json
COPY --from=build --chown=appuser:appgroup /app/packages/protocol/dist packages/protocol/dist
COPY --from=build --chown=appuser:appgroup /app/packages/protocol/package.json packages/protocol/package.json
RUN mkdir -p /data && chown appuser:appgroup /data
USER appuser
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/opencode-notify.db
ENV SERVER_HOST=0.0.0.0
ENV SERVER_PORT=3000
EXPOSE 3000
VOLUME /data
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:${SERVER_PORT}/health/ready || exit 1
ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/server/dist/index.js"]
