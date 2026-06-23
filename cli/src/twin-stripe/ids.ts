// SPDX-License-Identifier: Apache-2.0
// Stripe ID generator — prefix-typed, base62 random suffix.
import { randomBytes } from "node:crypto";

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const ID_PREFIXES = {
  customer: "cus_",
  payment_method: "pm_",
  payment_intent: "pi_",
  charge: "ch_",
  refund: "re_",
  product: "prod_",
  price: "price_",
  setup_intent: "seti_",
  checkout_session: "cs_test_",
  webhook_endpoint: "we_",
  event: "evt_",
  shared_payment_issued: "spt_",
  shared_payment_granted: "spt_",
  profile: "profile_",
  balance_transaction: "txn_",
  // API keys are minted via api-keys.ts but the prefix lives here for parity.
  api_key: "sk_test_pome_",
  api_key_restricted: "rk_test_pome_"
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** Generate `count` characters of base62 randomness. */
export function randomBase62(count: number): string {
  // 1 byte = 256 values; 62 fits in 6 bits. Pull extra to mask cheaply.
  const buf = randomBytes(count * 2);
  let out = "";
  let i = 0;
  while (out.length < count && i < buf.length) {
    const byte = buf[i++]!;
    if (byte < 248) {
      // 248 = 4 * 62, modulo skew is uniform.
      out += BASE62[byte % 62];
    }
  }
  if (out.length < count) {
    // extremely unlikely fallback; recurse to fill.
    out += randomBase62(count - out.length);
  }
  return out;
}

/** Generate a Stripe-shaped id like `pi_3PqK...` (24 chars random suffix). */
export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}${randomBase62(24)}`;
}

/** Stripe-shaped client secret: `<piId>_secret_<24chars>`. */
export function newClientSecret(piId: string): string {
  return `${piId}_secret_${randomBase62(24)}`;
}

/** Generate an api key for a given session. `sk_test_pome_<24chars>`. */
export function newApiKey(): string {
  return newId("api_key");
}
