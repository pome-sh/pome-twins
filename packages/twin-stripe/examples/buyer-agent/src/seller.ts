// SPDX-License-Identifier: Apache-2.0
//
// Tiny Hono server that gates GET /paid behind the x402 challenge implemented
// in `@pome-sh/twin-stripe/x402`. Used by the buyer-agent demo.

import { Hono } from "hono";
import { paymentMiddleware } from "../../../src/x402.js";

export type SellerOptions = {
  twinBaseUrl?: string;
  apiKey?: string;
  sid?: string;
};

export function createSellerApp(opts: SellerOptions = {}) {
  const twinBaseUrl = opts.twinBaseUrl ?? "http://127.0.0.1:3333";
  const apiKey = opts.apiKey ?? "sk_test_pome_default";
  const sid = opts.sid ?? "default";

  const app = new Hono();

  app.use(
    paymentMiddleware(
      {
        "GET /paid": {
          accepts: [
            {
              scheme: "exact",
              price: "$0.01",
              network: "eip155:84532"
            }
          ],
          description: "Data retrieval endpoint",
          mimeType: "application/json"
        }
      },
      { twinBaseUrl, apiKey, sid }
    )
  );

  app.get("/paid", (c) =>
    c.json({
      ok: true,
      message: "you paid; enjoy this exclusive resource",
      timestamp: new Date().toISOString()
    })
  );

  return app;
}
