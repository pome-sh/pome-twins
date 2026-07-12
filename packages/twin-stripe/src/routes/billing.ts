// SPDX-License-Identifier: Apache-2.0
// Billing REST — F-734 (M5 warm surfaces, shape tier per the F-729 ruling).
//
// Products: POST/GET /v1/products(/:id) · Prices: POST/GET /v1/prices(/:id) ·
// Subscriptions: POST/GET /v1/subscriptions(/:id), POST/DELETE
// /v1/subscriptions/:id · Invoices: GET /v1/invoices(/:id) READS ONLY.
// Everything else in these families (product/price updates, invoice
// create/finalize/pay) stays unlisted-cold on the /v1/* 501 catch-all.

import type { Hono } from "hono";
import { z } from "zod";
import type { StripeDomain } from "../domain/index.js";
import type { Recorder } from "../types.js";
import { accountId, created, handle, ok, parseListQuery, readBodyForm } from "./_helpers.js";

// Stripe's form encoding surfaces booleans as "true"/"false" strings
// (same shape as routes/payment-intents.ts).
const formBool = z
  .union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")])
  .optional();

// Metadata values keep "" and null so the domain can apply Stripe's per-key
// unset semantics on update (same as the customers surface).
const metadataSchema = z.record(z.string(), z.string().nullable()).optional();

const productFieldsSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullish(),
  active: formBool,
  metadata: metadataSchema,
});

const createPriceSchema = z.object({
  currency: z.string().min(1).optional(),
  product: z.string().min(1).optional(),
  unit_amount: z.coerce.number().int().nonnegative().optional(),
  recurring: z
    .object({
      interval: z.string().min(1),
      interval_count: z.coerce.number().int().positive().optional(),
    })
    .optional(),
  nickname: z.string().nullish(),
  lookup_key: z.string().nullish(),
  active: formBool,
  metadata: metadataSchema,
});

const createSubscriptionSchema = z.object({
  customer: z.string().min(1).optional(),
  items: z
    .array(
      z.object({
        price: z.string().min(1).optional(),
        quantity: z.coerce.number().int().positive().optional(),
      })
    )
    .optional(),
  cancel_at_period_end: formBool,
  metadata: metadataSchema,
});

const updateSubscriptionSchema = z.object({
  cancel_at_period_end: formBool,
  metadata: metadataSchema,
});

export function registerBillingRoutes(
  router: Hono,
  domain: StripeDomain,
  recorder: Recorder | undefined,
  runId: string
) {
  // ---------- Products ----------

  router.post("/v1/products", (c) =>
    handle(c, recorder, runId, async () => {
      const input = productFieldsSchema.parse(await readBodyForm(c));
      const { body, delta } = domain.createProduct(accountId(c), input);
      return created(body, delta);
    })
  );

  router.get("/v1/products/:id", (c) =>
    handle(c, recorder, runId, () =>
      ok(domain.retrieveProduct(accountId(c), c.req.param("id")!))
    )
  );

  router.get("/v1/products", (c) =>
    handle(c, recorder, runId, () => {
      const list = parseListQuery(c);
      return ok(
        domain.listProducts(accountId(c), { ...list, active: queryBool(c.req.query("active")) })
      );
    })
  );

  // ---------- Prices ----------

  router.post("/v1/prices", (c) =>
    handle(c, recorder, runId, async () => {
      const input = createPriceSchema.parse(await readBodyForm(c));
      const { body, delta } = domain.createPrice(accountId(c), input);
      return created(body, delta);
    })
  );

  router.get("/v1/prices/:id", (c) =>
    handle(c, recorder, runId, () =>
      ok(domain.retrievePrice(accountId(c), c.req.param("id")!))
    )
  );

  router.get("/v1/prices", (c) =>
    handle(c, recorder, runId, () => {
      const list = parseListQuery(c);
      return ok(
        domain.listPrices(accountId(c), {
          ...list,
          product: c.req.query("product"),
          active: queryBool(c.req.query("active")),
        })
      );
    })
  );

  // ---------- Subscriptions ----------

  router.post("/v1/subscriptions", (c) =>
    handle(c, recorder, runId, async () => {
      const input = createSubscriptionSchema.parse(await readBodyForm(c));
      const { body, delta } = domain.createSubscription(accountId(c), input);
      return created(body, delta);
    })
  );

  router.get("/v1/subscriptions/:id", (c) =>
    handle(c, recorder, runId, () =>
      ok(domain.retrieveSubscription(accountId(c), c.req.param("id")!))
    )
  );

  router.post("/v1/subscriptions/:id", (c) =>
    handle(c, recorder, runId, async () => {
      const input = updateSubscriptionSchema.parse(await readBodyForm(c));
      const { body, delta } = domain.updateSubscription(accountId(c), c.req.param("id")!, input);
      return ok(body, true, delta);
    })
  );

  router.delete("/v1/subscriptions/:id", (c) =>
    handle(c, recorder, runId, () => {
      const { body, delta } = domain.cancelSubscription(accountId(c), c.req.param("id")!);
      return ok(body, true, delta);
    })
  );

  router.get("/v1/subscriptions", (c) =>
    handle(c, recorder, runId, () => {
      const list = parseListQuery(c);
      return ok(
        domain.listSubscriptions(accountId(c), {
          ...list,
          customer: c.req.query("customer"),
          status: c.req.query("status"),
        })
      );
    })
  );

  // ---------- Invoices (reads only) ----------

  router.get("/v1/invoices/:id", (c) =>
    handle(c, recorder, runId, () =>
      ok(domain.retrieveInvoice(accountId(c), c.req.param("id")!))
    )
  );

  router.get("/v1/invoices", (c) =>
    handle(c, recorder, runId, () =>
      ok(domain.listInvoices(accountId(c), parseListQuery(c)))
    )
  );
}

function queryBool(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}
