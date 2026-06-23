# Build context is `packages/twin-stripe/` (per workflow), so bun cannot see
# the monorepo root and treats this as a standalone project. We don't ship a
# committed lockfile here; the lockfile is regenerated on each rebuild and
# prod stability comes from the sha256 pin in pome-cloud's TWIN_IMAGE.
#
# `@pome-sh/shared-types` — vendored via workflow build-context; see twin-github
# Dockerfile for the full workspace:* rewrite pattern.
FROM oven/bun:1 AS build
WORKDIR /app
# better-sqlite3 is a native module that node-gyp must compile; the oven/bun
# base image is slim and lacks a C++ toolchain by default.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY --from=shared-types . ./vendor/shared-types
COPY package.json ./
RUN sed -i 's|"@pome-sh/shared-types": "workspace:\*"|"@pome-sh/shared-types": "file:./vendor/shared-types"|' package.json
RUN bun install
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts
COPY examples ./examples
RUN bun run build

# Runtime is node, not bun: better-sqlite3's native binding is not yet
# supported under bun (https://github.com/oven-sh/bun/issues/4290), so the
# image must ship a real node to load the .node binary. Two pins matter:
# - trixie-slim, to match the Debian/glibc the bun build stage links against
#   (node:24-slim a.k.a. bookworm ships glibc 2.36; bun-built bindings need
#   glibc 2.38 from trixie).
# - node 24, to match the NODE_MODULE_VERSION (137) that bun's node-compat
#   layer compiles native modules against. Node 22 (127) would refuse the
#   pre-built binding.
FROM node:24-trixie-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV STRIPE_CLONE_HOST=0.0.0.0
# Copy already-built node_modules (incl. better-sqlite3 native binary) from
# the build stage instead of re-running install, which would trigger another
# node-gyp compile in the slim runtime image. The image keeps devDependencies
# for now (~100MB extra); pruning is a follow-up.
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 3333
CMD ["node", "dist/src/server.js"]
