// SPDX-License-Identifier: Apache-2.0
// Customers REST — F-732 (M5 customer-management hot path).
//
// POST /v1/customers · GET /v1/customers(/:id) · POST /v1/customers/:id ·
// DELETE /v1/customers/:id · GET /v1/customers/:id/payment_methods.
// Idempotency is handled upstream by idempotencyMiddleware; every mutation
// carries the canonical state_delta through to respond().

import type { Hono } from "hono";
import { z } from "zod";
import type { StripeDomain } from "../domain/index.js";
import type { Recorder } from "../types.js";
import { accountId, created, handle, ok, parseListQuery, readBodyForm } from "./_helpers.js";

// Every field optional, like real Stripe. Metadata values keep "" and null
// so the domain can apply Stripe's per-key unset semantics on update.
const customerFieldsSchema = z.object({
  name: z.string().nullish(),
  email: z.string().nullish(),
  description: z.string().nullish(),
  phone: z.string().nullish(),
  metadata: z.record(z.string(), z.string().nullable()).optional(),
});

export function registerCustomersRoutes(
  router: Hono,
  domain: StripeDomain,
  recorder: Recorder | undefined,
  runId: string
) {
  router.post("/v1/customers", (c) =>
    handle(c, recorder, runId, async () => {
      const input = customerFieldsSchema.parse(await readBodyForm(c));
      const { body, delta } = domain.createCustomer(accountId(c), input);
      return created(body, delta);
    })
  );

  router.get("/v1/customers/:id/payment_methods", (c) =>
    handle(c, recorder, runId, () => {
      const list = parseListQuery(c);
      return ok(
        domain.listCustomerPaymentMethods(accountId(c), c.req.param("id")!, {
          ...list,
          type: c.req.query("type"),
        })
      );
    })
  );

  router.get("/v1/customers/:id", (c) =>
    handle(c, recorder, runId, () =>
      ok(domain.retrieveCustomer(accountId(c), c.req.param("id")!))
    )
  );

  router.post("/v1/customers/:id", (c) =>
    handle(c, recorder, runId, async () => {
      const input = customerFieldsSchema.parse(await readBodyForm(c));
      const { body, delta } = domain.updateCustomer(accountId(c), c.req.param("id")!, input);
      return ok(body, true, delta);
    })
  );

  router.delete("/v1/customers/:id", (c) =>
    handle(c, recorder, runId, () => {
      const { body, delta } = domain.deleteCustomer(accountId(c), c.req.param("id")!);
      return ok(body, true, delta);
    })
  );

  router.get("/v1/customers", (c) =>
    handle(c, recorder, runId, () => {
      const list = parseListQuery(c);
      return ok(
        domain.listCustomers(accountId(c), { ...list, email: c.req.query("email") })
      );
    })
  );
}
