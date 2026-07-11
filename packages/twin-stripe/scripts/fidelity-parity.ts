// SPDX-License-Identifier: Apache-2.0
//
// fidelity:parity — declarative parity scenario for twin-stripe (F-730).
// The runner lives in @pome-sh/sdk/parity; this file is scenario data only:
// the crypto-deposit money chain (create PI → confirm → settle → charge →
// refund → ledger → events) plus a second PI for the cancel path, covering
// every MCP tool in fidelity.inventory.json — including the refunds chain
// that is live in code but still absent from FIDELITY.md (declared as
// doc_drift, reconciliation owned by F-733). The loud-501 probe pins the
// Stripe-shaped unsupported envelope on /v1/customers.

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
];

await runParityCli({
  app: createTwinStripeApp(),
  twin: "stripe",
  inventory: loadFidelityInventory(join(import.meta.dirname, "..", "fidelity.inventory.json")),
  liveToolNames: listTools().map((tool) => tool.name),
  steps,
  restProbes: [
    { surface: "unsupported-rest", path: "/v1/customers", status: 501, expectUnsupportedEnvelope: true },
  ],
});
