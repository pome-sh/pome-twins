// SPDX-License-Identifier: Apache-2.0
//
// Loud unsupported-route surface: every `/v1/*` route not on the v1 list returns 501
// `/v1/*` route not on the v1 list returns 501 with `fidelity: "unsupported"`.

import { describe, expect, it } from "vitest";
import { createStripeApp, rest } from "./_appHelper.js";

// /v1/refunds moved off this list when M3a Lane B (FDRS-338) landed the
// refunds resource. Anything still on the list returns the loud 501.
const UNSUPPORTED_PATHS: Array<[string, string]> = [
  ["GET", "/v1/customers"],
  ["POST", "/v1/customers"],
  ["POST", "/v1/setup_intents"],
  ["GET", "/v1/products"],
  ["GET", "/v1/checkout/sessions"],
  ["POST", "/v1/webhook_endpoints"],
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
