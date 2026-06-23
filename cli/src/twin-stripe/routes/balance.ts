// SPDX-License-Identifier: Apache-2.0
// REST routes #9-10 from FDRS-270.

import type { Hono } from "hono";
import type { StripeDomain } from "../domain/index.js";
import type { Recorder } from "../types.js";
import { handle, ok, parseListQuery, accountId } from "./_helpers.js";

export function registerBalanceRoutes(
  router: Hono,
  domain: StripeDomain,
  recorder: Recorder | undefined,
  runId: string
) {
  router.get("/v1/balance", (c) =>
    handle(c, recorder, runId, () => ok(domain.retrieveBalance(accountId(c))))
  );

  router.get("/v1/balance_transactions", (c) =>
    handle(c, recorder, runId, () => {
      const list = parseListQuery(c);
      return ok(
        domain.listBalanceTransactions(accountId(c), {
          ...list,
          type: c.req.query("type"),
        })
      );
    })
  );
}
