// SPDX-License-Identifier: Apache-2.0
//
// Row → Stripe-shape JSON serializers. Owned by AGENT-B.
// Mirrors twin-github/src/serializers.ts in spirit — pure functions,
// row in / object out.

import type {
  PIRow,
  ChargeRow,
  BalanceTxRow,
  CustomerRow,
  EventRow,
  PaymentMethodRow,
  RefundRow,
} from "./types.js";
import type {
  ApiList,
  BalanceTransaction,
  Balance,
  Charge,
  Customer,
  DeepPartial,
  DeletedCustomer,
  PaymentIntent,
  PaymentMethod,
  Refund,
  StripeEvent,
} from "./upstream-types.js";
import { STRIPE_API_VERSION } from "./domain/constants.js";
import { piTypes } from "./domain/payment-intents.js";

export function paymentIntentJson(row: PIRow) {
  // LIFT via named, type-annotated variable spread (the github `parentRef` trick:
  // a spread from a named variable bypasses TS excess-property checks, so the
  // divergent fields are allowed while every directly-written field below stays
  // strictly checked against PaymentIntent). Two divergences ride this lift:
  //   • x402 (ST-DIV-012): `payment_method_options.crypto.{mode, deposit_options}`
  //     are x402 deposit-mode fields — official `PaymentMethodOptions.Crypto` only
  //     carries `setup_future_usage`.
  //   • wire-version delta (ST-DIV-015): the twin still emits `invoice` (faithful
  //     to wire apiVersion 2026-03-04.preview); the anchor library stripe@22.2.0
  //     (2026-05-27.dahlia) DROPPED `invoice` from PaymentIntent.
  // Card PIs (F-731) carry Stripe's default card options instead of the
  // crypto rail. piTypes is the one rail predicate (domain uses it too).
  const types = piTypes(row);
  const wireLift: {
    payment_method_options: Record<string, unknown>;
    invoice: string | null;
  } = {
    payment_method_options: types.includes("card")
      ? {
          card: {
            installments: null,
            mandate_options: null,
            network: null,
            request_three_d_secure: "automatic",
          },
        }
      : {
          crypto: {
            mode: "deposit",
            deposit_options: { networks: ["base"] },
          },
        },
    invoice: null,
  };
  return {
    id: row.id,
    object: "payment_intent",
    amount: row.amount,
    amount_capturable: 0,
    amount_received: row.status === "succeeded" ? row.amount : 0,
    amount_details: { tip: {} },
    application: null,
    application_fee_amount: null,
    automatic_payment_methods: null,
    canceled_at: row.canceled_at,
    cancellation_reason: null,
    // Twin row columns carry the literal Stripe values; the row type is a free
    // `string`. Narrow to the upstream literal union for the type anchor only
    // (FDRS-454: the twin faithfully emits a real upstream value), runtime unchanged.
    capture_method: row.capture_method as PaymentIntent["capture_method"],
    client_secret: row.client_secret,
    confirmation_method: row.confirmation_method as PaymentIntent["confirmation_method"],
    created: row.created,
    currency: row.currency,
    customer: row.customer_id,
    description: null,
    // Card declines (F-731): the last failed attempt, parsed from the row.
    // The stored blob is Stripe's LastPaymentError shape; narrow for the
    // type anchor only (FDRS-454), runtime unchanged.
    last_payment_error: parseJson(
      row.last_payment_error_json,
      null
    ) as PaymentIntent["last_payment_error"],
    latest_charge: row.latest_charge_id,
    livemode: false,
    metadata: parseJson(row.metadata_json, {}),
    next_action: row.status === "requires_action" ? parseJson(row.next_action_json, null) : null,
    on_behalf_of: null,
    payment_method: row.payment_method_id,
    payment_method_configuration_details: null,
    payment_method_types: types,
    processing: null,
    receipt_email: null,
    review: null,
    setup_future_usage: null,
    shipping: null,
    statement_descriptor: null,
    statement_descriptor_suffix: null,
    status: row.status,
    transfer_data: null,
    transfer_group: null,
    ...wireLift,
  } satisfies DeepPartial<PaymentIntent>;
}

