// SPDX-License-Identifier: Apache-2.0
//
// Route registration surface (domain). `registerStripeRoutes(router,
// domain, recorder, runId)` registers the Stripe REST routes + the loud
// /v1/* 501 catch-all on the given Hono router. The twin manifest
// (../twin.ts) calls this from its `routes` registrar; MCP dispatch is the
// engine's (`/mcp` is a reserved SDK prefix since F-681 — the tool registry
// in ../tools.ts drives it via the manifest).

import type { Hono } from "hono";
import type { StripeDomain } from "../domain/index.js";
import type { Recorder } from "../types.js";
import { unsupported } from "../errors.js";
import { respond } from "./_helpers.js";
import { registerPaymentIntentRoutes } from "./payment-intents.js";
import { registerChargesRoutes } from "./charges.js";
import { registerBalanceRoutes } from "./balance.js";
import { registerEventsRoutes } from "./events.js";
import { registerRefundsRoutes } from "./refunds.js";
import { registerCustomersRoutes } from "./customers.js";
import { registerPaymentMethodsRoutes } from "./payment-methods.js";

export function registerStripeRoutes(
  router: Hono,
  domain: StripeDomain,
  recorder: Recorder | undefined,
  runId: string
) {
  // Stripe REST
  registerPaymentIntentRoutes(router, domain, recorder, runId);
  registerChargesRoutes(router, domain, recorder, runId);
  registerRefundsRoutes(router, domain, recorder, runId);
  registerCustomersRoutes(router, domain, recorder, runId);
  registerPaymentMethodsRoutes(router, domain, recorder, runId);
  registerBalanceRoutes(router, domain, recorder, runId);
  registerEventsRoutes(router, domain, recorder, runId);

  // Loud 501 for any /v1/* that isn't implemented. Scoped to /v1/* so the
  // engine's session-wide catch-all handles the rest.
  router.all("/v1/*", (c) => {
    const envelope = unsupported();
    return respond(
      c,
      recorder,
      runId,
      Date.now(),
      null,
      envelope.status,
      envelope.body,
      false,
      "unsupported"
    );
  });
}
