// SPDX-License-Identifier: Apache-2.0
import type { TwinDatabase } from "@pome-sh/sdk";
import type { FailureInjectionRule } from "@pome-sh/sdk/server";
import type { RecorderEvent } from "@pome-sh/shared-types";

// The engine's driver wrapper is the only database surface a twin sees
// (F-681/F-684): prepare/exec/pragma/transaction/close.
export type TwinStripeDatabase = TwinDatabase;

// ----- Recorder -------------------------------------------------------------
//
// RecorderEvent is the canonical wedge surface (FDRS-318). Re-exported from
// shared-types so this twin can't drift its on-wire event shape from the
// CLI / cloud parsers. The recorder mechanism lives in the engine since
// F-684; domain routes only need the `record` sink (the engine's
// RecorderHandle satisfies it structurally).

export type { RecorderEvent, StateDelta } from "@pome-sh/shared-types";

export type Recorder = {
  record(event: RecorderEvent): void;
};

// Internal helper: the fidelity values respond() and the error envelope emit.
// Narrower than the loose union the local type used to allow — canonical only
// accepts "semantic" | "unsupported".
export type StripeFidelity = "semantic" | "unsupported";


// ----- Seed -----------------------------------------------------------------

// Failure injection graduated into the engine (F-684 ruling): the rule
// store + middleware are generic twin mechanism; the rule payloads stay in
// the stripe seed. Re-exported so seed consumers keep one import site.
export type { FailureInjectionMode, FailureInjectionRule } from "@pome-sh/sdk/server";

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
  payment_method_id: string | null;
  customer_id: string | null;
  last_payment_error_json: string | null;
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
  payment_method_id: string | null;
  payment_method_details_json: string | null;
  failure_code: string | null;
  failure_decline_code: string | null;
  failure_message: string | null;
  customer_id: string | null;
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

export type CustomerRow = {
  id: string;
  account_id: string;
  name: string | null;
  email: string | null;
  description: string | null;
  phone: string | null;
  metadata_json: string;
  deleted: 0 | 1;
  created: number;
};

export type PaymentMethodRow = {
  id: string;
  account_id: string;
  type: string;
  card_brand: string;
  card_last4: string;
  card_exp_month: number;
  card_exp_year: number;
  card_fingerprint: string;
  customer_id: string | null;
  detached: 0 | 1;
  created: number;
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

// ----- Billing rows (F-734, shape tier) --------------------------------------
//
// Products / prices / subscriptions are warm surfaces (ruled F-729):
// stored rows served back in Stripe shape, no semantic state machine —
// no events emitted, no invoices minted, no billing-cycle arithmetic.

export type ProductRow = {
  id: string;
  account_id: string;
  name: string;
  description: string | null;
  active: 0 | 1;
  metadata_json: string;
  created: number;
  updated: number;
};

export type PriceRow = {
  id: string;
  account_id: string;
  product_id: string;
  currency: string;
  unit_amount: number | null;
  recurring_interval: string | null;
  recurring_interval_count: number | null;
  active: 0 | 1;
  nickname: string | null;
  lookup_key: string | null;
  metadata_json: string;
  created: number;
};

export type SubscriptionStatus = "active" | "canceled";

export type SubscriptionRow = {
  id: string;
  account_id: string;
  customer_id: string;
  status: SubscriptionStatus;
  /** JSON array of {id, price, quantity} subscription items. */
  items_json: string;
  cancel_at_period_end: 0 | 1;
  canceled_at: number | null;
  ended_at: number | null;
  metadata_json: string;
  created: number;
};

// ----- Bearer session -------------------------------------------------------

// The shape the engine's bearerAuth resolves for stripe: the F-712 hooks
// (resolveCredential / providerSession / sessionExtras in twin.ts) all
// stamp `account_id` + `via` onto the generic engine session.
export type ResolvedSession = {
  sid: string;
  account_id: string;
  // Track auth shape so handlers can branch if needed (e.g., metadata).
  via?: "jwt" | "api_key";
};
