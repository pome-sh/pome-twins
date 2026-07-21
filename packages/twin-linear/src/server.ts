#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { ensureTwinAuthSecret, resolveRecorderStore } from "@pome-sh/sdk/server";
import { openLinearTwinDatabase } from "./db.js";
import { loadSeedFromEnv } from "./seed.js";
import { createLinearTwinApp } from "./twin.js";
import { DEFAULT_LINEAR_PORT } from "./types.js";

const port = Number(process.env.PORT ?? process.env.LINEAR_TWIN_PORT ?? DEFAULT_LINEAR_PORT);
const host = process.env.LINEAR_TWIN_HOST ?? "127.0.0.1";
const dbPath = process.env.LINEAR_TWIN_DB ?? ".pome-data/linear/linear.db";

ensureTwinAuthSecret("linear", host);
const db = openLinearTwinDatabase(dbPath);
const seed = process.env.LINEAR_TWIN_NO_SEED === "1" ? undefined : loadSeedFromEnv();
const store = resolveRecorderStore();
const app = createLinearTwinApp({
  db,
  seed,
  recorder: store,
  runId: process.env.POME_RUN_ID ?? "spawn",
});

const { serve: nodeServe } = await import("@hono/node-server");
const server = await new Promise<ReturnType<typeof nodeServe>>((resolve) => {
  const bound = nodeServe({ fetch: app.fetch, port, hostname: host }, () => resolve(bound));
});

const close = async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err?: Error) => (err ? reject(err) : resolve()));
  });
  await store.flush?.();
  await store.close?.();
};
process.once("SIGINT", () => {
  void close().then(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void close().then(() => process.exit(0));
});

console.log(`Linear twin listening at http://${host}:${port}`);
console.log(`  GRAPHQL=http://${host}:${port}/graphql`);
console.log(`  TOKEN=lin_test_admin (default seed)`);
