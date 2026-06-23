// SPDX-License-Identifier: Apache-2.0
//
// Regression test for the form-encoded prototype-pollution primitive
// caught by the FDRS-267 adversarial review (F2). A POST with a body
// like `__proto__[polluted]=pwned&amount=1000&...` was walking
// Object.prototype, polluting every later object in the same JS
// process for the rest of the sandbox's lifetime.
//
// Fix lives in src/routes/payment-intents.ts setDeep() — rejects any
// path that includes `__proto__`, `constructor`, or `prototype`.
import { afterEach, describe, expect, it } from "vitest";
import { createStripeApp, withAuth } from "./_appHelper.js";

describe("prototype pollution — form-encoded body", () => {
  // Snapshot Object.prototype state so we can assert nothing leaked.
  const PROTO_KEYS_BEFORE = Object.keys(Object.prototype);

  afterEach(() => {
    // Clean up any pollution this test would have created if the fix
    // regressed, so following tests don't see polluted state.
    for (const key of Object.keys(Object.prototype)) {
      if (!PROTO_KEYS_BEFORE.includes(key)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, no-prototype-builtins
        delete (Object.prototype as any)[key];
      }
    }
  });

  it("__proto__[x]=y in form body does not pollute Object.prototype", async () => {
    const test = await createStripeApp();

    // Real-shape valid body, but with a __proto__ injection appended.
    // Real Stripe-shape clients never send this; the test mimics a
    // malicious agent attempting to corrupt the sandbox.
    const body = [
      "__proto__[polluted]=pwned",
      "amount=1000",
      "currency=usd",
      "payment_method_types[0]=crypto",
      "payment_method_options[crypto][mode]=deposit",
      "payment_method_options[crypto][deposit_options][networks][0]=base",
    ].join("&");

    const res = await test.app.request(
      `${test.base}/v1/payment_intents`,
      withAuth(test.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }),
    );

    // The request itself should succeed (the pollution key is
    // dropped silently and the rest of the body parses normally).
    expect(res.status).toBe(200);
    const pi = (await res.json()) as { id: string; status: string };
    expect(pi.id).toMatch(/^pi_/);
    expect(pi.status).toBe("requires_action");

    // Critical assertion: no new keys leaked onto Object.prototype.
    const afterKeys = Object.keys(Object.prototype);
    const newKeys = afterKeys.filter((k) => !PROTO_KEYS_BEFORE.includes(k));
    expect(newKeys).toEqual([]);
    // And specifically the key we tried to inject is not reachable.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("constructor.prototype.x=y in form body does not pollute either", async () => {
    const test = await createStripeApp();

    const body = [
      "constructor[prototype][polluted2]=pwned",
      "amount=1000",
      "currency=usd",
      "payment_method_types[0]=crypto",
      "payment_method_options[crypto][mode]=deposit",
      "payment_method_options[crypto][deposit_options][networks][0]=base",
    ].join("&");

    const res = await test.app.request(
      `${test.base}/v1/payment_intents`,
      withAuth(test.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }),
    );
    expect(res.status).toBe(200);

    const afterKeys = Object.keys(Object.prototype);
    const newKeys = afterKeys.filter((k) => !PROTO_KEYS_BEFORE.includes(k));
    expect(newKeys).toEqual([]);
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
  });
});
