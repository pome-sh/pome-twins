# Build context is the monorepo root. This lets the image use the committed
# workspace lockfile with --frozen-lockfile instead of resolving dependencies
# from a standalone package context.
FROM oven/bun:1@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
WORKDIR /repo
# better-sqlite3 is a native module that node-gyp must compile; the oven/bun
# base image is slim and lacks a C++ toolchain by default.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
COPY packages packages
RUN bun install --frozen-lockfile
RUN bun run --cwd packages/shared-types build:runtime
RUN bun run --cwd packages/twin-stripe build
# The runtime image should not include dev/test tooling or unrelated workspace
# deps. Reinstall only this twin's production graph after the build, hoisted to
# the root node_modules layout used by the runtime stage.
RUN rm -rf node_modules packages/*/node_modules \
  && bun install --frozen-lockfile --production --omit=peer --filter @pome-sh/twin-stripe --linker=hoisted

# Runtime is node, not bun: better-sqlite3's native binding is not yet
# supported under bun (https://github.com/oven-sh/bun/issues/4290), so the
# image must ship a real node to load the .node binary. Node 24 trixie matches
# the NODE_MODULE_VERSION and glibc used by the build stage.
FROM node:24-trixie-slim@sha256:9022946fb57e6fb6a2503931470deba4b49db02bfc8f587f93007fd33ef54415 AS runtime
WORKDIR /repo
ENV NODE_ENV=production
ENV STRIPE_CLONE_HOST=0.0.0.0
# Runtime only executes `node`; npm/npx from the base image add unused packages
# (and their CVE surface) to the scanned image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/shared-types ./packages/shared-types
COPY --from=build /repo/packages/twin-stripe/package.json ./packages/twin-stripe/package.json
COPY --from=build /repo/packages/twin-stripe/dist ./packages/twin-stripe/dist
EXPOSE 3333
CMD ["node", "packages/twin-stripe/dist/src/server.js"]
