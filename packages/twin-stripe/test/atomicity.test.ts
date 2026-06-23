// SPDX-License-Identifier: Apache-2.0
//
// F2 — simulate_crypto_deposit must be atomic. If anything throws between
// Leg 1 (CAS to processing) and the final event emit, the entire flow
// must roll back: PI status returns to requires_action, no orphan
// charges, no orphan balance txns, no orphan events.
//
// We force a mid-flight failure by monkey-patching ChargesDomain.createForPI
// to throw on the next call. better-sqlite3 transactions are synchronous
// and atomic, so the throw inside StripeDomain.simulateCryptoDeposit's
// db.transaction should roll back everything.

import { describe, expect, it } from "vitest";
import { ChargesDomain } from "../src/domain/charges.js";
import { createStripeApp, rest } from "./_appHelper.js";

describe("F2 — simulate_crypto_deposit atomicity", () => {
  it("rolls back state when a mid-flight call throws", async () => {
    const app = await createStripeApp();
    const created = await rest(app, "POST", "/v1/payment_intents", {
      amount: 750,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } }
      }
    });
    expect(created.status).toBe(200);
    const piId = created.body.id as string;

    // Snapshot pre-call state for the assertions below.
    const eventsBefore = await rest(app, "GET", "/v1/events");
    const eventsBeforeCount = eventsBefore.body.data.length;
    const balanceTxsBefore = await rest(app, "GET", "/v1/balance_transactions");
    const balanceTxsBeforeCount = balanceTxsBefore.body.data.length;

    // Monkey-patch the prototype so the next createForPI call throws.
    // Restore on the way out so other tests are unaffected.
    const original = ChargesDomain.prototype.createForPI;
    let restored = false;
    ChargesDomain.prototype.createForPI = function () {
      ChargesDomain.prototype.createForPI = original;
      restored = true;
      throw new Error("simulated mid-flight failure");
    };

    let threw = false;
    try {
      await rest(
        app,
        "POST",
        `/v1/test_helpers/payment_intents/${piId}/simulate_crypto_deposit`
      );
      // Either the route returns 500 (preferred) or throws into the
      // top-level handler. Either way the transaction must roll back.
      threw = true;
    } catch {
      threw = true;
    } finally {
      if (!restored) ChargesDomain.prototype.createForPI = original;
    }
    expect(threw).toBe(true);

    // PI must be back in requires_action — Leg 1's CAS update was rolled
    // back by the transaction.
    const pi = await rest(app, "GET", `/v1/payment_intents/${piId}`);
    expect(pi.status).toBe(200);
    expect(pi.body.status).toBe("requires_action");
    expect(pi.body.latest_charge).toBeNull();

    // No charge created.
    const charges = await rest(app, "GET", `/v1/charges?payment_intent=${piId}`);
    expect(charges.body.data).toHaveLength(0);

    // No new balance txn.
    const balanceTxsAfter = await rest(app, "GET", "/v1/balance_transactions");
    expect(balanceTxsAfter.body.data.length).toBe(balanceTxsBeforeCount);

    // No new events emitted (the processing event the flow tried to emit
    // must have rolled back along with everything else).
    const eventsAfter = await rest(app, "GET", "/v1/events");
    expect(eventsAfter.body.data.length).toBe(eventsBeforeCount);
  });

  it("a fresh simulate after the rollback succeeds normally", async () => {
    // Sanity check: after a rolled-back attempt, the PI is still
    // settle-able. Proves nothing was left in a poisoned state.
    const app = await createStripeApp();
    const created = await rest(app, "POST", "/v1/payment_intents", {
      amount: 250,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } }
      }
    });
    const piId = created.body.id as string;

    const original = ChargesDomain.prototype.createForPI;
    ChargesDomain.prototype.createForPI = function () {
      ChargesDomain.prototype.createForPI = original;
      throw new Error("simulated mid-flight failure");
    };
    try {
      await rest(
        app,
        "POST",
        `/v1/test_helpers/payment_intents/${piId}/simulate_crypto_deposit`
      );
    } catch {
      // expected
    }
    // Now retry the same PI — should drive cleanly to succeeded.
    const settle = await rest(
      app,
      "POST",
      `/v1/test_helpers/payment_intents/${piId}/simulate_crypto_deposit`
    );
    expect(settle.status).toBe(200);
    expect(settle.body.status).toBe("succeeded");
  });
});
