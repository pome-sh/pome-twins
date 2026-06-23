// SPDX-License-Identifier: Apache-2.0
//
// Route registration surface. Owned by AGENT-B.
//
// `registerStripeRoutes(sessionRouter, domain, recorder, runId)` registers
// the 12 v1 REST routes + the MCP tool routes + a loud 501 catch-all on
// the given Hono router. AGENT-A's `app.ts` calls this once after wiring
// auth and the database.
//
// Wired up directly so AGENT-A's `app.ts` only needs:
//   const session = new Hono();
//   session.use("*", bearerAuth());
//   registerStripeRoutes(session, domain, recorder, runId);
//   root.route("/s/:sid", session);

import type { Hono, Context } from "hono";
import { z } from "zod";
import type { StripeDomain } from "../domain/index.js";
import type { Recorder } from "../types.js";
import { unsupported } from "../errors.js";
import { executeTool, isMutatingTool, listTools } from "../tools.js";
import { handleMcpRequest, mcpMethodNotAllowed } from "../mcp.js";
import { handle, ok, respond, accountId } from "./_helpers.js";
import { registerPaymentIntentRoutes } from "./payment-intents.js";
import { registerChargesRoutes } from "./charges.js";
import { registerBalanceRoutes } from "./balance.js";
import { registerEventsRoutes } from "./events.js";
import { registerRefundsRoutes } from "./refunds.js";

const jsonRecord = z.record(z.string(), z.unknown());
const callBody = z.object({
  tool: z.string().min(1),
  arguments: jsonRecord.optional(),
});

export function registerStripeRoutes(
  router: Hono,
  domain: StripeDomain,
  recorder: Recorder | undefined,
  runId: string
) {
  // MCP — registered before chassis stubs (extendSession runs first).
  // JSON-RPC 2.0 streamable-HTTP endpoint (FDRS-528) — what the eval fleet's
  // mcp-loop scaffold speaks. The legacy `/mcp/tools` + `/mcp/call` dispatch
  // below stays for backward compat.
  router.post("/mcp", (c) => handleMcpRequest(c, { domain, recorder, runId }));
  router.get("/mcp", (c) => mcpMethodNotAllowed(c));
  router.delete("/mcp", (c) => mcpMethodNotAllowed(c));
  router.get("/mcp/tools", (c) => c.json({ tools: listTools() }));
  router.post("/mcp/tools/:name", (c) =>
    handle(c, recorder, runId, async () => {
      const args = await readJson(c);
      const name = c.req.param("name")!;
      const result = executeTool(domain, accountId(c), name, args);
      return ok(result, isMutatingTool(name));
    })
  );
  router.post("/mcp/call", (c) =>
    handle(c, recorder, runId, async () => {
      const body = await readJson(c);
      const call = callBody.parse(body);
      const result = executeTool(domain, accountId(c), call.tool, call.arguments ?? {});
      return ok(result, isMutatingTool(call.tool));
    })
  );

  // Stripe REST
  registerPaymentIntentRoutes(router, domain, recorder, runId);
  registerChargesRoutes(router, domain, recorder, runId);
  registerRefundsRoutes(router, domain, recorder, runId);
  registerBalanceRoutes(router, domain, recorder, runId);
  registerEventsRoutes(router, domain, recorder, runId);

  // Loud 501 for any /v1/* that isn't implemented.
  // Scoped to /v1/* so the chassis's session-wide catchall (registered
  // after extendSession) handles the rest.
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

async function readJson(c: Context): Promise<unknown> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    try {
      return await c.req.parseBody();
    } catch {
      return {};
    }
  }
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}
