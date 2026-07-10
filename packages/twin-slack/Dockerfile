# Build context is the monorepo root. This lets the image use the committed
# workspace lockfile with npm ci instead of resolving dependencies from a
# standalone package context.
FROM node:24-bookworm@sha256:c35698d36238c69451c7e7a5951dd5c9b11c3e45884c918059c94c4a8be969b1 AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages packages
RUN npm ci
RUN npm run build:runtime -w @pome-sh/shared-types
# The twin imports `@pome-sh/sdk/server`, resolved from the SDK's built dist.
RUN npm run build -w @pome-sh/sdk
RUN npm run build -w @pome-sh/twin-slack
# The runtime image should not include dev/test tooling or unrelated workspace
# deps. Reinstall only this twin's production graph (plus workspace deps it
# links: sdk, shared-types) — not every packages/* workspace.
RUN rm -rf node_modules packages/*/node_modules \
  && npm ci --omit=dev -w @pome-sh/twin-slack

FROM node:24-trixie-slim@sha256:9022946fb57e6fb6a2503931470deba4b49db02bfc8f587f93007fd33ef54415 AS runtime
WORKDIR /repo
ENV NODE_ENV=production
ENV SLACK_CLONE_HOST=0.0.0.0
# Runtime only executes `node`; npm/npx from the base image add unused packages
# (and their CVE surface) to the scanned image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/shared-types ./packages/shared-types
# The twin's dist imports `@pome-sh/sdk`; ship the SDK's built output so the
# workspace symlink in node_modules resolves at runtime.
COPY --from=build /repo/packages/sdk/package.json ./packages/sdk/package.json
COPY --from=build /repo/packages/sdk/dist ./packages/sdk/dist
COPY --from=build /repo/packages/twin-slack/package.json ./packages/twin-slack/package.json
COPY --from=build /repo/packages/twin-slack/dist ./packages/twin-slack/dist
# Bake build provenance into the /healthz `runtime` block (read by the sdk's
# build-info env surface). CI passes the real values; local builds keep the
# "dev" markers. Placed after the COPY layers so a new SHA never invalidates
# the copied-artifact cache.
ARG GIT_SHA=dev
ARG BUILD_TIME=dev
ENV POME_TWIN_GIT_SHA=$GIT_SHA
ENV POME_TWIN_BUILD_TIME=$BUILD_TIME
EXPOSE 3333
CMD ["node", "packages/twin-slack/dist/src/server.js"]
