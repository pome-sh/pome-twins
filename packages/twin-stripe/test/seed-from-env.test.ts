// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the boot-time seed loader `loadSeedFromEnv`. Lives at
// `packages/twin-stripe/src/seed.ts`; the twin server (`server.ts`)
// calls it on startup so a cloud spawn that sets `POME_SEED_JSON` boots
// the Stripe domain from the CLI-supplied scenario seed rather than the
// hard-coded `defaultSeed()`.
//
// FDRS-369: twin-stripe was silently ignoring the env-supplied seed at
// boot (twin-github had this for FDRS-353, twin-stripe never wired it
// in), so hosted Stripe scenarios saw an empty world. This test mirrors
// `packages/twin-github/test/seed-from-env.test.ts` and additionally
// pins the unwrap contract decided in FDRS-365: twin-stripe peels
// `body.stripe?.seed ?? body`, so both the canonical wrapped shape
// (`{ stripe: { seed: {...} } }`) and the flat shape boot the same DB.

import { describe, expect, it } from "vitest";
import { defaultSeed, loadSeedFromEnv } from "../src/seed.js";

// Scenario 14 prerequisite state: one settled PI + its charge + the
// matching balance transaction. The flat shape (what `parseSeed` takes).
const SCENARIO_14_SEED_FLAT = {
  api_keys: [
    { key: "sk_test_pome_default", sid: "default", account_id: "acct_default" },
  ],
  payment_intents: [
    {
      id: "pi_test_200",
      account_id: "acct_default",
      amount: 20000,
      currency: "usd",
      status: "succeeded",
      payment_method_types: ["crypto"],
      latest_charge_id: "ch_test_200",
      client_secret: "pi_test_200_secret_test",
      created: 1700000000,
      updated: 1700000000,
      captured_at: 1700000000,
    },
  ],
  charges: [
    {
      id: "ch_test_200",
      account_id: "acct_default",
      payment_intent_id: "pi_test_200",
      amount: 20000,
      amount_captured: 20000,
      amount_refunded: 0,
      status: "succeeded",
      balance_transaction_id: "txn_test_200",
      captured: true,
      currency: "usd",
      created: 1700000000,
    },
  ],
  balance_transactions: [
    {
      id: "txn_test_200",
      account_id: "acct_default",
      type: "charge",
      amount: 20000,
      fee: 0,
      net: 20000,
      currency: "usd",
      source_id: "ch_test_200",
      source_type: "charge",
      available_on: 1700000000,
      status: "available",
      created: 1700000000,
    },
  ],
  refunds: [],
} as const;

// The canonical wrapped shape that scenario 14 actually ships in
// `## Seed State` — cloud's `extractSeedFromScenarioSource` forwards it
// verbatim. twin-stripe must peel `body.stripe?.seed ?? body`.
const SCENARIO_14_SEED_WRAPPED = { stripe: { seed: SCENARIO_14_SEED_FLAT } };

describe("loadSeedFromEnv", () => {
  it("returns the parsed scenario seed when POME_SEED_JSON is set (flat shape)", () => {
    const seed = loadSeedFromEnv({
      POME_SEED_JSON: JSON.stringify(SCENARIO_14_SEED_FLAT),
    });
    expect(seed.payment_intents).toHaveLength(1);
    expect(seed.payment_intents?.[0]?.id).toBe("pi_test_200");
    expect(seed.charges).toHaveLength(1);
    expect(seed.charges?.[0]?.id).toBe("ch_test_200");
    expect(seed.balance_transactions?.[0]?.id).toBe("txn_test_200");
    expect(seed.refunds).toEqual([]);
    expect(seed.api_keys?.[0]?.key).toBe("sk_test_pome_default");
  });

  it("peels the canonical { stripe: { seed: ... } } wrapped shape (FDRS-365)", () => {
    const seed = loadSeedFromEnv({
      POME_SEED_JSON: JSON.stringify(SCENARIO_14_SEED_WRAPPED),
    });
    // Same fields as the flat-shape case — proves the unwrap is the
    // only thing happening.
    expect(seed.payment_intents).toHaveLength(1);
    expect(seed.payment_intents?.[0]?.id).toBe("pi_test_200");
    expect(seed.charges?.[0]?.id).toBe("ch_test_200");
    expect(seed.balance_transactions?.[0]?.id).toBe("txn_test_200");
  });

  it("falls back to defaultSeed when POME_SEED_JSON is absent", () => {
    const seed = loadSeedFromEnv({});
    expect(seed).toEqual(defaultSeed());
  });

  it("falls back to defaultSeed when POME_SEED_JSON is an empty string", () => {
    // Defensive: an empty env (e.g. the cloud didn't intend to set a
    // seed but the env-injection layer wrote "") must NOT throw — treat
    // it the same as "not set".
    const seed = loadSeedFromEnv({ POME_SEED_JSON: "" });
    expect(seed).toEqual(defaultSeed());
  });

  it("throws a clear error when POME_SEED_JSON is not valid JSON", () => {
    expect(() =>
      loadSeedFromEnv({ POME_SEED_JSON: "{not valid json}" })
    ).toThrow(/not valid JSON/);
  });

  it("throws when POME_SEED_JSON parses but fails schema validation", () => {
    // `payment_intents[0].status` is not a valid PI status.
    expect(() =>
      loadSeedFromEnv({
        POME_SEED_JSON: JSON.stringify({
          payment_intents: [
            {
              id: "pi_x",
              account_id: "acct_default",
              amount: 100,
              currency: "usd",
              status: "not_a_real_status",
              client_secret: "pi_x_secret",
              created: 1,
              updated: 1,
            },
          ],
        }),
      })
    ).toThrow();
  });
});
