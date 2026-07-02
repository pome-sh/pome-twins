// SPDX-License-Identifier: Apache-2.0
import type { Hono } from "hono";
import type { StripeDomain } from "./domain/index.js";
import type { Recorder, ResolvedSession } from "./types.js";
import type { StateProvider } from "./pome-routes.js";
import { registerStripeRoutes } from "./routes/index.js";
import { paymentMiddleware } from "./x402.js";

export type RegisterStripeSessionRoutesOptions = {
  domain: StripeDomain;
  recorder: Recorder;
  runId: string;
  twinBaseUrl: string;
};

export function registerStripeSessionRoutes(
  session: Hono,
  opts: RegisterStripeSessionRoutesOptions,
): { stateProvider: StateProvider } {
  const { domain, recorder, runId, twinBaseUrl } = opts;

  registerStripeRoutes(session, domain, recorder, runId);
  session.use(
    paymentMiddleware(
      {
        "GET /x402/protected-resource": {
          accepts: [
            {
              scheme: "exact",
              price: "$0.01",
              network: "eip155:84532",
              description: "Unlock the hosted Stripe x402 protected resource",
            },
          ],
          description: "Hosted Stripe x402 protected resource",
          mimeType: "application/json",
        },
      },
      {
        twinBaseUrl,
        sid: (c) => {
          const sess = c.get("session") as ResolvedSession | undefined;
          return sess?.sid ?? "default";
        },
        apiKey: (c) => {
          const header = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
          return header.replace(/^bearer\s+/i, "");
        },
      },
    ),
  );
  session.get("/x402/protected-resource", (c) =>
    c.json({
      ok: true,
      resource: "stripe-x402-protected-resource",
      message: "Payment verified by the Stripe twin.",
    }),
  );

  return {
    stateProvider: (_c, sess: ResolvedSession | undefined) => {
      if (!sess) {
        return { payment_intents: [], charges: [], balance_transactions: [], events: [] };
      }
      return domain.exportState(sess.account_id);
    },
  };
}
