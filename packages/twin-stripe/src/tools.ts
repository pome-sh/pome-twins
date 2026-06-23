// SPDX-License-Identifier: Apache-2.0
//
// MCP tool definitions. Owned by AGENT-B.
//
// 12 tools, names mirroring stripe-node — `create_payment_intent`,
// `retrieve_charge`, `list_events`, etc. Same shape as twin-github's
// tools.ts so the MCP wrapper in app.ts (AGENT-A) just works:
// `executeTool(domain, name, args)` and `listTools()`.

import { z } from "zod";
import type { StripeDomain } from "./domain/index.js";
import { TwinError } from "./errors.js";

// ---------- shared shapes ----------

const cryptoPMTypes = z.array(z.literal("crypto")).length(1);

const cryptoOptions = z.object({
  mode: z.literal("deposit"),
  deposit_options: z
    .object({
      networks: z.array(z.string()).min(1).optional(),
    })
    .optional(),
});

const limitShape = {
  limit: z.coerce.number().int().min(1).max(100).optional(),
};

const createdRange = {
  created: z
    .union([
      z.coerce.number().int(),
      z.object({
        gt: z.coerce.number().int().optional(),
        gte: z.coerce.number().int().optional(),
        lt: z.coerce.number().int().optional(),
        lte: z.coerce.number().int().optional(),
      }),
    ])
    .optional(),
};

type CreatedFlat = {
  created_gt?: number;
  created_gte?: number;
  created_lt?: number;
  created_lte?: number;
};

function flattenCreated(input: { created?: number | { gt?: number; gte?: number; lt?: number; lte?: number } }): CreatedFlat {
  if (input.created === undefined) return {};
  if (typeof input.created === "number") {
    return { created_gte: input.created, created_lte: input.created };
  }
  return {
    created_gt: input.created.gt,
    created_gte: input.created.gte,
    created_lt: input.created.lt,
    created_lte: input.created.lte,
  };
}

// ---------- tool definitions ----------

export const toolDefinitions = [
  {
    name: "create_payment_intent",
    description: "Create a crypto-deposit PaymentIntent (the x402 entry point).",
    schema: z.object({
      amount: z.coerce.number().int().positive(),
      currency: z.string().min(1),
      payment_method_types: cryptoPMTypes,
      payment_method_options: z
        .object({
          crypto: cryptoOptions,
        })
        .optional(),
      metadata: z.record(z.string(), z.string()).optional(),
      capture_method: z.string().optional(),
      confirmation_method: z.string().optional(),
    }),
  },
  {
    name: "retrieve_payment_intent",
    description: "Retrieve a PaymentIntent by id.",
    schema: z.object({ id: z.string().min(1) }),
  },
  {
    name: "list_payment_intents",
    description: "List PaymentIntents with optional filters.",
    schema: z.object({ ...limitShape, ...createdRange }),
  },
  {
    name: "confirm_payment_intent",
    description: "Confirm a PaymentIntent. Crypto-deposit PIs are idempotent here.",
    schema: z.object({ id: z.string().min(1) }),
  },
  {
    name: "cancel_payment_intent",
    description: "Cancel a PaymentIntent. Refused once succeeded.",
    schema: z.object({ id: z.string().min(1) }),
  },
  {
    name: "simulate_crypto_deposit",
    description: "Test helper: drive a crypto-deposit PI from requires_action through processing to succeeded.",
    schema: z.object({ id: z.string().min(1) }),
  },
  {
    name: "retrieve_charge",
    description: "Retrieve a Charge by id.",
    schema: z.object({ id: z.string().min(1) }),
  },
  {
    name: "list_charges",
    description: "List charges with optional payment_intent / customer / created filters.",
    schema: z.object({
      ...limitShape,
      ...createdRange,
      payment_intent: z.string().optional(),
      customer: z.string().optional(),
    }),
  },
  {
    name: "retrieve_balance",
    description: "Retrieve the current balance (available + pending per currency).",
    schema: z.object({}).optional(),
  },
  {
    name: "list_balance_transactions",
    description: "List balance transactions (charges, refunds, fees).",
    schema: z.object({
      ...limitShape,
      ...createdRange,
      type: z.string().optional(),
    }),
  },
  {
    name: "retrieve_event",
    description: "Retrieve an event by id.",
    schema: z.object({ id: z.string().min(1) }),
  },
  {
    name: "list_events",
    description: "List events. Filter by type and created.",
    schema: z.object({
      ...limitShape,
      ...createdRange,
      type: z.string().optional(),
    }),
  },
] as const;

export type ToolName = (typeof toolDefinitions)[number]["name"];

export function listTools() {
  return toolDefinitions.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: schemaToJson(tool.schema),
  }));
}

/** Names of tools that mutate state. The MCP route uses this for recorder annotation. */
export function isMutatingTool(name: string): boolean {
  return [
    "create_payment_intent",
    "confirm_payment_intent",
    "cancel_payment_intent",
    "simulate_crypto_deposit",
  ].includes(name);
}

/** Execute a tool by name. Mirrors twin-github's `executeTool(domain, name, input)`. */
export function executeTool(
  domain: StripeDomain,
  accountId: string,
  name: string,
  input: unknown
): unknown {
  const definition = toolDefinitions.find((tool) => tool.name === name);
  if (!definition) {
    throw new TwinError(
      "invalid_request_error",
      "tool_unknown",
      `No such MCP tool: '${name}'.`,
      { param: "tool", statusCode: 400 }
    );
  }
  const parsed = (definition.schema as z.ZodTypeAny).parse(input ?? {}) as Record<string, unknown>;
  switch (name as ToolName) {
    case "create_payment_intent":
      return domain.createPaymentIntent(accountId, parsed as never).body;
    case "retrieve_payment_intent":
      return domain.retrievePaymentIntent(accountId, parsed.id as string);
    case "list_payment_intents": {
      const flat = flattenCreated(parsed);
      return domain.listPaymentIntents(accountId, { ...parsed, ...flat } as never);
    }
    case "confirm_payment_intent":
      return domain.confirmPaymentIntent(accountId, parsed.id as string).body;
    case "cancel_payment_intent":
      return domain.cancelPaymentIntent(accountId, parsed.id as string).body;
    case "simulate_crypto_deposit":
      return domain.simulateCryptoDeposit(accountId, parsed.id as string).body;
    case "retrieve_charge":
      return domain.retrieveCharge(accountId, parsed.id as string);
    case "list_charges": {
      const flat = flattenCreated(parsed);
      return domain.listCharges(accountId, { ...parsed, ...flat } as never);
    }
    case "retrieve_balance":
      return domain.retrieveBalance(accountId);
    case "list_balance_transactions": {
      const flat = flattenCreated(parsed);
      return domain.listBalanceTransactions(accountId, { ...parsed, ...flat } as never);
    }
    case "retrieve_event":
      return domain.retrieveEvent(accountId, parsed.id as string);
    case "list_events": {
      const flat = flattenCreated(parsed);
      return domain.listEvents(accountId, { ...parsed, ...flat } as never);
    }
  }
}

/** Best-effort `z.toJSONSchema` shim. Falls back to an empty object. */
function schemaToJson(schema: z.ZodTypeAny): unknown {
  const candidate = (z as unknown as { toJSONSchema?: (schema: z.ZodTypeAny) => unknown }).toJSONSchema;
  if (typeof candidate === "function") {
    try {
      return candidate(schema);
    } catch {
      return {};
    }
  }
  return {};
}
