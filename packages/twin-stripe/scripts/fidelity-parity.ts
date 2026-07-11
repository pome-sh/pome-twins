// SPDX-License-Identifier: Apache-2.0
//
// fidelity:parity — declarative parity scenario for twin-stripe (F-730).
// The runner lives in @pome-sh/sdk/parity; this file is scenario data only:
// the crypto-deposit money chain (create PI → confirm → settle → charge →
// refund → ledger → events), a second PI for the cancel path, the
// customer-management chain (F-732: customer CRUD + card-on-file
// attach/detach), and the card collect-payment chain (F-731: card PI →
// update-with-PM → confirm → succeeded), covering every MCP tool in
// fidelity.inventory.json — including the refunds chain that is live in
// code but still absent from FIDELITY.md (declared as doc_drift,
// reconciliation owned by F-733). The loud-501 probe pins the
// Stripe-shaped unsupported envelope on /v1/checkout/sessions (it moved
// off /v1/customers when F-732 made customers a supported surface).

import { join } from "node:path";
import { loadFidelityInventory, runParityCli, type ParityStep } from "@pome-sh/sdk/parity";
import { createTwinStripeApp } from "../src/twin.js";
import { listTools } from "../src/tools.js";

const createPi = {
  amount: 20000,
  currency: "usd",
  payment_method_types: ["crypto"],
  payment_method_options: { crypto: { mode: "deposit", deposit_options: { networks: ["base"] } } },
};

const steps: ParityStep[] = [
  {
    tool: "create_payment_intent",
    arguments: createPi,
    capture: (body, state) => {
      state.pi = (body as { id?: string }).id;
    },
  },
  { tool: "retrieve_payment_intent", arguments: (state) => ({ id: state.pi }) },
  { tool: "confirm_payment_intent", arguments: (state) => ({ id: state.pi }) },
  {
    tool: "simulate_crypto_deposit",
    arguments: (state) => ({ id: state.pi }),
    capture: (body, state) => {
      state.charge = (body as { latest_charge?: string }).latest_charge;
    },
  },
  { tool: "list_payment_intents", arguments: { limit: 10 } },
  { tool: "retrieve_charge", arguments: (state) => ({ id: state.charge }) },
  { tool: "list_charges", arguments: (state) => ({ payment_intent: state.pi }) },
  {
    tool: "create_refund",
    arguments: (state) => ({ charge: state.charge, amount: 7500 }),
    capture: (body, state) => {
      state.refund = (body as { id?: string }).id;
    },
  },
  { tool: "retrieve_refund", arguments: (state) => ({ id: state.refund }) },
  { tool: "list_refunds", arguments: (state) => ({ charge: state.charge }) },
  { tool: "retrieve_balance" },
  { tool: "list_balance_transactions", arguments: { limit: 10 } },
  {
    tool: "list_events",
    arguments: { limit: 10 },
    capture: (body, state) => {
      state.event = (body as { data?: Array<{ id?: string }> }).data?.[0]?.id;
    },
  },
  { tool: "retrieve_event", arguments: (state) => ({ id: state.event }) },
  // Second PI: the cancel path (a settled PI refuses cancellation)
  {
    tool: "create_payment_intent",
    arguments: createPi,
    capture: (body, state) => {
      state.pi2 = (body as { id?: string }).id;
    },
  },
  { tool: "cancel_payment_intent", arguments: (state) => ({ id: state.pi2 }) },
  // Customer-management chain (F-732): CRUD + card-on-file attach/detach.
  {
    tool: "create_customer",
    arguments: { name: "Parity Customer", email: "parity@example.com", metadata: { a: "1" } },
    capture: (body, state) => {
      state.customer = (body as { id?: string }).id;
    },
  },
  { tool: "retrieve_customer", arguments: (state) => ({ id: state.customer }) },
  {
    tool: "update_customer",
    arguments: (state) => ({ id: state.customer, name: "Parity Customer II", metadata: { a: "", b: "2" } }),
    verify: (body) => {
      const metadata = (body as { metadata?: Record<string, string> }).metadata ?? {};
      if (metadata.a !== undefined) return "metadata key 'a' should have been unset by the empty value";
      if (metadata.b !== "2") return "metadata key 'b' should have been merged in";
      return undefined;
    },
  },
  { tool: "list_customers", arguments: { limit: 10 } },
  {
    tool: "create_payment_method",
    arguments: { type: "card", card: { number: "4242424242424242", exp_month: 12, exp_year: 2032 } },
    capture: (body, state) => {
      state.pm = (body as { id?: string }).id;
    },
  },
  { tool: "retrieve_payment_method", arguments: (state) => ({ id: state.pm }) },
  {
    tool: "attach_payment_method",
    arguments: (state) => ({ id: state.pm, customer: state.customer }),
    verify: (body) =>
      (body as { customer?: string | null }).customer ? undefined : "attach should set customer",
  },
  {
    tool: "list_customer_payment_methods",
    arguments: (state) => ({ customer: state.customer }),
    verify: (body) =>
      ((body as { data?: unknown[] }).data?.length ?? 0) === 1
        ? undefined
        : "customer should list exactly the attached PM",
  },
  {
    tool: "detach_payment_method",
    arguments: (state) => ({ id: state.pm }),
    verify: (body) =>
      (body as { customer?: string | null }).customer === null ? undefined : "detach should clear customer",
  },
  { tool: "delete_customer", arguments: (state) => ({ id: state.customer }) },
  // Card collect-payment chain (F-731): create bare card PI → attach a PM
  // via update (the ruled retry step) → confirm → synchronous settle.
  {
    tool: "create_payment_intent",
    arguments: { amount: 12000, currency: "usd", payment_method_types: ["card"] },
    capture: (body, state) => {
      state.cardPi = (body as { id?: string }).id;
    },
    verify: (body) =>
      (body as { status?: string }).status === "requires_payment_method"
        ? undefined
        : "a card PI without a PM should start in requires_payment_method",
  },
  {
    tool: "create_payment_method",
    arguments: { type: "card", card: { number: "4242424242424242", exp_month: 12, exp_year: 2033 } },
    capture: (body, state) => {
      state.cardPm = (body as { id?: string }).id;
    },
  },
  {
    tool: "update_payment_intent",
    arguments: (state) => ({ id: state.cardPi, payment_method: state.cardPm }),
    verify: (body) =>
      (body as { status?: string }).status === "requires_confirmation"
        ? undefined
        : "attaching a PM should move the card PI to requires_confirmation",
  },
  {
    tool: "confirm_payment_intent",
    arguments: (state) => ({ id: state.cardPi }),
    verify: (body) =>
      (body as { status?: string }).status === "succeeded"
        ? undefined
        : "confirming a good card should settle synchronously",
  },
];

await runParityCli({
  app: createTwinStripeApp(),
  twin: "stripe",
  inventory: loadFidelityInventory(join(import.meta.dirname, "..", "fidelity.inventory.json")),
  liveToolNames: listTools().map((tool) => tool.name),
  steps,
  restProbes: [
    { surface: "unsupported-rest", path: "/v1/checkout/sessions", status: 501, expectUnsupportedEnvelope: true },
  ],
});
