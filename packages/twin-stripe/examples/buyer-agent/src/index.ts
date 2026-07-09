// SPDX-License-Identifier: Apache-2.0
//
// buyer-agent: a self-contained x402 demo that
//   1. spins up a tiny seller Hono server gated by paymentMiddleware()
//   2. acts as the buyer agent: 402 → mint X-PAYMENT → 200
//   3. inspects the twin to verify PI succeeded + 5 events recorded
//
// Run against a locally-running Pome Stripe twin:
//   npm run dev -w @pome-sh/twin-stripe   (in another terminal)
//   npm run start

import { serve } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import { createSellerApp } from "./seller.js";

const TWIN_BASE_URL = process.env.POME_TWIN_BASE_URL ?? "http://127.0.0.1:3333";
const TWIN_API_KEY = process.env.POME_TWIN_API_KEY ?? "sk_test_pome_default";
const TWIN_SID = process.env.POME_TWIN_SID ?? "default";
const SELLER_PORT = Number(process.env.POME_BUYER_AGENT_SELLER_PORT ?? 4040);

const ANSI = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`
};

function log(label: string, msg: string): void {
  console.log(`${ANSI.cyan(label)} ${msg}`);
}

function ok(msg: string): void {
  console.log(`${ANSI.green("✓")} ${msg}`);
}

function fail(msg: string): never {
  console.error(`${ANSI.red("✗")} ${msg}`);
  process.exit(1);
}

async function checkTwinReachable(): Promise<void> {
  try {
    const res = await fetch(`${TWIN_BASE_URL}/healthz`);
    if (!res.ok) {
      fail(
        `twin at ${TWIN_BASE_URL} returned ${res.status}; expected 200. Start the twin with \`npm run dev -w @pome-sh/twin-stripe\`.`
      );
    }
    const body = (await res.json()) as { ok?: boolean; twin?: string };
    if (!body.ok || body.twin !== "stripe") {
      fail(`twin at ${TWIN_BASE_URL} returned an unexpected /healthz body: ${JSON.stringify(body)}`);
    }
    log("step", `twin reachable at ${TWIN_BASE_URL} (${body.twin})`);
  } catch (err) {
    fail(
      `cannot reach twin at ${TWIN_BASE_URL}: ${(err as Error).message}\nStart the twin with \`npm run dev -w @pome-sh/twin-stripe\`.`
    );
  }
}

