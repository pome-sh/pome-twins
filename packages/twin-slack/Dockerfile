# Build context is the monorepo root. This lets the image use the committed
# workspace lockfile with --frozen-lockfile instead of resolving dependencies
# from a standalone package context.
FROM oven/bun:1@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4b AS build
WORKDIR /repo
# better-sqlite3 is a native module that node-gyp must compile; the oven/bun
# base image is slim and lacks a C++ toolchain by default.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
COPY packages packages
RUN bun install --frozen-lockfile
RUN bun run --cwd packages/twin-slack build

FROM node:24-trixie-slim@sha256:9022946fb57e6fb6a2503931470deba4b49db02bfc8f587f93007fd33ef54415 AS runtime
WORKDIR /repo
ENV NODE_ENV=production
ENV SLACK_CLONE_HOST=0.0.0.0
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/shared-types ./packages/shared-types
COPY --from=build /repo/packages/twin-slack/package.json ./packages/twin-slack/package.json
COPY --from=build /repo/packages/twin-slack/dist ./packages/twin-slack/dist
EXPOSE 3333
CMD ["node", "packages/twin-slack/dist/src/server.js"]
