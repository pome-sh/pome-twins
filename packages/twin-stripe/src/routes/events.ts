// SPDX-License-Identifier: Apache-2.0
// REST routes #11-12 from FDRS-270.

import type { Hono } from "hono";
import type { StripeDomain } from "../domain/index.js";
import type { Recorder } from "../types.js";
import { handle, ok, parseListQuery, accountId } from "./_helpers.js";

export function registerEventsRoutes(
  router: Hono,
  domain: StripeDomain,
  recorder: Recorder | undefined,
  runId: string
) {
  router.get("/v1/events/:id", (c) =>
    handle(c, recorder, runId, () =>
      ok(domain.retrieveEvent(accountId(c), c.req.param("id")!))
    )
  );

  router.get("/v1/events", (c) =>
    handle(c, recorder, runId, () => {
      const list = parseListQuery(c);
      return ok(
        domain.listEvents(accountId(c), {
          ...list,
          type: c.req.query("type"),
        })
      );
    })
  );
}
