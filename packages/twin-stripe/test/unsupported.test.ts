// SPDX-License-Identifier: Apache-2.0
//
// Loud unsupported-route surface: every `/v1/*` route not on the v1 list returns 501
// `/v1/*` route not on the v1 list returns 501 with `fidelity: "unsupported"`.

import { describe, expect, it } from "vitest";
import { createStripeApp, rest } from "./_appHelper.js";

// /v1/refunds moved off this list when M3a Lane B (FDRS-338) landed the
// refunds resource; /v1/customers moved off when F-732 landed the customer
// chain; /v1/products moved off when F-734 landed the warm billing
// surfaces. GET /v1/payment_methods (the top-level list) stays 501 per the
// F-729 ruling — only the customer-scoped list is implemented. Anything
// still on the list returns the loud 501.
//
// The first four families are the F-729 NAMED COLD rows (agents plausibly
// probe them, so the loud 501 is documented in FIDELITY.md and inventory-
// backed): checkout sessions + payment links (human-redirect flows),
// setup intents (card-on-file goes via direct PM attach), webhook
// endpoints (no delivery loop in v1 — agents poll /v1/events).
const UNSUPPORTED_PATHS: Array<[string, string]> = [
  ["POST", "/v1/checkout/sessions"],
  ["GET", "/v1/checkout/sessions"],
  ["POST", "/v1/payment_links"],
  ["GET", "/v1/payment_links"],
  ["POST", "/v1/setup_intents"],
  ["GET", "/v1/setup_intents"],
  ["POST", "/v1/webhook_endpoints"],
  ["GET", "/v1/webhook_endpoints"],
  ["GET", "/v1/payment_methods"],
  ["GET", "/v1/shared_payment_tokens"],
];

describe("loud 501 envelope on unsupported /v1/*", () => {
  for (const [method, path] of UNSUPPORTED_PATHS) {
    it(`${method} ${path} returns 501 with fidelity=unsupported`, async () => {
      const app = await createStripeApp();
      const r = await rest(app, method, path, method === "POST" ? {} : undefined);
      expect(r.status).toBe(501);
      expect(r.body.error.type).toBe("invalid_request_error");
      expect(r.body.error.code).toBe("endpoint_not_supported");
      expect(r.body.error.fidelity).toBe("unsupported");
      expect(Array.isArray(r.body.error.supported_surfaces)).toBe(true);
    });
  }
});
