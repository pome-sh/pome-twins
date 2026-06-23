// SPDX-License-Identifier: Apache-2.0
//
// MCP tool contract — every v1 tool callable via /mcp/call AND /mcp/tools/:name.
// Mirrors twin-github's mcp-contract test pattern.

import { describe, expect, it } from "vitest";
import { createStripeApp, rest, withAuth, callTool } from "./_appHelper.js";
import { toolDefinitions } from "../src/tools.js";

const TOOL_NAMES = toolDefinitions.map((t) => t.name);

describe("MCP tools", () => {
  it("listTools returns 12 tools", async () => {
    const app = await createStripeApp();
    const tools = await rest(app, "GET", "/mcp/tools");
    expect(tools.status).toBe(200);
    expect(tools.body.tools).toHaveLength(12);
    const names = tools.body.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(
      [
        "cancel_payment_intent",
        "confirm_payment_intent",
        "create_payment_intent",
        "list_balance_transactions",
        "list_charges",
        "list_events",
        "list_payment_intents",
        "retrieve_balance",
        "retrieve_charge",
        "retrieve_event",
        "retrieve_payment_intent",
        "simulate_crypto_deposit",
      ].sort()
    );
  });

  it("every tool is callable through /mcp/call", async () => {
    expect(TOOL_NAMES).toHaveLength(12);
    for (const name of TOOL_NAMES) {
      const app = await createStripeApp();
      const args = await argsFor(app, name);
      const result = await callTool(app, name, args);
      expect.soft(result.status, `tool ${name}`).toBe(200);
      expect(result.body).toBeTruthy();
    }
  });

  it("every tool is callable through /mcp/tools/:name", async () => {
    for (const name of TOOL_NAMES) {
      const app = await createStripeApp();
      const args = await argsFor(app, name);
      const r = await app.app.request(
        `${app.base}/mcp/tools/${name}`,
        withAuth(app.token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args),
        })
      );
      expect.soft(r.status, `tool ${name}`).toBe(200);
    }
  });

  it("rejects unknown tool name with Stripe-shaped error", async () => {
    const app = await createStripeApp();
    const result = await callTool(app, "totally_made_up_tool", {});
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body.error).toBeTruthy();
  });
});

/** Build minimum-viable args for each tool against a fresh app. */
async function argsFor(
  app: Awaited<ReturnType<typeof createStripeApp>>,
  name: string
): Promise<unknown> {
  // For tools that need an existing PI/charge/event, mint and settle one.
  switch (name) {
    case "create_payment_intent":
      return {
        amount: 100,
        currency: "usd",
        payment_method_types: ["crypto"],
        payment_method_options: {
          crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
        },
      };
    case "list_payment_intents":
    case "list_charges":
    case "list_balance_transactions":
    case "list_events":
    case "retrieve_balance":
      return {};
    case "retrieve_payment_intent":
    case "confirm_payment_intent":
    case "cancel_payment_intent":
    case "simulate_crypto_deposit": {
      const pi = await rest(app, "POST", "/v1/payment_intents", {
        amount: 100,
        currency: "usd",
        payment_method_types: ["crypto"],
        payment_method_options: {
          crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
        },
      });
      return { id: pi.body.id };
    }
    case "retrieve_charge": {
      const pi = await rest(app, "POST", "/v1/payment_intents", {
        amount: 100,
        currency: "usd",
        payment_method_types: ["crypto"],
        payment_method_options: {
          crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
        },
      });
      const settle = await rest(
        app,
        "POST",
        `/v1/test_helpers/payment_intents/${pi.body.id}/simulate_crypto_deposit`
      );
      return { id: settle.body.latest_charge };
    }
    case "retrieve_event": {
      await rest(app, "POST", "/v1/payment_intents", {
        amount: 100,
        currency: "usd",
        payment_method_types: ["crypto"],
        payment_method_options: {
          crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
        },
      });
      const events = await rest(app, "GET", "/v1/events");
      return { id: events.body.data[0].id };
    }
    default:
      return {};
  }
}
