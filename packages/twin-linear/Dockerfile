# Build context is the monorepo root so npm ci uses the committed workspace lock.
FROM node:26-bookworm@sha256:219fc9da91e7f29a9f32290ff598cdf8886fd68f421ff515c8f93434da39a271 AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages packages
RUN npm ci
RUN npm run build:runtime -w @pome-sh/shared-types
RUN npm run build -w @pome-sh/sdk
RUN npm run build -w @pome-sh/twin-linear
RUN rm -rf node_modules packages/*/node_modules \
  && npm ci --omit=dev -w @pome-sh/twin-linear

FROM node:26-trixie-slim@sha256:715e55e4b84e4bb0ff48e49b398a848f08e55daed8eb6a0ea1839ae53bc57583 AS runtime
WORKDIR /repo
ENV NODE_ENV=production
ENV LINEAR_TWIN_HOST=0.0.0.0
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/shared-types ./packages/shared-types
COPY --from=build /repo/packages/sdk/package.json ./packages/sdk/package.json
COPY --from=build /repo/packages/sdk/dist ./packages/sdk/dist
COPY --from=build /repo/packages/twin-linear/package.json ./packages/twin-linear/package.json
COPY --from=build /repo/packages/twin-linear/dist ./packages/twin-linear/dist
ARG GIT_SHA=dev
ARG BUILD_TIME=dev
ENV POME_TWIN_GIT_SHA=$GIT_SHA
ENV POME_TWIN_BUILD_TIME=$BUILD_TIME
EXPOSE 3337
CMD ["node", "packages/twin-linear/dist/src/server.js"]
