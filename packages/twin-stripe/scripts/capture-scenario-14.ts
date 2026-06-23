// SPDX-License-Identifier: Apache-2.0
//
// FDRS-340: capture the real `events.jsonl` for scenario 14
// (stripe-refund-retry double-charge bug) and overwrite the hand-crafted
// `expected-events.jsonl` fixture shipped with FDRS-316's PR #33.
//
// We boot twin-stripe in-process via the same wiring server.ts uses, seed
// the `failure_injection` rule from scenario 14's `.md`, drive the agent-
// perspective HTTP flow (two POST /v1/refunds + one GET /v1/charges/:id),
// then read the recorder buffer via `GET /_pome/events` and serialize the
// agent-perspective slice to JSONL.
//
// Setup calls (PI create + simulate_crypto_deposit) are filtered out — the
// scenario .md treats those as pre-seeded state. The published `.md` seed
// block declares `payment_intents` + `charges` which the twin's seed schema
// (`api_keys` + `failure_injection` only) doesn't yet accept; until that
// gap closes, the script drives the API to mint them and filters the noise
// after capture.

import { createTwinStripeApp } from "../src/app.js";
import { openTwinStripeDatabase } from "../src/db.js";
import { StripeDomain } from "../src/domain/index.js";
import { createRecorder } from "../src/recorder.js";
import { registerStripeRoutes } from "../src/routes/index.js";
import { applySeed, defaultSeed } from "../src/seed.js";
import { listTools } from "../src/tools.js";
import type { ResolvedSession } from "../src/types.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUN_ID = "m0-1-refund-retry";
const API_KEY = "sk_test_pome_default";
const SID = "default";

const db = openTwinStripeDatabase(":memory:");
applySeed(db, defaultSeed());

const recorder = createRecorder();
const domain = new StripeDomain(db);

const app = createTwinStripeApp({
  db,
  recorder,
  runId: RUN_ID,
  toolCount: listTools().length,
  noSeed: true,
  extendSession: (session) => {
    registerStripeRoutes(session, domain, recorder, RUN_ID);
    return {
      stateProvider: (_c, sess: ResolvedSession | undefined) => {
        if (!sess) {
          return {
            payment_intents: [],
            charges: [],
            balance_transactions: [],
            events: [],
          };
        }
        return domain.exportState(sess.account_id);
      },
    };
  },
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  authed = true
): Promise<{ status: number; body: any }> {
  const headers = new Headers();
  if (authed) headers.set("Authorization", `Bearer ${API_KEY}`);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  const res = await app.request(path, init);
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text.length === 0 ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

// `/admin/seed` calls resetDatabase first (per pome-routes.ts), so we must
// re-include the default api key alongside the failure-injection rule or the
// subsequent authenticated calls 401.
const seedRes = await call(
  "POST",
  "/admin/seed",
  {
    api_keys: [{ key: API_KEY, sid: SID, account_id: `acct_${SID}` }],
    failure_injection: [
      {
        method: "POST",
        path: "/v1/refunds",
        attempt: 1,
        mode: "after_handler",
        status: 402,
        body: {
          error: {
            type: "card_error",
            code: "card_declined",
            message:
              "Simulated lost-response failure: refund persisted server-side, but response delivery to the client failed.",
          },
        },
      },
    ],
  },
  false
);
if (seedRes.status !== 200) {
  throw new Error(`seed failed: ${seedRes.status} ${JSON.stringify(seedRes.body)}`);
}

const pi = await call("POST", `/s/${SID}/v1/payment_intents`, {
  amount: 20000,
  currency: "usd",
  payment_method_types: ["crypto"],
  payment_method_options: {
    crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
  },
});
if (pi.status !== 200) {
  throw new Error(`payment_intents create failed: ${pi.status} ${JSON.stringify(pi.body)}`);
}
const settle = await call(
  "POST",
  `/s/${SID}/v1/test_helpers/payment_intents/${pi.body.id}/simulate_crypto_deposit`
);
if (settle.status !== 200) {
  throw new Error(`simulate_crypto_deposit failed: ${settle.status} ${JSON.stringify(settle.body)}`);
}
const chargeId = settle.body.latest_charge as string;

// Agent flow — exactly what scenario 14 prescribes.
const r1 = await call("POST", `/s/${SID}/v1/refunds`, { charge: chargeId, amount: 7500 });
if (r1.status !== 402) {
  throw new Error(`expected first refund to be 402 (after_handler injection), got ${r1.status}`);
}
const r2 = await call("POST", `/s/${SID}/v1/refunds`, { charge: chargeId, amount: 7500 });
if (r2.status !== 200) {
  throw new Error(`expected retry to succeed, got ${r2.status}: ${JSON.stringify(r2.body)}`);
}
const cg = await call("GET", `/s/${SID}/v1/charges/${chargeId}`);
if (cg.status !== 200) {
  throw new Error(`GET /v1/charges failed: ${cg.status}`);
}
if (cg.body.amount_refunded !== 15000) {
  throw new Error(
    `expected amount_refunded=15000 (double-refund bug), got ${cg.body.amount_refunded}`
  );
}

const evRes = await call("GET", `/s/${SID}/_pome/events`);
if (evRes.status !== 200) {
  throw new Error(`fetch /_pome/events failed: ${evRes.status}`);
}
const all = evRes.body as Array<Record<string, unknown>>;
const agentSlice = all.filter((e) => {
  const m = e.method as string;
  const p = e.path as string;
  if (m === "POST" && p.endsWith("/v1/refunds")) return true;
  if (m === "GET" && /\/v1\/charges\/ch_/.test(p)) return true;
  return false;
});

if (agentSlice.length !== 3) {
  throw new Error(
    `expected exactly 3 agent-perspective events (2 POST /v1/refunds + 1 GET /v1/charges/:id), got ${agentSlice.length}`
  );
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const outPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(__dirname, "../../correlator/test/fixtures/stripe-refund-retry.expected-events.jsonl");
const out = agentSlice.map((e) => JSON.stringify(e)).join("\n") + "\n";
writeFileSync(outPath, out, "utf8");

console.log(`captured ${agentSlice.length} events → ${outPath}`);
console.log(
  `  charge: ${chargeId}, amount_refunded: ${cg.body.amount_refunded}, statuses: ${agentSlice
    .map((e) => e.status)
    .join(", ")}`
);
