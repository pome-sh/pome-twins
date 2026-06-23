// SPDX-License-Identifier: Apache-2.0
// POST/GET /v1/refunds — FDRS-338 (M3a Lane B).
//
// `created()` carries the canonical state_delta { before: null, after: row }
// through to respond(), which writes it into the recorder event. Idempotency
// is handled upstream by idempotencyMiddleware — a replay with the same key
// short-circuits before this handler runs.

import type { Context, Hono } from "hono";
import type { StripeDomain } from "../domain/index.js";
import type { Recorder } from "../types.js";
import { accountId, created, handle, ok, parseListQuery } from "./_helpers.js";

export function registerRefundsRoutes(
  router: Hono,
  domain: StripeDomain,
  recorder: Recorder | undefined,
  runId: string
) {
  router.post("/v1/refunds", (c) =>
    handle(c, recorder, runId, async () => {
      const body = await readJson(c);
      const { body: response, delta } = domain.createRefund(accountId(c), {
        charge: typeof body.charge === "string" ? body.charge : "",
        amount: typeof body.amount === "number" ? body.amount : undefined,
        reason: typeof body.reason === "string" ? body.reason : null,
        idempotency_key: c.req.header("Idempotency-Key") ?? c.req.header("idempotency-key") ?? null,
      });
      return created(response, delta);
    })
  );

  router.get("/v1/refunds/:id", (c) =>
    handle(c, recorder, runId, () =>
      ok(domain.retrieveRefund(accountId(c), c.req.param("id")!))
    )
  );

  router.get("/v1/refunds", (c) =>
    handle(c, recorder, runId, () => {
      const list = parseListQuery(c);
      return ok(
        domain.listRefunds(accountId(c), {
          ...list,
          charge: c.req.query("charge"),
          payment_intent: c.req.query("payment_intent"),
        })
      );
    })
  );
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    try {
      const parsed = await c.req.parseBody();
      return coerceFormBody(parsed);
    } catch {
      return {};
    }
  }
  try {
    const body = (await c.req.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function coerceFormBody(form: Record<string, unknown>): Record<string, unknown> {
  // Stripe SDKs send `amount=7500` as form-encoded string. Coerce numerics
  // so the domain layer sees the same shape regardless of transport.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(form)) {
    if (typeof v === "string" && /^-?\d+$/.test(v) && (k === "amount")) {
      out[k] = Number(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
