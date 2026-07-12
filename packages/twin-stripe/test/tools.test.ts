// SPDX-License-Identifier: Apache-2.0
//
// MCP tool contract — every v1 tool callable via /mcp/call AND /mcp/tools/:name.
// Mirrors twin-github's mcp-contract test pattern.

import { describe, expect, it } from "vitest";
import { createStripeApp, rest, withAuth, callTool } from "./_appHelper.js";
import { toolDefinitions } from "../src/tools.js";

const TOOL_NAMES = toolDefinitions.map((t) => t.name);

describe("MCP tools", () => {
  it("listTools returns 26 tools", async () => {
    const app = await createStripeApp();
    const tools = await rest(app, "GET", "/mcp/tools");
    expect(tools.status).toBe(200);
    expect(tools.body.tools).toHaveLength(26);
    const names = tools.body.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(
      [
        "attach_payment_method",
        "cancel_payment_intent",
        "confirm_payment_intent",
        "create_customer",
        "create_payment_intent",
        "create_payment_method",
        "create_refund",
        "delete_customer",
        "detach_payment_method",
        "list_balance_transactions",
        "list_charges",
        "list_customer_payment_methods",
        "list_customers",
        "list_events",
        "list_payment_intents",
        "list_refunds",
        "retrieve_balance",
        "retrieve_charge",
        "retrieve_customer",
        "retrieve_event",
        "retrieve_payment_intent",
        "retrieve_payment_method",
        "retrieve_refund",
        "simulate_crypto_deposit",
        "update_customer",
        "update_payment_intent",
      ].sort()
    );
  });

  it("every tool is callable through /mcp/call", async () => {
    expect(TOOL_NAMES).toHaveLength(26);
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
    case "list_refunds":
    case "list_customers":
    case "retrieve_balance":
      return {};
    case "create_customer":
      return { name: "Ada Lovelace", email: "ada@example.com" };
    case "retrieve_customer":
    case "update_customer":
    case "delete_customer":
    case "list_customer_payment_methods": {
      const customer = await callTool(app, "create_customer", { name: "Ada" });
      if (name === "update_customer") return { id: customer.body.id, name: "Ada L" };
      if (name === "list_customer_payment_methods") return { customer: customer.body.id };
      return { id: customer.body.id };
    }
    case "create_payment_method":
      return {
        type: "card",
        card: { number: "4242424242424242", exp_month: 12, exp_year: 2032, cvc: "123" },
      };
    case "retrieve_payment_method":
    case "detach_payment_method":
    case "attach_payment_method": {
      const pm = await callTool(app, "create_payment_method", {
        type: "card",
        card: { number: "4242424242424242", exp_month: 12, exp_year: 2032 },
      });
      if (name === "retrieve_payment_method") return { id: pm.body.id };
      const customer = await callTool(app, "create_customer", { name: "Ada" });
      if (name === "attach_payment_method") return { id: pm.body.id, customer: customer.body.id };
      // detach: attach first so the detach succeeds.
      await callTool(app, "attach_payment_method", { id: pm.body.id, customer: customer.body.id });
      return { id: pm.body.id };
    }
    case "create_refund": {
      const charge = await settleCharge(app);
      return { charge };
    }
    case "retrieve_refund": {
      const charge = await settleCharge(app);
      const refund = await callTool(app, "create_refund", { charge });
      return { id: refund.body.id };
    }
    case "update_payment_intent": {
      const pi = await rest(app, "POST", "/v1/payment_intents", {
        amount: 100,
        currency: "usd",
        payment_method_types: ["card"],
      });
      return { id: pi.body.id, metadata: { note: "updated" } };
    }
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

/** Mint a crypto-deposit PI and settle it, returning the settled charge id. */
async function settleCharge(app: Awaited<ReturnType<typeof createStripeApp>>): Promise<string> {
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
  return settle.body.latest_charge as string;
}
