// SPDX-License-Identifier: Apache-2.0
//
// FDRS-478 (twin-stripe port of FDRS-476) — upstream-added-field coverage guard
// (type-only; never run).
//
// File name ends in `.types.ts`, NOT `.test.ts`: it matches the tsconfig
// `test/**/*.ts` include (so `npm run typecheck` checks it) but NOT vitest's
// `*.test.ts` glob (so it is never executed as a test). The build tsconfig
// excludes `test/`, so it never ships.
//
// For each anchored serializer, `<Name>_Allow` is the set of upstream fields the
// twin DELIBERATELY does not emit. Each `AssertNoUncovered<...> = true` line fails
// `tsc` — naming the field — the moment Stripe's official type (via the `stripe`
// devDependency) gains a field the serializer neither emits nor lists in its
// `_Allow` union. That forces an explicit cover-or-register decision in the
// `stripe`-bump PR. When typecheck is green, every `_Allow` union is provably exact:
// it equals the current real uncovered set.
//
// EDITING ANY `_Allow` UNION IS A CONSCIOUS FIDELITY DECISION — each entry is a
// field the twin is on record as choosing not to emit.
import type { AssertNoUncovered } from "../src/upstream-types.js";
import type {
  Balance,
  BalanceTransaction,
  Charge,
  PaymentIntent,
  Refund,
  StripeEvent,
} from "../src/upstream-types.js";
import {
  balanceJson,
  balanceTransactionJson,
  chargeJson,
  eventJson,
  paymentIntentJson,
  refundJson,
} from "../src/serializers.js";

// Deliberate omissions — editing any union below is a conscious fidelity decision.
// PaymentIntent leaves the x402 crypto-deposit twin does not model: `source`
// (legacy charge source), `customer_account` (Connect), `excluded_payment_method_types`,
// `hooks`, `managed_payments`, `payment_details`, `presentment_details` — none apply
// to the single-rail Base/USDC deposit flow.
type PaymentIntent_Allow =
  | "source" | "customer_account" | "excluded_payment_method_types" | "hooks"
  | "managed_payments" | "payment_details" | "presentment_details";
const _cov_paymentIntentJson: AssertNoUncovered<PaymentIntent, ReturnType<typeof paymentIntentJson>, PaymentIntent_Allow> = true;

// Charge leaves the twin does not model: `source` (legacy), `refunds` (the twin
// serves refunds via /v1/refunds, not the embedded sub-list), `presentment_details`,
// `authorization_code`, `level3`, `radar_options`, `transfer`.
type Charge_Allow =
  | "source" | "refunds" | "presentment_details" | "authorization_code"
  | "level3" | "radar_options" | "transfer";
const _cov_chargeJson: AssertNoUncovered<Charge, ReturnType<typeof chargeJson>, Charge_Allow> = true;

// Refund leaves the twin does not model: `description`, `next_action`,
// `presentment_details`, `failure_balance_transaction`, `destination_details`,
// `failure_reason`, `instructions_email`, `pending_reason` — refund failure /
// async-instruction flows absent from the synchronous crypto settlement.
type Refund_Allow =
  | "description" | "next_action" | "presentment_details"
  | "failure_balance_transaction" | "destination_details" | "failure_reason"
  | "instructions_email" | "pending_reason";
const _cov_refundJson: AssertNoUncovered<Refund, ReturnType<typeof refundJson>, Refund_Allow> = true;

// BalanceTransaction omits `balance_type` (the twin models a single settlement
// balance, no per-balance-type segmentation).
type BalanceTransaction_Allow = "balance_type";
const _cov_balanceTransactionJson: AssertNoUncovered<BalanceTransaction, ReturnType<typeof balanceTransactionJson>, BalanceTransaction_Allow> = true;

// EventBase omits the optional Connect leaves `account` (originating connected
// account) and `context` (auth context) — the twin's events are single-account.
type StripeEvent_Allow = "account" | "context";
const _cov_eventJson: AssertNoUncovered<StripeEvent, ReturnType<typeof eventJson>, StripeEvent_Allow> = true;

// Balance omits the optional product blocks `connect_reserved`, `instant_available`,
// `issuing`, `refund_and_dispute_prefunding` — the twin models only available/pending
// for the empty `usd` world (ST-DIV-011: not L1-auto-verified).
type Balance_Allow =
  | "connect_reserved" | "instant_available" | "issuing"
  | "refund_and_dispute_prefunding";
const _cov_balanceJson: AssertNoUncovered<Balance, ReturnType<typeof balanceJson>, Balance_Allow> = true;

// Reference the consts so noUnusedLocals (if enabled) stays quiet; zero runtime cost.
void [
  _cov_paymentIntentJson,
  _cov_chargeJson,
  _cov_refundJson,
  _cov_balanceTransactionJson,
  _cov_eventJson,
  _cov_balanceJson,
];
