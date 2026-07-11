// SPDX-License-Identifier: Apache-2.0
// REST routes #1-6 from FDRS-270.

import type { Hono } from "hono";
import { z } from "zod";
import type { StripeDomain } from "../domain/index.js";
import type { Recorder } from "../types.js";
import { handle, ok, created, parseListQuery, accountId, readBodyForm } from "./_helpers.js";

// Stripe's form encoding surfaces booleans as "true"/"false" strings.
const formBool = z
  .union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")])
  .optional();

const createPISchema = z.object({
  amount: z.coerce.number().int().positive(),
  currency: z.string().min(1),
  payment_method_types: z.array(z.string()).min(1),
  payment_method_options: z
    .object({
      crypto: z.object({
        mode: z.literal("deposit"),
        deposit_options: z
          .object({
            networks: z.array(z.string()).min(1).optional(),
          })
          .optional(),
      }),
    })
    .optional(),
  payment_method: z.string().optional(),
  customer: z.string().optional(),
  confirm: formBool,
  metadata: z.record(z.string(), z.string()).optional(),
  capture_method: z.string().optional(),
  confirmation_method: z.string().optional(),
});

const confirmPISchema = z.object({
  payment_method: z.string().optional(),
});

// Metadata values keep "" and null so the domain can apply Stripe's
// per-key unset semantics, same as the customers update surface.
const updatePISchema = z.object({
  amount: z.coerce.number().int().optional(),
  metadata: z.record(z.string(), z.string().nullable()).optional(),
  payment_method: z.string().optional(),
  customer: z.string().optional(),
});

export function registerPaymentIntentRoutes(
  router: Hono,
  domain: StripeDomain,
  recorder: Recorder | undefined,
  runId: string
) {
  // 1. POST /v1/payment_intents
  router.post("/v1/payment_intents", (c) =>
    handle(c, recorder, runId, async () => {
      const body = await readBodyForm(c);
      const input = createPISchema.parse(body);
      const { body: piBody, delta } = domain.createPaymentIntent(accountId(c), input);
      return created(piBody, delta);
    })
  );

  // 2. GET /v1/payment_intents/:id
  router.get("/v1/payment_intents/:id", (c) =>
    handle(c, recorder, runId, () =>
      ok(domain.retrievePaymentIntent(accountId(c), c.req.param("id")!))
    )
  );

  // 3. GET /v1/payment_intents
  router.get("/v1/payment_intents", (c) =>
    handle(c, recorder, runId, () => {
      const list = parseListQuery(c);
      return ok(domain.listPaymentIntents(accountId(c), list));
    })
  );

  // 4. POST /v1/payment_intents/:id/confirm
  router.post("/v1/payment_intents/:id/confirm", (c) =>
    handle(c, recorder, runId, async () => {
      const input = confirmPISchema.parse(await readBodyForm(c));
      const { body, delta } = domain.confirmPaymentIntent(
        accountId(c),
        c.req.param("id")!,
        input
      );
      return ok(body, true, delta);
    })
  );

  // 4b. POST /v1/payment_intents/:id — update (F-731, the retry-with-new-PM step)
  router.post("/v1/payment_intents/:id", (c) =>
    handle(c, recorder, runId, async () => {
      const input = updatePISchema.parse(await readBodyForm(c));
      const { body, delta } = domain.updatePaymentIntent(
        accountId(c),
        c.req.param("id")!,
        input
      );
      return ok(body, true, delta);
    })
  );

  // 5. POST /v1/payment_intents/:id/cancel
  router.post("/v1/payment_intents/:id/cancel", (c) =>
    handle(c, recorder, runId, () => {
      const { body, delta } = domain.cancelPaymentIntent(accountId(c), c.req.param("id")!);
      return ok(body, true, delta);
    })
  );

  // 6. POST /v1/test_helpers/payment_intents/:id/simulate_crypto_deposit
  router.post(
    "/v1/test_helpers/payment_intents/:id/simulate_crypto_deposit",
    (c) =>
      handle(c, recorder, runId, () => {
        const { body, delta } = domain.simulateCryptoDeposit(
          accountId(c),
          c.req.param("id")!
        );
        return ok(body, true, delta);
      })
  );
}
