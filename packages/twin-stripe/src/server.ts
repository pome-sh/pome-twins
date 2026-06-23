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
import { registerStripeRoutes } from "./routes/index.js";
import { listTools } from "./tools.js";
import type { ResolvedSession } from "./types.js";
import { paymentMiddleware } from "./x402.js";

const port = Number(process.env.PORT ?? process.env.STRIPE_CLONE_PORT ?? 3333);
const host = process.env.STRIPE_CLONE_HOST ?? "127.0.0.1";
const dbPath = process.env.STRIPE_CLONE_DB ?? ".stripe_clone/stripe.db";

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
    registerStripeRoutes(session, domain, recorder, runId);
    session.use(
      paymentMiddleware(
        {
          "GET /x402/protected-resource": {
            accepts: [
              {
                scheme: "exact",
                price: "$0.01",
                network: "eip155:84532",
                description: "Unlock the hosted Stripe x402 protected resource"
              }
            ],
            description: "Hosted Stripe x402 protected resource",
            mimeType: "application/json"
          }
        },
        {
          twinBaseUrl: `http://127.0.0.1:${port}`,
          sid: (c) => {
            const sess = c.get("session") as ResolvedSession | undefined;
            return sess?.sid ?? "default";
          },
          apiKey: (c) => {
            const header = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
            return header.replace(/^bearer\s+/i, "");
          }
        }
      )
    );
    session.get("/x402/protected-resource", (c) =>
      c.json({
        ok: true,
        resource: "stripe-x402-protected-resource",
        message: "Payment verified by the Stripe twin."
      })
    );
    return {
      stateProvider: (_c, sess: ResolvedSession | undefined) => {
        if (!sess) {
          return { payment_intents: [], charges: [], balance_transactions: [], events: [] };
        }
        return domain.exportState(sess.account_id);
      }
    };
  }
});

serve({ fetch: app.fetch, port, hostname: host });

console.log(`Stripe twin listening at http://${host}:${port}`);
console.log(`REST: http://${host}:${port}`);
console.log(`MCP:  http://${host}:${port}/s/<sid>/mcp`);
