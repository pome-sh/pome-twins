// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";
import type { RecorderEvent } from "@pome-sh/shared-types";

export type TwinStripeDatabase = Database.Database;

// ----- Recorder -------------------------------------------------------------
//
// RecorderEvent is the canonical wedge surface (FDRS-318). Re-exported from
// shared-types so this twin can't drift its on-wire event shape from the
// CLI / cloud parsers.

export type { RecorderEvent, StateDelta } from "@pome-sh/shared-types";

export type Recorder = {
  record(event: RecorderEvent): void;
  events(): RecorderEvent[];
  dropped(): number;
};

// Internal helper: the fidelity values respond() and the error envelope emit.
// Narrower than the loose union the local type used to allow — canonical only
// accepts "semantic" | "unsupported".
export type StripeFidelity = "semantic" | "unsupported";


// ----- Seed -----------------------------------------------------------------

export type FailureInjectionMode = "before_handler" | "after_handler";

export type FailureInjectionRule = {
  method: string;
  path: string;
  attempt: number;
  mode: FailureInjectionMode;
  status: number;
  body: unknown;
};

// Forward-declared row shapes for the seed collections live in `seed.ts`
// (they're zod-inferred there). The `SeedState` type here uses loose
// structural shapes so this module stays free of zod / seed-specific
// imports — keeping the value-level seed schema and the value-level row
// schema in their respective files.
export type SeedPaymentIntent = {
  id: string;
  account_id: string;
  amount: number;
  currency: string;
  status: PIStatus;
  payment_method_types: string[];
  next_action?: unknown | null;
  latest_charge_id?: string | null;
  capture_method: string;
  confirmation_method: string;
  idempotency_key?: string | null;
  metadata: Record<string, string>;
  crypto_deposit?: unknown | null;
  client_secret: string;
  created: number;
  updated: number;
  canceled_at?: number | null;
  captured_at?: number | null;
};

export type SeedCharge = {
  id: string;
  account_id: string;
  payment_intent_id: string;
  amount: number;
  amount_captured: number;
  amount_refunded: number;
  status: "pending" | "succeeded" | "failed";
  balance_transaction_id?: string | null;
  captured: boolean;
  currency: string;
  created: number;
};

export type SeedRefund = {
  id: string;
  account_id: string;
  charge_id: string;
  payment_intent_id: string;
  amount: number;
  currency: string;
  status: RefundStatus;
  reason?: string | null;
  idempotency_key?: string | null;
  created: number;
};

export type SeedBalanceTransaction = {
  id: string;
  account_id: string;
  type: string;
  amount: number;
  fee: number;
  net: number;
  currency: string;
  source_id?: string | null;
  source_type?: string | null;
  available_on: number;
  status: "pending" | "available";
  created: number;
};

export type SeedState = {
  api_keys?: Array<{
    key: string;
    sid: string;
    account_id?: string;
  }>;
  failure_injection?: FailureInjectionRule[];
  payment_intents?: SeedPaymentIntent[];
  charges?: SeedCharge[];
  refunds?: SeedRefund[];
  balance_transactions?: SeedBalanceTransaction[];
};

// ----- Row types ------------------------------------------------------------

export type ApiKeyRow = {
  key: string;
  sid: string;
  account_id: string;
  created_at: string;
  revoked_at: string | null;
};

export type IdempotencyKeyRow = {
  key: string;
  account_id: string;
  method: string;
  path: string;
  request_hash: string;
  response_status: number;
  response_body_json: string;
  created_at: string;
};

// ----- Stripe domain row STUBS (AGENT-B fills in domain logic; tables exist now) ----

/**
 * v1 PaymentIntent row. Stub — AGENT-B owns domain operations.
 * Schema for v1 x402 crypto-deposit PIs
 * (`crypto_deposit_json` carries deposit address + supported tokens).
 */
export type PIStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "requires_capture"
  | "canceled"
  | "succeeded";

export type PIRow = {
  id: string;
  account_id: string;
  amount: number;
  currency: string;
  status: PIStatus;
  payment_method_types_json: string;
  next_action_json: string | null;
  latest_charge_id: string | null;
  capture_method: string;
  confirmation_method: string;
  idempotency_key: string | null;
  metadata_json: string;
  crypto_deposit_json: string | null;
  client_secret: string;
  created: number;
  updated: number;
  canceled_at: number | null;
  captured_at: number | null;
};

export type ChargeRow = {
  id: string;
  account_id: string;
  payment_intent_id: string;
  amount: number;
  amount_captured: number;
  amount_refunded: number;
  status: "pending" | "succeeded" | "failed";
  balance_transaction_id: string | null;
  captured: 0 | 1;
  created: number;
  currency: string;
};

export type BalanceTxRow = {
  id: string;
  account_id: string;
  type: string;
  amount: number;
  fee: number;
  net: number;
  currency: string;
  source_id: string | null;
  source_type: string | null;
  available_on: number;
  created: number;
  status: "pending" | "available";
};

export type EventRow = {
  id: string;
  account_id: string;
  type: string;
  data_json: string;
  request_idempotency_key: string | null;
  livemode: 0 | 1;
  created: number;
  api_version: string;
};

export type RefundStatus = "succeeded" | "pending" | "failed" | "canceled";

export type RefundRow = {
  id: string;
  account_id: string;
  charge_id: string;
  payment_intent_id: string;
  amount: number;
  currency: string;
  status: RefundStatus;
  reason: string | null;
  idempotency_key: string | null;
  created: number;
};

// ----- Bearer claims --------------------------------------------------------

export interface SessionClaims {
  sid: string;
  account_id?: string;
  exp?: number;
}

export type ResolvedSession = {
  sid: string;
  account_id: string;
  // Track auth shape so handlers can branch if needed (e.g., metadata).
  via: "jwt" | "api_key";
};
