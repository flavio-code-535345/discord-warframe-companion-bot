# syntax=docker/dockerfile:1

# Compile on the runner's native platform: the output is plain JS and every runtime
# dependency is pure JS, so the same node_modules works on amd64 and arm64.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    HTTP_PORT=3000
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY assets ./assets
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${HTTP_PORT}/health" >/dev/null || exit 1
CMD ["node", "dist/index.js"]
