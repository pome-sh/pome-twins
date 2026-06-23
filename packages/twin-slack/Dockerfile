# Build context is `packages/twin-slack/` (per workflow), so bun cannot see
# the monorepo root and treats this as a standalone project. We don't ship a
# committed lockfile here; the lockfile is regenerated on each rebuild and
# prod stability comes from the sha256 pin in pome-cloud's TWIN_IMAGE.
#
# `@pome-sh/shared-types` is a `workspace:*` dependency in `package.json` —
# bun cannot resolve workspaces in a Docker context that only has this
# package's own files. The workflow exposes the shared-types directory as
# an extra build context (`build-contexts: shared-types=packages/shared-types`)
# and we copy it in below as a local `file:` dependency before
# `bun install`.
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

FROM node:24-trixie-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV SLACK_CLONE_HOST=0.0.0.0
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 3333
CMD ["node", "dist/src/server.js"]
