// SPDX-License-Identifier: Apache-2.0
//
// F-684 review pins: the pre-port chassis ran failure-injection and
// idempotency session-wide (session.use("*")) BEFORE the MCP routes were
// mounted, so both cover legacy MCP dispatch. The port initially lost that
// (user routes mount after the engine MCP routes): an Idempotency-Key'd
// /mcp/call create minted duplicate PaymentIntents and injected rules on
// /mcp/* paths never fired. These tests pin the restored behavior.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createTwinStripeApp } from "../src/twin.js";
import { TEST_AUTH_SECRET, signTestToken } from "./_authHelper.js";

const SID = "mcp-mw-sid";
const sPath = (p: string) => `/s/${SID}${p}`;

const previousSecret = process.env.TWIN_AUTH_SECRET;
let token: string;
beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  token = await signTestToken({ sid: SID });
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

const jsonHeaders = () => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

async function seedRule(app: ReturnType<typeof createTwinStripeApp>, rule: Record<string, unknown>) {
  const res = await app.request("/admin/seed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ failure_injection: [rule] }),
  });
  expect(res.status).toBe(200);
}

describe("failure injection covers legacy MCP dispatch (session-wide middleware)", () => {
  it("an injected before_handler rule on POST /mcp/call fires instead of executing the tool", async () => {
    const app = createTwinStripeApp();
    await seedRule(app, {
      method: "POST",
      path: "/mcp/call",
      attempt: 1,
      mode: "before_handler",
      status: 503,
      body: { error: { type: "api_error", code: "injected", message: "Simulated MCP failure." } },
    });
    const res = await app.request(sPath("/mcp/call"), {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ tool: "retrieve_balance", arguments: {} }),
    });
    expect(res.status).toBe(503);
  });

  it("the same rule shape on a REST path still fires (control)", async () => {
    const app = createTwinStripeApp();
    await seedRule(app, {
      method: "GET",
      path: "/v1/balance",
      attempt: 1,
      mode: "before_handler",
      status: 503,
      body: { error: { type: "api_error", code: "injected", message: "Simulated REST failure." } },
    });
    const res = await app.request(sPath("/v1/balance"), { headers: jsonHeaders() });
    expect(res.status).toBe(503);
  });
});

describe("idempotency covers legacy MCP dispatch", () => {
  it("two /mcp/call create_payment_intent dispatches with one Idempotency-Key replay the same intent", async () => {
    const app = createTwinStripeApp();
    const call = () =>
      app.request(sPath("/mcp/call"), {
        method: "POST",
        headers: { ...jsonHeaders(), "idempotency-key": "mcp-idem-1" },
        body: JSON.stringify({
          tool: "create_payment_intent",
          arguments: {
            amount: 1200,
            currency: "usd",
            payment_method_types: ["crypto"],
            payment_method_options: { crypto: { mode: "deposit", deposit_options: { networks: ["base"] } } },
          },
        }),
      });
    const first = await call();
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { id?: string };
    const second = await call();
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { id?: string };
    expect(firstBody.id).toBeTruthy();
    expect(secondBody.id).toBe(firstBody.id);
  });
});
