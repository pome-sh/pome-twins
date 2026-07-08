#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Boot entry (frozen contract: `node dist/src/server.js`, cwd = package
// root). Thin by design: read the env surface, open the db through the
// engine driver, load the boot seed, hand everything to the engine's
// `serve()`. Listens on :3333 (Vercel Sandbox port-forward target) and
// honors STRIPE_CLONE_HOST=0.0.0.0 in containerized envs.

import { TwinBootError, createRecorderStore, isLoopbackHost, serve } from "@pome-sh/sdk/server";
import { openTwinStripeDatabase } from "./db.js";
import { loadSeedFromEnv } from "./seed.js";
import { createStripeTwinDefinition } from "./twin.js";

const port = Number(process.env.PORT ?? process.env.STRIPE_CLONE_PORT ?? 3333);
const host = process.env.STRIPE_CLONE_HOST ?? "127.0.0.1";
const dbPath = process.env.STRIPE_CLONE_DB ?? ".stripe_clone/stripe.db";

// The engine's serve() enforces the same guard; checking here first keeps
// the refused boot from touching the filesystem (no db file is created).
if (!isLoopbackHost(host) && !process.env.TWIN_AUTH_SECRET) {
  throw new TwinBootError(
    `TWIN_AUTH_SECRET is required when a twin listens on a non-loopback host (${host}).`
  );
}

const startedAtMs = Date.now();
const db = openTwinStripeDatabase(dbPath);
// POME_SEED_JSON (FDRS-353) is strict-parsed: a malformed cloud seed fails
// the boot loudly instead of silently serving the default world. The
// engine's seed path installs `failure_injection` rules into the same store
// the session middleware reads (FDRS-369) — scenario 14's lost-response 402
// fires on the hosted path.
const seed = process.env.STRIPE_CLONE_NO_SEED === "1" ? undefined : loadSeedFromEnv();

const definition = createStripeTwinDefinition({
  db,
  // The x402 payment middleware settles against the twin's own REST API.
  twinBaseUrl: `http://127.0.0.1:${port}`,
  startedAtMs,
});

await serve(definition, {
  // Pre-port D-ENG-10 recorder bound: 10k events, drop-oldest, real counter.
  recorder: createRecorderStore({ maxEvents: 10_000 }),
  port,
  hostname: host,
  db,
  seed,
  runId: process.env.POME_RUN_ID ?? "spawn",
});

console.log(`Stripe twin listening at http://${host}:${port}`);
console.log(`REST: http://${host}:${port}`);
console.log(`MCP:  http://${host}:${port}/s/<sid>/mcp`);

if (process.env.NODE_ENV === "production" && !process.env.TWIN_ADMIN_TOKEN) {
  console.warn(
    "[twin-stripe] WARNING: NODE_ENV=production and TWIN_ADMIN_TOKEN is unset. " +
      "Admin endpoints fall back to loopback-only and reject unknown remoteAddress."
  );
}