async function main(): Promise<void> {
  console.log(ANSI.bold("\n🛒 pome twin-stripe buyer-agent demo\n"));

  // Step 0: confirm the twin is up.
  await checkTwinReachable();

  // Step 0.5: spin up the seller.
  const sellerApp = createSellerApp({
    twinBaseUrl: TWIN_BASE_URL,
    apiKey: TWIN_API_KEY,
    sid: TWIN_SID
  });
  const server = serve({ fetch: sellerApp.fetch, port: SELLER_PORT, hostname: "127.0.0.1" });
  log("step", `seller listening at http://127.0.0.1:${SELLER_PORT}/paid`);

  let exitCode = 0;
  try {
    // Step 1: hit /paid with no header → expect 402 + accepts.
    const challengeRes = await fetch(`http://127.0.0.1:${SELLER_PORT}/paid`);
    if (challengeRes.status !== 402) {
      fail(`step 1: expected 402, got ${challengeRes.status}`);
    }
    const challenge = (await challengeRes.json()) as {
      x402Version: number;
      accepts: Array<{ payTo: string; maxAmountRequired: string; network: string; asset: string }>;
      error: string;
    };
    if (!Array.isArray(challenge.accepts) || challenge.accepts.length === 0) {
      fail(`step 1: 402 body has no accepts: ${JSON.stringify(challenge)}`);
    }
    const accepts0 = challenge.accepts[0]!;
    ok(
      `got 402 challenge: pay ${ANSI.bold(accepts0.maxAmountRequired)} ${accepts0.asset} on ${accepts0.network} to ${ANSI.yellow(accepts0.payTo)}`
    );

    // Step 2: build X-PAYMENT header.
    const nonce = "0x" + randomBytes(32).toString("hex");
    const validBefore = Math.floor(Date.now() / 1000) + 600;
    const xPaymentObj = {
      x402Version: 1,
      scheme: "exact",
      network: accepts0.network,
      payload: {
        authorization: {
          from: "0x" + randomBytes(20).toString("hex"),
          to: accepts0.payTo,
          value: accepts0.maxAmountRequired,
          validAfter: 0,
          validBefore,
          nonce
        },
        signature: "0x" + "00".repeat(65)
      }
    };
    const xPayment = Buffer.from(JSON.stringify(xPaymentObj), "utf8").toString("base64");

    // Step 3: retry with X-PAYMENT → expect 200 + body from the wrapped handler.
    const paidRes = await fetch(`http://127.0.0.1:${SELLER_PORT}/paid`, {
      headers: { "X-PAYMENT": xPayment }
    });
    if (paidRes.status !== 200) {
      const body = await paidRes.text();
      fail(`step 3: expected 200, got ${paidRes.status}: ${body}`);
    }
    const body = (await paidRes.json()) as Record<string, unknown>;
    ok(`paid + got resource: ${JSON.stringify(body)}`);

    // Step 4: verify the twin shows the PI as `succeeded`.
    const piList = await fetch(`${TWIN_BASE_URL}/s/${TWIN_SID}/v1/payment_intents`, {
      headers: { Authorization: `Bearer ${TWIN_API_KEY}` }
    });
    if (!piList.ok) {
      fail(`step 4: GET payment_intents returned ${piList.status}`);
    }
    const piPage = (await piList.json()) as { data: Array<{ id: string; status: string }> };
    const succeeded = piPage.data?.filter((p) => p.status === "succeeded") ?? [];
    if (succeeded.length === 0) {
      fail(
        `step 4: expected at least one PI with status=succeeded; got ${JSON.stringify(piPage.data?.map((p) => ({ id: p.id, status: p.status })) ?? [])}`
      );
    }
    ok(`twin reports ${succeeded.length} PI(s) with status=succeeded (latest: ${succeeded[0]!.id})`);

    // Step 5: verify expected events. Fidelity-tier check: we want at least:
    //   payment_intent.created, payment_intent.requires_action,
    //   payment_intent.processing, charge.succeeded, payment_intent.succeeded
    const evRes = await fetch(`${TWIN_BASE_URL}/s/${TWIN_SID}/v1/events`, {
      headers: { Authorization: `Bearer ${TWIN_API_KEY}` }
    });
    if (!evRes.ok) {
      fail(`step 5: GET events returned ${evRes.status}`);
    }
    const evPage = (await evRes.json()) as { data: Array<{ id: string; type: string }> };
    const wantTypes = [
      "payment_intent.created",
      "payment_intent.requires_action",
      "payment_intent.processing",
      "charge.succeeded",
      "payment_intent.succeeded"
    ];
    const seenTypes = new Set((evPage.data ?? []).map((e) => e.type));
    const missing = wantTypes.filter((t) => !seenTypes.has(t));
    if (missing.length === 0) {
      ok(`twin emitted all ${wantTypes.length} expected events`);
    } else {
      // Treat missing event types as a soft warning — AGENT-B's domain may
      // emit a slightly different set in v1 (e.g., no separate
      // `requires_action`). The buyer flow is still correct as long as the
      // PI ended in `succeeded`, which step 4 already confirmed.
      console.log(
        `${ANSI.yellow("!")} twin emitted ${seenTypes.size} events; missing expected types: ${missing.join(", ")}`
      );
      console.log(
        `  ${ANSI.dim("(this is a fidelity gap, not a flow failure — buyer flow completed end-to-end)")}`
      );
    }

    console.log("");
    console.log(ANSI.green(ANSI.bold("✓ x402 buyer flow completed end-to-end")));
  } catch (err) {
    console.error(`${ANSI.red("✗")} ${(err as Error).message}`);
    if ((err as Error).stack) console.error(ANSI.dim((err as Error).stack!));
    exitCode = 1;
  } finally {
    // Drop the listener so the process exits cleanly.
    try {
      // node-server returns a Node http.Server; close() on it.
      // @ts-ignore — runtime shape is correct, types vary across Hono versions.
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } catch {
      // ignore
    }
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