export function chargeJson(row: ChargeRow) {
  // wire-version delta LIFT (ST-DIV-015): the twin still emits `invoice` (faithful
  // to wire apiVersion 2026-03-04.preview); the anchor library stripe@22.2.0
  // (2026-05-27.dahlia) DROPPED `invoice` from Charge. Named-variable spread so the
  // divergent field is allowed while every directly-written field stays checked.
  const wireLift: { invoice: string | null } = { invoice: null };
  const failed = row.status === "failed";
  // Card charges (F-731) store their PM details at mint time; crypto
  // charges keep the x402 deposit rail shape.
  const paymentMethodDetails = parseJson(row.payment_method_details_json, {
    type: "crypto",
    crypto: {
      // Upstream `Charge.PaymentMethodDetails.Crypto.{buyer_address,transaction_hash}`
      // are `string | undefined`; the twin surfaces `null` pre-settlement (no
      // on-chain tx yet). Narrow the pre-resolution null for the type anchor only
      // (FDRS-454), runtime value (null) unchanged.
      buyer_address: null as unknown as string | undefined,
      network: "base",
      token_currency: "usdc",
      transaction_hash: null as unknown as string | undefined,
    },
  });
  return {
    id: row.id,
    object: "charge",
    amount: row.amount,
    amount_captured: row.amount_captured,
    amount_refunded: row.amount_refunded,
    application: null,
    application_fee: null,
    application_fee_amount: null,
    balance_transaction: row.balance_transaction_id,
    billing_details: {
      address: { city: null, country: null, line1: null, line2: null, postal_code: null, state: null },
      email: null,
      name: null,
      phone: null,
    },
    calculated_statement_descriptor: null,
    captured: Boolean(row.captured),
    created: row.created,
    currency: row.currency,
    customer: row.customer_id,
    description: null,
    disputed: false,
    failure_balance_transaction: null,
    // Twin failure columns carry Stripe's literal decline codes; the row
    // type is a free `string`. Narrow for the type anchor only (FDRS-454).
    failure_code: row.failure_code as Charge["failure_code"],
    failure_message: row.failure_message,
    fraud_details: {},
    livemode: false,
    metadata: {},
    on_behalf_of: null,
    outcome: failed
      ? {
          network_status: "declined_by_network",
          reason: row.failure_decline_code,
          risk_level: "normal",
          seller_message: "The bank did not return any further details with this decline.",
          type: "issuer_declined",
        }
      : {
          network_status: "approved_by_network",
          reason: null,
          risk_level: "normal",
          seller_message: "Payment complete.",
          type: "authorized",
        },
    paid: row.status === "succeeded",
    payment_intent: row.payment_intent_id,
    payment_method: row.payment_method_id,
    // Stored blob is spec-faithful (built from the PM row at mint time);
    // narrow for the type anchor only (FDRS-454).
    payment_method_details: paymentMethodDetails as Charge["payment_method_details"],
    receipt_email: null,
    receipt_number: null,
    receipt_url: null,
    // Stripe semantics: `refunded` is true iff the charge is FULLY refunded.
    // Partial refunds leave `amount_refunded > 0` but `refunded === false`.
    refunded: row.amount_refunded >= row.amount,
    review: null,
    shipping: null,
    source_transfer: null,
    statement_descriptor: null,
    statement_descriptor_suffix: null,
    status: row.status,
    transfer_data: null,
    transfer_group: null,
    ...wireLift,
  } satisfies DeepPartial<Charge>;
}

export function refundJson(row: RefundRow) {
  return {
    id: row.id,
    object: "refund",
    amount: row.amount,
    balance_transaction: row.balance_transaction_id,
    charge: row.charge_id,
    created: row.created,
    currency: row.currency,
    metadata: {},
    payment_intent: row.payment_intent_id,
    // Twin row `reason` is a free `string`; upstream `Refund.Reason` is a literal
    // union. Narrow for the type anchor only (FDRS-454), runtime unchanged.
    reason: row.reason as Refund["reason"],
    receipt_number: null,
    source_transfer_reversal: null,
    status: row.status,
    transfer_reversal: null,
  } satisfies DeepPartial<Refund>;
}

export function customerJson(row: CustomerRow) {
  return {
    id: row.id,
    object: "customer",
    address: null,
    balance: 0,
    created: row.created,
    currency: null,
    default_source: null,
    delinquent: false,
    description: row.description,
    discount: null,
    email: row.email,
    invoice_settings: {
      custom_fields: null,
      default_payment_method: null,
      footer: null,
      rendering_options: null,
    },
    livemode: false,
    metadata: parseJson(row.metadata_json, {}),
    name: row.name,
    phone: row.phone,
    preferred_locales: [],
    shipping: null,
    tax_exempt: "none",
    test_clock: null,
  } satisfies DeepPartial<Customer>;
}

/**
 * Real Stripe serves this stub for DELETE and for every retrieve of a
 * deleted customer — three fields, nothing else.
 */
export function deletedCustomerJson(row: CustomerRow) {
  return {
    id: row.id,
    object: "customer",
    deleted: true,
  } satisfies DeepPartial<DeletedCustomer>;
}

/**
 * The card block shared by PaymentMethod.card and (via the domain's
 * cardChargeDetails) Charge.payment_method_details.card — one source so the
 * two surfaces can never drift for the same PM.
 */
