// SPDX-License-Identifier: Apache-2.0
import { serve, type ServerType } from "@hono/node-server";
import { describe, expect, it } from "vitest";
import { getAvailablePort } from "../../../src/runner/ports.js";
import { bootTwin, STRIPE_LOCAL_ACCOUNT_ID, type TwinHarness } from "../../../src/twin/twinHarness.js";

const apiKey = "sk_test_pome_default";
const base = "http://twin.test/s/default";

async function json(
  harness: TwinHarness,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await harness.app.fetch(new Request(`${base}${path}`, init));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function fullyRefundedCharge(harness: TwinHarness): Promise<string> {
  const paymentIntent = await json(harness, "POST", "/v1/payment_intents", {
    amount: 20000,
    currency: "usd",
    payment_method_types: ["crypto"],
    payment_method_options: { crypto: { mode: "deposit", deposit_options: { networks: ["base"] } } },
  });
  expect(paymentIntent.status).toBe(200);

  const settled = await json(
    harness,
    "POST",
    `/v1/test_helpers/payment_intents/${paymentIntent.body.id}/simulate_crypto_deposit`,
  );
  expect(settled.status).toBe(200);

  const charge = settled.body.latest_charge as string;
  const refund = await json(harness, "POST", "/v1/refunds", { charge });
  expect(refund.status).toBe(200);
  return charge;
}

describe("bootTwin stripe harness", () => {
  it("serves the vendored Stripe package MCP refund surface and records rejected calls", async () => {
    const harness = await bootTwin({
      twin: "stripe",
      runId: "cli-stripe-vendor-test",
      seedState: {
        api_keys: [{ key: apiKey, sid: "default", account_id: STRIPE_LOCAL_ACCOUNT_ID }],
      },
    });

    try {
      const tools = await json(harness, "GET", "/mcp/tools");
      expect(tools.status).toBe(200);
      expect(tools.body.tools.map((tool: { name: string }) => tool.name)).toContain("create_refund");

      const charge = await fullyRefundedCharge(harness);
      const before = harness.events().length;
      const rpc = await json(harness, "POST", "/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_refund", arguments: { charge } },
      });

      expect(rpc.status).toBe(200);
      expect(rpc.body.result?.isError).toBe(true);
      expect(JSON.stringify(rpc.body.result)).toContain("charge_already_refunded");

      const recorded = harness.events().slice(before);
      const attempt = recorded.find(
        (event) => event.path.endsWith("/mcp") && (event.request_body as any)?.tool === "create_refund",
      );
      expect(attempt, "the rejected JSON-RPC refund attempt must be recorded").toBeTruthy();
      expect(attempt!.error).toBeTruthy();
    } finally {
      harness.close();
    }
  });

  it("mounts the package x402 protected-resource route for local runs", async () => {
    const port = await getAvailablePort();
    const twinBaseUrl = `http://127.0.0.1:${port}`;
    const harness = await bootTwin({
      twin: "stripe",
      runId: "cli-stripe-x402-test",
      twinBaseUrl,
      seedState: {
        api_keys: [{ key: apiKey, sid: "default", account_id: STRIPE_LOCAL_ACCOUNT_ID }],
      },
    });
    let server: ServerType | undefined;

    try {
      await new Promise<void>((resolve) => {
        server = serve({ fetch: harness.app.fetch, port, hostname: "127.0.0.1" }, () => resolve());
      });

      const response = await fetch(`${twinBaseUrl}/s/default/x402/protected-resource`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(response.status).toBe(402);
      const body = await response.json() as { accepts: Array<{ payTo: string; maxAmountRequired: string }> };
      expect(body.accepts[0]).toMatchObject({
        maxAmountRequired: "10000",
        payTo: expect.stringMatching(/^0x/),
      });

      const state = await harness.exportState() as { payment_intents: Array<{ metadata?: Record<string, string> }> };
      expect(state.payment_intents).toHaveLength(1);
      expect(state.payment_intents[0]?.metadata).toMatchObject({
        x402_route: "GET /x402/protected-resource",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        if (!server) return resolve();
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
      harness.close();
    }
  });
});
