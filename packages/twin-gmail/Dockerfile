# Build context is the monorepo root so npm ci uses the committed workspace lock.
FROM node:24-bookworm@sha256:c35698d36238c69451c7e7a5951dd5c9b11c3e45884c918059c94c4a8be969b1 AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages packages
RUN npm ci
RUN npm run build:runtime -w @pome-sh/shared-types
RUN npm run build -w @pome-sh/sdk
RUN npm run build -w @pome-sh/twin-gmail
RUN rm -rf node_modules packages/*/node_modules \
  && npm ci --omit=dev -w @pome-sh/twin-gmail

FROM node:24-trixie-slim@sha256:9022946fb57e6fb6a2503931470deba4b49db02bfc8f587f93007fd33ef54415 AS runtime
WORKDIR /repo
ENV NODE_ENV=production
ENV GMAIL_TWIN_HOST=0.0.0.0
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/shared-types ./packages/shared-types
COPY --from=build /repo/packages/sdk/package.json ./packages/sdk/package.json
COPY --from=build /repo/packages/sdk/dist ./packages/sdk/dist
COPY --from=build /repo/packages/twin-gmail/package.json ./packages/twin-gmail/package.json
COPY --from=build /repo/packages/twin-gmail/dist ./packages/twin-gmail/dist
ARG GIT_SHA=dev
ARG BUILD_TIME=dev
ENV POME_TWIN_GIT_SHA=$GIT_SHA
ENV POME_TWIN_BUILD_TIME=$BUILD_TIME
EXPOSE 3336
CMD ["node", "packages/twin-gmail/dist/src/server.js"]
