// SPDX-License-Identifier: Apache-2.0
// REST routes #7-8 from FDRS-270.

import type { Hono } from "hono";
import type { StripeDomain } from "../domain/index.js";
import type { Recorder } from "../types.js";
import { handle, ok, parseListQuery, accountId } from "./_helpers.js";

export function registerChargesRoutes(
  router: Hono,
  domain: StripeDomain,
  recorder: Recorder | undefined,
  runId: string
) {
  router.get("/v1/charges/:id", (c) =>
    handle(c, recorder, runId, () =>
      ok(domain.retrieveCharge(accountId(c), c.req.param("id")!))
    )
  );

  router.get("/v1/charges", (c) =>
    handle(c, recorder, runId, () => {
      const list = parseListQuery(c);
      return ok(
        domain.listCharges(accountId(c), {
          ...list,
          payment_intent: c.req.query("payment_intent"),
          customer: c.req.query("customer"),
        })
      );
    })
  );
}
