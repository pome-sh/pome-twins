// SPDX-License-Identifier: Apache-2.0
//
// AGENT-B test bootstrap. Wraps AGENT-A's `createTwinStripeApp` with the
// session-router extension hook from `routes/index.ts` so the 12 v1 routes
// + MCP tools are mounted.
//
// All AGENT-B tests use `createStripeApp()` from this helper.
import { createTwinStripeApp } from "../src/app.js";
import { StripeDomain } from "../src/domain/index.js";
import { listTools } from "../src/tools.js";
import { registerStripeRoutes } from "../src/routes/index.js";
import type { ResolvedSession } from "../src/types.js";
import {
  TEST_ACCOUNT_ID,
  TEST_AUTH_SECRET,
  TEST_SID,
  signTestToken,
  withAuth,
} from "./_authHelper.js";

export { TEST_ACCOUNT_ID, TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth };

export type StripeTestApp = {
  app: ReturnType<typeof createTwinStripeApp>;
  base: string;
  token: string;
  domain: StripeDomain;
};

/**
 * Build a fresh app + session token. AGENT-A's `createTwinStripeApp` owns
 * auth, idempotency, db, recorder, healthz/admin, and the MCP scaffolding
 * placeholder. AGENT-B's `extendSession` mounts the 12 v1 REST routes,
 * the real MCP tool dispatcher, and the `_pome/state` extension.
 */
export async function createStripeApp(): Promise<StripeTestApp> {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  let domain!: StripeDomain;
  const app = createTwinStripeApp({
    runId: "test-run",
    toolCount: listTools().length,
    extendSession: (session, ctx) => {
      domain = new StripeDomain(ctx.db);
      registerStripeRoutes(session, domain, ctx.recorder, ctx.runId);
      return {
        stateProvider: (_c, sess: ResolvedSession | undefined) => {
          if (!sess) return { payment_intents: [], charges: [], balance_transactions: [], events: [] };
          return domain.exportState(sess.account_id);
        }
      };
    }
  });
  const token = await signTestToken();
  return { app, base: `/s/${TEST_SID}`, token, domain };
}

export async function rest(
  test: StripeTestApp,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  const init: RequestInit = { method };
  const headers = new Headers(extraHeaders);
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  init.headers = headers;
  const response = await test.app.request(`${test.base}${path}`, withAuth(test.token, init));
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

export async function callTool(
  test: StripeTestApp,
  tool: string,
  args: unknown
): Promise<{ status: number; body: any }> {
  const response = await test.app.request(
    `${test.base}/mcp/call`,
    withAuth(test.token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, arguments: args })
    })
  );
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}
