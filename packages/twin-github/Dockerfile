# Build context is the monorepo root. This lets the image use the committed
# workspace lockfile with npm ci instead of resolving dependencies from a
# standalone package context.
FROM node:24-bookworm@sha256:c35698d36238c69451c7e7a5951dd5c9b11c3e45884c918059c94c4a8be969b1 AS build
WORKDIR /repo
# better-sqlite3 is a native module that node-gyp must compile; the slim
# runtime image lacks a C++ toolchain, so compile in this build stage.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages packages
RUN npm ci
RUN npm run build:runtime -w @pome-sh/shared-types
# The twin imports `@pome-sh/sdk/server`, resolved from the SDK's built dist.
RUN npm run build -w @pome-sh/sdk
RUN npm run build -w @pome-sh/twin-github
# The runtime image should not include dev/test tooling or unrelated workspace
# deps. Reinstall only this twin's production graph (plus workspace deps it
# links: sdk, shared-types) — not every packages/* workspace.
RUN rm -rf node_modules packages/*/node_modules \
  && npm ci --omit=dev -w @pome-sh/twin-github

FROM node:24-trixie-slim@sha256:9022946fb57e6fb6a2503931470deba4b49db02bfc8f587f93007fd33ef54415 AS runtime
WORKDIR /repo
ENV NODE_ENV=production
ENV GITHUB_CLONE_HOST=0.0.0.0
# Runtime only executes `node`; npm/npx from the base image add unused packages
# (and their CVE surface) to the scanned image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/shared-types ./packages/shared-types
# The twin's dist imports `@pome-sh/sdk`; ship the SDK's built output so the
# workspace symlink in node_modules resolves at runtime.
COPY --from=build /repo/packages/sdk/package.json ./packages/sdk/package.json
COPY --from=build /repo/packages/sdk/dist ./packages/sdk/dist
COPY --from=build /repo/packages/twin-github/package.json ./packages/twin-github/package.json
COPY --from=build /repo/packages/twin-github/dist ./packages/twin-github/dist
EXPOSE 3333
CMD ["node", "packages/twin-github/dist/src/server.js"]
