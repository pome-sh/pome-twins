#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Twin-stripe entrypoint. Listens on :3333 (Vercel Sandbox port-forward
// target) and honors STRIPE_CLONE_HOST=0.0.0.0 in containerized envs.
import { serve } from "@hono/node-server";
import { createTwinStripeApp } from "./app.js";
import { openTwinStripeDatabase } from "./db.js";
import { applySeed, loadSeedFromEnv } from "./seed.js";
import { createFailureInjectionStore } from "./failure-injection.js";
import { createRecorder } from "./recorder.js";
import { StripeDomain } from "./domain/index.js";
import { registerStripeSessionRoutes } from "./session.js";
import { listTools } from "./tools.js";

const port = Number(process.env.PORT ?? process.env.STRIPE_CLONE_PORT ?? 3333);
const host = process.env.STRIPE_CLONE_HOST ?? "127.0.0.1";
const dbPath = process.env.STRIPE_CLONE_DB ?? ".stripe_clone/stripe.db";

if (!isLoopbackHost(host) && !process.env.TWIN_AUTH_SECRET) {
  throw new Error("TWIN_AUTH_SECRET is required when Stripe twin listens on a non-loopback host.");
}

const startedAtMs = Date.now();
const db = openTwinStripeDatabase(dbPath);
// FDRS-369: build the failure-injection store BEFORE the app so the
// env-supplied seed can install `failure_injection` rules into the same
// store the per-session router will read from. Without this hand-off,
// `applySeed(db, seed)` silently drops `seed.failure_injection` on the
// floor and hosted scenario 14 sees a clean 200 on the first refund
// instead of the FDRS-316 hero double-charge bug.
const failureInjection = createFailureInjectionStore();
if (process.env.STRIPE_CLONE_NO_SEED !== "1") {
  // Prefer the cloud-supplied seed (POME_SEED_JSON env, set by the
  // pome-cloud control-plane per FDRS-353). Falls back to defaultSeed()
  // when the env is absent (self-host / local dev).
  applySeed(db, loadSeedFromEnv(), failureInjection);
}

const recorder = createRecorder();
const runId = process.env.POME_RUN_ID ?? "spawn";
const domain = new StripeDomain(db);

const app = createTwinStripeApp({
  db,
  recorder,
  runId,
  startedAtMs,
  toolCount: listTools().length,
  failureInjection,
  extendSession: (session) => {
    return registerStripeSessionRoutes(session, {
      domain,
      recorder,
      runId,
      twinBaseUrl: `http://127.0.0.1:${port}`,
    });
  }
});

serve({ fetch: app.fetch, port, hostname: host });

console.log(`Stripe twin listening at http://${host}:${port}`);
console.log(`REST: http://${host}:${port}`);
console.log(`MCP:  http://${host}:${port}/s/<sid>/mcp`);

if (process.env.NODE_ENV === "production" && !process.env.TWIN_ADMIN_TOKEN) {
  console.warn(
    "[twin-stripe] WARNING: NODE_ENV=production and TWIN_ADMIN_TOKEN is unset. " +
      "Admin endpoints fall back to loopback-only and reject unknown remoteAddress."
  );
}

function isLoopbackHost(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}
