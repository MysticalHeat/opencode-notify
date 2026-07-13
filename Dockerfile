FROM node:22-alpine AS base
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
COPY turbo.json .
COPY tsconfig.base.json .
COPY eslint.config.js .
COPY packages packages/
COPY apps apps/
RUN npm ci
RUN npm run build
RUN npm pack --workspace packages/opencode-plugin

FROM base AS run
COPY --from=build /app/packages/opencode-plugin/opencode-notify-*.tgz /tmp/
RUN echo "Placeholder — full deployment image defined in Task 14"
LABEL org.opencontainers.image.source="https://github.com/nomli/opencode-notify"
