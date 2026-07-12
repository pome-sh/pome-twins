// SPDX-License-Identifier: Apache-2.0
// Payment methods REST — F-732 (M5 card-on-file chain).
//
// POST /v1/payment_methods · GET /v1/payment_methods/:id ·
// POST /v1/payment_methods/:id/attach|detach. The top-level list
// (GET /v1/payment_methods) stays on the loud-501 surface per the F-729
// ruling — the customer-scoped list is the hot read.

import type { Hono } from "hono";
import type { StripeDomain } from "../domain/index.js";
import type { CreatePaymentMethodInput } from "../domain/index.js";
import type { Recorder } from "../types.js";
import { TwinError } from "../errors.js";
import { accountId, created, handle, ok, readBodyForm } from "./_helpers.js";

export function registerPaymentMethodsRoutes(
  router: Hono,
  domain: StripeDomain,
  recorder: Recorder | undefined,
  runId: string
) {
  router.post("/v1/payment_methods", (c) =>
    handle(c, recorder, runId, async () => {
      // Validation (with Stripe's parameter_missing / card_error codes)
      // lives in the domain, so the raw body passes through untyped.
      const body = (await readBodyForm(c)) as CreatePaymentMethodInput;
      const { body: response, delta } = domain.createPaymentMethod(accountId(c), body);
      return created(response, delta);
    })
  );

  router.get("/v1/payment_methods/:id", (c) =>
    handle(c, recorder, runId, () =>
      ok(domain.retrievePaymentMethod(accountId(c), c.req.param("id")!))
    )
  );

  router.post("/v1/payment_methods/:id/attach", (c) =>
    handle(c, recorder, runId, async () => {
      const body = (await readBodyForm(c)) as { customer?: unknown };
      const customer = typeof body.customer === "string" ? body.customer : "";
      if (!customer) {
        throw new TwinError(
          "invalid_request_error",
          "parameter_missing",
          "Missing required param: customer.",
          { param: "customer", statusCode: 400 }
        );
      }
      const { body: response, delta } = domain.attachPaymentMethod(
        accountId(c),
        c.req.param("id")!,
        customer
      );
      return ok(response, true, delta);
    })
  );

  router.post("/v1/payment_methods/:id/detach", (c) =>
    handle(c, recorder, runId, () => {
      const { body, delta } = domain.detachPaymentMethod(accountId(c), c.req.param("id")!);
      return ok(body, true, delta);
    })
  );
}