export function cardJson(row: PaymentMethodRow) {
  return {
    brand: row.card_brand,
    exp_month: row.card_exp_month,
    exp_year: row.card_exp_year,
    fingerprint: row.card_fingerprint,
    funding: "credit",
    last4: row.card_last4,
  };
}

export function paymentMethodJson(row: PaymentMethodRow) {
  return {
    id: row.id,
    object: "payment_method",
    billing_details: {
      address: { city: null, country: null, line1: null, line2: null, postal_code: null, state: null },
      email: null,
      name: null,
      phone: null,
    },
    card: cardJson(row),
    created: row.created,
    customer: row.customer_id,
    livemode: false,
    metadata: {},
    // Twin row `type` is a free `string`; upstream `PaymentMethod.type` is a
    // literal union. Narrow for the type anchor only (FDRS-454), runtime
    // value ("card") unchanged.
    type: row.type as PaymentMethod["type"],
  } satisfies DeepPartial<PaymentMethod>;
}

export function balanceTransactionJson(row: BalanceTxRow) {
  return {
    id: row.id,
    object: "balance_transaction",
    amount: row.amount,
    available_on: row.available_on,
    created: row.created,
    currency: row.currency,
    description: null,
    exchange_rate: null,
    fee: row.fee,
    fee_details: [],
    net: row.net,
    reporting_category: row.type,
    source: row.source_id,
    status: row.status,
    // Upstream `BalanceTransaction.Type` is a literal union; the twin's ledger
    // `type` column is a free `string` (carries the x402 deposit categories).
    // Narrow for the type anchor only (FDRS-454), runtime value unchanged.
    type: row.type as BalanceTransaction["type"],
  } satisfies DeepPartial<BalanceTransaction>;
}

export function eventJson(row: EventRow) {
  const parsedData = parseJson(row.data_json, { object: null }) as { object: unknown };
  return {
    id: row.id,
    object: "event",
    api_version: row.api_version,
    created: row.created,
    // LIFT (ST-DIV-014): the twin stores the event payload as an opaque parsed
    // JSON blob (`data.object: unknown`); upstream `Event.Data.object` is a typed
    // resource union. Narrow for the type anchor only (FDRS-454), runtime unchanged.
    data: parsedData as StripeEvent["data"],
    livemode: Boolean(row.livemode),
    pending_webhooks: 0,
    request: {
      id: null,
      idempotency_key: row.request_idempotency_key,
    },
    // LIFT (ST-DIV-014): twin emits a free `string`; official `EventBase.type`
    // is the `Event.Type` literal union. Narrow for the anchor only (FDRS-454).
    type: row.type as StripeEvent["type"],
  } satisfies DeepPartial<StripeEvent>;
}

/**
 * Stripe-shape paginated list. Real Stripe lists carry a `url` field (the
 * canonical path of the resource type), `data`, and `has_more`.
 */
export function serializedList<T>(
  data: T[],
  hasMore: boolean,
  _limit: number,
  url: string
) {
  const envelope = {
    object: "list" as const,
    data,
    has_more: hasMore,
    url,
  };
  // Envelope shape anchor (object: "list" / data / has_more / url). The check runs
  // against the upstream `ApiList<T>` shape but does NOT widen the returned type —
  // `envelope` stays `{ object: "list"; data: T[]; has_more; url }`, so the public
  // return type carries no reference to the `stripe` declaration files (which would
  // be a non-portable inferred-type leak in domain method signatures). Each item `T`
  // is produced by an already-anchored per-resource serializer, so the elements are
  // spec-faithful by construction; `DeepPartial<T>[]` bridges the opaque generic.
  void (envelope as Omit<typeof envelope, "data"> & { data: DeepPartial<T>[] } satisfies DeepPartial<ApiList<T>>);
  return envelope;
}

/**
 * GET /v1/balance response (object: "balance"). Anchored against the upstream
 * `Balance` shape (available/pending arrays of {amount, currency, source_types}).
 * The twin's empty `usd` world surfaces empty available/pending arrays — a faithful
 * SUBSET (ST-DIV-011: not L1-auto-verified), so omitting per-currency entries and
 * the optional `connect_reserved` / `instant_available` / `issuing` blocks is legal.
 */
export function balanceJson(available: unknown[], pending: unknown[]) {
  return {
    object: "balance" as const,
    // The twin's per-currency balance entries are spec-faithful {amount, currency}
    // shapes; bridge the domain layer's opaque arrays to the upstream entry type.
    available: available as Balance["available"],
    pending: pending as Balance["pending"],
    livemode: false,
  } satisfies DeepPartial<Balance>;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export { STRIPE_API_VERSION };
