// SPDX-License-Identifier: Apache-2.0
// REST routes #1-6 from FDRS-270.

import type { Hono, Context } from "hono";
import { z } from "zod";
import type { StripeDomain } from "../domain/index.js";
import type { Recorder } from "../types.js";
import { handle, ok, created, parseListQuery, accountId } from "./_helpers.js";

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
  metadata: z.record(z.string(), z.string()).optional(),
  capture_method: z.string().optional(),
  confirmation_method: z.string().optional(),
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
    handle(c, recorder, runId, () => {
      const { body, delta } = domain.confirmPaymentIntent(accountId(c), c.req.param("id")!);
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

/**
 * Stripe accepts both JSON and form-urlencoded bodies. Real Stripe bills
 * itself as form-only on POST; the SDKs tend to send form. For agent-friendly
 * v1 we accept JSON too. Return whichever parses; empty-body POSTs return
 * `{}`.
 */
async function readBodyForm(c: Context): Promise<unknown> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return await c.req.json();
    } catch {
      return {};
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    try {
      const form = await c.req.parseBody({ all: true });
      return formToObject(form as Record<string, unknown>);
    } catch {
      return {};
    }
  }
  // No content-type or unknown: try JSON, fall back to form, fall back to {}.
  try {
    return await c.req.json();
  } catch {
    try {
      const form = await c.req.parseBody({ all: true });
      return formToObject(form as Record<string, unknown>);
    } catch {
      return {};
    }
  }
}

/**
 * Stripe's bracket-form encoding: `payment_method_types[0]=crypto&
 * payment_method_options[crypto][mode]=deposit`. Convert to nested object.
 */
function formToObject(form: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(form)) {
    const path = parseBracketPath(rawKey);
    setDeep(out, path, value);
  }
  return out;
}

/** Keys that walk Object.prototype and would let a request pollute every
 *  other object in the same JS process. Real Stripe form-encoding never
 *  uses these names; rejecting them costs nothing and closes the
 *  prototype-pollution primitive. */
const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function parseBracketPath(key: string): Array<string | number> {
  const parts: Array<string | number> = [];
  const regex = /([^\[\]]+)|\[([^\[\]]*)\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(key)) !== null) {
    const piece = match[1] ?? match[2] ?? "";
    if (/^\d+$/.test(piece)) parts.push(Number(piece));
    else parts.push(piece);
  }
  return parts;
}

function setDeep(target: Record<string, unknown>, path: Array<string | number>, value: unknown) {
  // Reject any path that walks through __proto__, constructor, or
  // prototype. A malicious form body with `__proto__[polluted]=pwned`
  // would otherwise mutate Object.prototype and corrupt every other
  // object in this process for the rest of the sandbox's lifetime.
  for (const key of path) {
    if (typeof key === "string" && POLLUTION_KEYS.has(key)) {
      // Drop the assignment silently — the field would not be a real
      // Stripe parameter anyway. Real Stripe returns 400 for unknown
      // params; v1 deliberately accepts unknowns to keep the agent
      // surface flexible, so silent drop is the closest fidelity.
      return;
    }
  }
  let cursor: Record<string | number, unknown> = target;
  for (let i = 0; i < path.length; i++) {
    const key = path[i]!;
    const isLast = i === path.length - 1;
    if (isLast) {
      cursor[key] = value;
    } else {
      const nextKey = path[i + 1]!;
      if (cursor[key] === undefined) {
        cursor[key] = typeof nextKey === "number" ? [] : {};
      }
      cursor = cursor[key] as Record<string | number, unknown>;
    }
  }
}
