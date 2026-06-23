// SPDX-License-Identifier: Apache-2.0
//
// In-process stub of the Pome Stripe twin's HTTP surface, narrowed to the
// subset paymentMiddleware() uses:
//
//   POST /s/<sid>/v1/payment_intents
//   GET  /s/<sid>/v1/payment_intents/:id
//   POST /s/<sid>/v1/test_helpers/payment_intents/:id/simulate_crypto_deposit
//
// This lets test/x402*.test.ts run before AGENT-B's real domain lands. When
// AGENT-B's PI domain ships, swap the stub for a real twin in app form (no
// changes to the middleware).

import { randomBytes } from "node:crypto";

type StubPI = {
  id: string;
  amount: number;
  currency: string;
  status: "requires_payment_method" | "requires_action" | "processing" | "succeeded";
  payment_method_types: string[];
  next_action: {
    type: "display_crypto_deposit_address";
    crypto_display_details: {
      deposit_addresses: Record<string, { address: string }>;
    };
  } | null;
  metadata: Record<string, string>;
  created: number;
  charges_count: number;
};

export type TwinStub = {
  fetch: typeof fetch;
  state: {
    payment_intents: Map<string, StubPI>;
    /** Total `simulate_crypto_deposit` invocations across the suite. */
    simulate_calls: number;
    /** Charge rows minted (1 per successful settlement). */
    charges: Array<{ id: string; payment_intent_id: string; amount: number }>;
  };
};

const HEX_CHARSET = "0123456789abcdef";

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function newPiId(): string {
  return `pi_${randomHex(12)}`;
}

function newAddress(): string {
  // 20-byte 0x-prefixed address.
  let s = "0x";
  for (let i = 0; i < 40; i++) {
    s += HEX_CHARSET[Math.floor(Math.random() * 16)];
  }
  return s;
}

export function makeTwinStub(): TwinStub {
  const state: TwinStub["state"] = {
    payment_intents: new Map(),
    simulate_calls: 0,
    charges: []
  };

  const stubFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();
    const u = new URL(url);
    const path = u.pathname;

    // POST /s/<sid>/v1/payment_intents
    const piCreate = path.match(/^\/s\/[^/]+\/v1\/payment_intents$/);
    if (piCreate && method === "POST") {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const id = newPiId();
      const networks: string[] =
        body.payment_method_options?.crypto?.deposit_options?.networks ?? ["base"];
      const deposit_addresses: Record<string, { address: string }> = {};
      for (const n of networks) {
        deposit_addresses[n] = { address: newAddress() };
      }
      const pi: StubPI = {
        id,
        amount: Number(body.amount ?? 0),
        currency: String(body.currency ?? "usd"),
        status: "requires_action",
        payment_method_types: body.payment_method_types ?? [],
        next_action: {
          type: "display_crypto_deposit_address",
          crypto_display_details: { deposit_addresses }
        },
        metadata: body.metadata ?? {},
        created: Math.floor(Date.now() / 1000),
        charges_count: 0
      };
      state.payment_intents.set(id, pi);
      return jsonResponse(200, {
        id: pi.id,
        object: "payment_intent",
        amount: pi.amount,
        currency: pi.currency,
        status: pi.status,
        payment_method_types: pi.payment_method_types,
        next_action: pi.next_action,
        metadata: pi.metadata,
        created: pi.created
      });
    }

    // GET /s/<sid>/v1/payment_intents/:id
    const piGet = path.match(/^\/s\/[^/]+\/v1\/payment_intents\/([^/]+)$/);
    if (piGet && method === "GET") {
      const id = decodeURIComponent(piGet[1]!);
      const pi = state.payment_intents.get(id);
      if (!pi) return jsonResponse(404, { error: { code: "resource_missing" } });
      return jsonResponse(200, serializePi(pi));
    }

    // POST /s/<sid>/v1/test_helpers/payment_intents/:id/simulate_crypto_deposit
    const piSettle = path.match(
      /^\/s\/[^/]+\/v1\/test_helpers\/payment_intents\/([^/]+)\/simulate_crypto_deposit$/
    );
    if (piSettle && method === "POST") {
      const id = decodeURIComponent(piSettle[1]!);
      const pi = state.payment_intents.get(id);
      if (!pi) return jsonResponse(404, { error: { code: "resource_missing" } });
      state.simulate_calls += 1;
      if (pi.status === "succeeded") {
        // Real Stripe returns 400 for double-settle; we surface a soft error
        // the middleware knows to recover from.
        return jsonResponse(400, {
          error: { type: "invalid_request_error", code: "payment_intent_already_succeeded" }
        });
      }
      pi.status = "succeeded";
      pi.charges_count += 1;
      pi.next_action = null;
      state.charges.push({
        id: `ch_${randomHex(12)}`,
        payment_intent_id: pi.id,
        amount: pi.amount
      });
      return jsonResponse(200, serializePi(pi));
    }

    return jsonResponse(404, {
      error: { type: "invalid_request_error", code: "stub_not_implemented", path, method }
    });
  };

  return { fetch: stubFetch, state };
}

function serializePi(pi: StubPI): Record<string, unknown> {
  return {
    id: pi.id,
    object: "payment_intent",
    amount: pi.amount,
    currency: pi.currency,
    status: pi.status,
    payment_method_types: pi.payment_method_types,
    next_action: pi.next_action,
    metadata: pi.metadata,
    created: pi.created
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
