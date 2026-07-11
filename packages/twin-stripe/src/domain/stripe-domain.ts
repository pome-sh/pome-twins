// file-size: StripeDomain is deliberately the single coordinator — one method per business operation, orchestrating cross-cutting side effects (events, charges, ledger) the per-table modules must not own.
// SPDX-License-Identifier: Apache-2.0
//
// StripeDomain — top-level coordinator for the Stripe twin's domain logic.
// Owned by AGENT-B.
//
// Mirrors the shape of `GitHubDomain` in twin-github: one class wraps the
// DB, exposes one method per business operation, and is the single thing
// MCP tools and REST routes call.
//
// Side effects (events emitted, charges minted, balance txns created) are
// orchestrated here, not inside the per-table domain modules. That keeps
// the per-table modules pure-ish and the cross-cutting flows readable.
//
// Every public method takes `accountId` as the first argument so the
// underlying domain modules and SQL stay scoped to the calling session's
// account (F1). Two sessions sharing a DB file cannot read or write each
// other's PIs, charges, balance txns, or events.

import type {
  TwinStripeDatabase,
  PIRow,
  ChargeRow,
  BalanceTxRow,
  CustomerRow,
  EventRow,
  PaymentMethodRow,
  RefundRow,
  StateDelta,
} from "../types.js";
import { TwinError } from "../errors.js";
import {
  PaymentIntentsDomain,
  piTypes,
  piUnexpectedState,
  type CreatePIInput,
  type ListPIsInput,
  type UpdatePIInput,
} from "./payment-intents.js";
import { declineForFingerprint } from "./payment-methods.js";
import { ChargesDomain, type ListChargesInput } from "./charges.js";
import { BalanceDomain, type ListBalanceTxInput } from "./balance.js";
import { EventsDomain, type ListEventsInput } from "./events.js";
import {
  RefundsDomain,
  type CreateRefundInput,
  type ListRefundsInput,
} from "./refunds.js";
import {
  CustomersDomain,
  type CustomerFieldsInput,
  type ListCustomersInput,
} from "./customers.js";
import {
  PaymentMethodsDomain,
  type CreatePaymentMethodInput,
  type ListCustomerPaymentMethodsInput,
} from "./payment-methods.js";
import { ensureStripeTables, resetStripeTables } from "./schema.js";
import {
  paymentIntentJson,
  cardJson,
  chargeJson,
  balanceTransactionJson,
  balanceJson,
  customerJson,
  deletedCustomerJson,
  eventJson,
  paymentMethodJson,
  refundJson,
  serializedList,
} from "../serializers.js";

export class StripeDomain {
  readonly paymentIntents: PaymentIntentsDomain;
  readonly charges: ChargesDomain;
  readonly balance: BalanceDomain;
  readonly events: EventsDomain;
  readonly refunds: RefundsDomain;
  readonly customers: CustomersDomain;
  readonly paymentMethods: PaymentMethodsDomain;

  constructor(readonly db: TwinStripeDatabase) {
    ensureStripeTables(db);
    this.paymentIntents = new PaymentIntentsDomain(db);
    this.charges = new ChargesDomain(db);
    this.balance = new BalanceDomain(db);
    this.events = new EventsDomain(db);
    this.refunds = new RefundsDomain(db);
    this.customers = new CustomersDomain(db);
    this.paymentMethods = new PaymentMethodsDomain(db);
  }

  /** Reset Stripe-domain state. Used by `/admin/reset`. */
  reset() {
    resetStripeTables(this.db);
  }

  // ---------- PI flows ----------

  createPaymentIntent(
    accountId: string,
    input: CreatePIInput
  ): { body: unknown; delta: StateDelta } {
    const isCard =
      Array.isArray(input.payment_method_types) &&
      input.payment_method_types.length === 1 &&
      input.payment_method_types[0] === "card";

    // Card rail: resolve + cross-validate customer and PM up front so a
    // missing/deleted customer 404s before any PI row exists.
    let resolved: { paymentMethodId: string | null; customerId: string | null } = {
      paymentMethodId: null,
      customerId: null,
    };
    if (isCard) {
      const customerId = input.customer
        ? this.customers.requireLive(accountId, input.customer).id
        : null;
      let paymentMethodId: string | null = null;
      if (input.payment_method) {
        const pm = this.paymentMethods.requireById(accountId, input.payment_method);
        assertPMUsable(pm, customerId);
        paymentMethodId = pm.id;
      }
      resolved = { paymentMethodId, customerId };
      if (input.confirm && !resolved.paymentMethodId) {
        // Fail before any PI row exists — otherwise every retry of this
        // malformed one-shot would leave another orphaned PI behind.
        throw missingPaymentMethod();
      }
    }

    const pi = this.paymentIntents.create(accountId, input, resolved);
    this.events.create(accountId, { type: "payment_intent.created", object: paymentIntentJson(pi) });
    // requires_action is the x402 deposit rail; card PIs never emit it.
    if (pi.status === "requires_action") {
      this.events.create(accountId, {
        type: "payment_intent.requires_action",
        object: paymentIntentJson(pi),
      });
    }

    // create + confirm in one call (Stripe's one-shot server-side pattern).
    // The PI row and created event persist even when the confirm declines.
    if (isCard && input.confirm) {
      const confirmed = this.confirmPaymentIntent(accountId, pi.id);
      return {
        body: confirmed.body,
        delta: { before: null, after: confirmed.delta?.after ?? rowToRecord(pi) },
      };
    }

    return {
      body: paymentIntentJson(pi),
      delta: { before: null, after: rowToRecord(pi) },
    };
  }

  retrievePaymentIntent(accountId: string, id: string) {
    return paymentIntentJson(this.paymentIntents.requireById(accountId, id));
  }

  listPaymentIntents(accountId: string, input: ListPIsInput) {
    const { rows, hasMore, limit } = this.paymentIntents.list(accountId, input);
    return serializedList(rows.map(paymentIntentJson), hasMore, limit, "/v1/payment_intents");
  }

  confirmPaymentIntent(
    accountId: string,
    id: string,
    opts: { payment_method?: string } = {}
  ): { body: unknown; delta: StateDelta } {
    const before = this.paymentIntents.requireById(accountId, id);
    if (!piTypes(before).includes("card")) {
      // Crypto rail: confirm stays the documented idempotent no-op.
      const pi = this.paymentIntents.confirm(accountId, id);
      return {
        body: paymentIntentJson(pi),
        delta: { before: rowToRecord(before), after: rowToRecord(pi) },
      };
    }

    // Card rail (F-731): synchronous attempt with real success/decline
    // semantics. Unlike crypto, re-confirming a settled card PI is refused.
    // Whitelist the two confirmable card states so an off-diagram status
    // (e.g. a seeded card PI in requires_action) can never mint a charge.
    if (
      before.status !== "requires_confirmation" &&
      before.status !== "requires_payment_method"
    ) {
      throw piUnexpectedState(before.status);
    }
    // `payment_method=` (empty form value) means "use the attached PM".
    const pmId = (opts.payment_method || undefined) ?? before.payment_method_id;
    if (!pmId) {
      throw missingPaymentMethod();
    }
    const pm = this.paymentMethods.requireById(accountId, pmId);
    assertPMUsable(pm, before.customer_id);
    const decline = declineForFingerprint(pm.card_fingerprint);

    // F2: the whole attempt is one better-sqlite3 transaction. Leg 1 CAS
    // (observed status → processing) picks exactly one winner among
    // parallel confirms; the outcome (charge mint, ledger, events, final
    // status) commits atomically with it.
    const tx = this.db.transaction(() => {
      const inFlight = this.paymentIntents.confirmCardLeg1(
        accountId,
        id,
        before.status,
        pm.id
      );
      const detailsJson = JSON.stringify(cardChargeDetails(pm));

      if (decline) {
        const failedCharge = this.charges.createForPI(accountId, {
          payment_intent_id: id,
          amount: inFlight.amount,
          currency: inFlight.currency,
          payment_method_id: pm.id,
          payment_method_details_json: detailsJson,
          customer_id: inFlight.customer_id,
          status: "failed",
          failure_code: decline.code,
          failure_decline_code: decline.decline_code,
          failure_message: decline.message,
        });
        const lastPaymentError = {
          type: "card_error",
          code: decline.code,
          decline_code: decline.decline_code,
          message: decline.message,
          payment_method: paymentMethodJson(pm),
        };
        const pi = this.paymentIntents.finalizeCardDecline(
          accountId,
          id,
          failedCharge.id,
          JSON.stringify(lastPaymentError)
        );
        this.events.create(accountId, {
          type: "payment_intent.payment_failed",
          object: paymentIntentJson(pi),
        });
        this.events.create(accountId, {
          type: "charge.failed",
          object: chargeJson(failedCharge),
        });
        return { declined: decline, pi };
      }

      const balanceTx: BalanceTxRow = this.balance.create(accountId, {
        type: "charge",
        amount: inFlight.amount,
        fee: 0,
        currency: inFlight.currency,
        source_id: id,
        source_type: "payment_intent",
      });
      const charge: ChargeRow = this.charges.createForPI(accountId, {
        payment_intent_id: id,
        amount: inFlight.amount,
        currency: inFlight.currency,
        balance_transaction_id: balanceTx.id,
        payment_method_id: pm.id,
        payment_method_details_json: detailsJson,
        customer_id: inFlight.customer_id,
      });
      const pi = this.paymentIntents.finalizeCardSuccess(accountId, id, charge.id);
      this.events.create(accountId, {
        type: "payment_intent.succeeded",
        object: paymentIntentJson(pi),
      });
      this.events.create(accountId, {
        type: "charge.succeeded",
        object: chargeJson(charge),
      });
      return { declined: null, pi };
    });
    const result = tx() as { declined: ReturnType<typeof declineForFingerprint>; pi: PIRow };

    if (result.declined) {
      // Real Stripe answers a declined confirm with a 402 card_error that
      // embeds the post-attempt PaymentIntent. State above is committed,
      // so the error also carries the recorder-truth delta.
      throw new TwinError("card_error", result.declined.code, result.declined.message, {
        statusCode: 402,
        decline_code: result.declined.decline_code,
        payment_intent: paymentIntentJson(result.pi),
        state_mutation: true,
        state_delta: { before: rowToRecord(before), after: rowToRecord(result.pi) },
      });
    }
    return {
      body: paymentIntentJson(result.pi),
      delta: { before: rowToRecord(before), after: rowToRecord(result.pi) },
    };
  }

  /**
   * POST /v1/payment_intents/:id (F-731). The ruled retry-with-new-PM step:
   * metadata merges per-key, and attaching a PM moves the card PI back to
   * requires_confirmation. PM/customer resolution happens here so unknown
   * ids 404 with Stripe's resource_missing before any state gate fires.
   */
  updatePaymentIntent(
    accountId: string,
    id: string,
    input: UpdatePIInput
  ): { body: unknown; delta: StateDelta } {
    const before = this.paymentIntents.requireById(accountId, id);
    const resolved: { paymentMethodId?: string | null; customerId?: string | null } = {};
    if (input.customer !== undefined) {
      resolved.customerId = input.customer
        ? this.customers.requireLive(accountId, input.customer).id
        : null;
    }
    const effectiveCustomerId =
      resolved.customerId !== undefined ? resolved.customerId : before.customer_id;
    if (input.payment_method !== undefined) {
      if (input.payment_method) {
        const pm = this.paymentMethods.requireById(accountId, input.payment_method);
        assertPMUsable(pm, effectiveCustomerId);
        resolved.paymentMethodId = pm.id;
      } else {
        resolved.paymentMethodId = null;
      }
    } else if (input.customer !== undefined && before.payment_method_id) {
      // Changing only the customer must re-validate the already-attached
      // PM — real Stripe refuses a customer/PM pairing at update time.
      assertPMUsable(
        this.paymentMethods.requireById(accountId, before.payment_method_id),
        effectiveCustomerId
      );
    }
    const pi = this.paymentIntents.update(accountId, id, input, resolved);
    return {
      body: paymentIntentJson(pi),
      delta: { before: rowToRecord(before), after: rowToRecord(pi) },
    };
  }

  cancelPaymentIntent(
    accountId: string,
    id: string
  ): { body: unknown; delta: StateDelta } {
    const before = this.paymentIntents.requireById(accountId, id);
    if (before.status === "canceled") {
      // Idempotent re-cancel; no state transition.
      return {
        body: paymentIntentJson(before),
        delta: { before: rowToRecord(before), after: rowToRecord(before) },
      };
    }
    const pi = this.paymentIntents.cancel(accountId, id);
    this.events.create(accountId, { type: "payment_intent.canceled", object: paymentIntentJson(pi) });
    return {
      body: paymentIntentJson(pi),
      delta: { before: rowToRecord(before), after: rowToRecord(pi) },
    };
  }

  /**
   * Drive a PI through requires_action → processing → succeeded.
   * Emits payment_intent.processing, payment_intent.succeeded,
   * charge.succeeded events. Mints exactly one charge + one
   * balance_transaction. CAS guarantees only one parallel caller wins.
   *
   * F2: the entire flow runs inside a single better-sqlite3 transaction.
   * If anything throws between Leg 1 and the final event emit, the
   * transaction rolls back — no orphan charges/balance txns and no PI
   * stuck in `processing`. better-sqlite3 transactions are synchronous
   * and atomic, and the CAS works inside the transaction the same way it
   * does outside it.
   */
  simulateCryptoDeposit(
    accountId: string,
    id: string
  ): { body: unknown; delta: StateDelta } {
    const before = this.paymentIntents.requireById(accountId, id);
    const tx = this.db.transaction((): unknown => {
      // Leg 1: requires_action → processing. CAS — only one winner.
      let pi: PIRow = this.paymentIntents.simulateCryptoDepositLeg1(accountId, id);

      // Emit processing event with the post-leg-1 PI.
      this.events.create(accountId, {
        type: "payment_intent.processing",
        object: paymentIntentJson(pi),
      });

      // Mint balance transaction first so the charge can reference it.
      const balanceTx: BalanceTxRow = this.balance.create(accountId, {
        type: "charge",
        amount: pi.amount,
        fee: 0,
        currency: pi.currency,
        source_id: pi.id,
        source_type: "payment_intent",
      });

      // Mint charge.
      const charge: ChargeRow = this.charges.createForPI(accountId, {
        payment_intent_id: pi.id,
        amount: pi.amount,
        currency: pi.currency,
        balance_transaction_id: balanceTx.id,
      });

      // Backfill balance_tx.source_id with charge id (real Stripe links the
      // balance txn to the charge, not the PI). Keep it pointed at the PI
      // for now — concurrency-test uses source_id == pi.id to count
      // "balance txns for this PI". OK as v1 deviation.

      // Leg 2: processing → succeeded with latest_charge_id set.
      pi = this.paymentIntents.simulateCryptoDepositLeg2(accountId, id, charge.id);

      // Re-read charge so balance_transaction_id is reflected.
      const finalCharge = this.charges.requireById(accountId, charge.id);

      // Emit succeeded events.
      this.events.create(accountId, {
        type: "payment_intent.succeeded",
        object: paymentIntentJson(pi),
      });
      this.events.create(accountId, {
        type: "charge.succeeded",
        object: chargeJson(finalCharge),
      });

      return { body: paymentIntentJson(pi), after: pi as Record<string, unknown> };
    });
    const result = tx() as { body: unknown; after: Record<string, unknown> };
    return {
      body: result.body,
      delta: { before: rowToRecord(before), after: rowToRecord(result.after) },
    };
  }

  // ---------- Refunds ----------

  /**
   * Create a refund. Returns the serialized API shape plus a canonical
   * `state_delta` so the route can hand both to `respond()`.
   *
   * F-733: the whole flow — refund INSERT + charges.amount_refunded UPDATE
   * (inside `refunds.create()`, nested as a savepoint), the negative
   * refund-type balance transaction, the ledger link backfill, and the
   * charge.refunded / refund.created events — commits in one better-sqlite3
   * transaction, mirroring the settle flows.
   */
  createRefund(
    accountId: string,
    input: CreateRefundInput
  ): { body: unknown; delta: StateDelta } {
    const tx = this.db.transaction((): RefundRow => {
      const { row, charge } = this.refunds.create(accountId, input);
      const balanceTx = this.balance.create(accountId, {
        type: "refund",
        amount: -row.amount,
        fee: 0,
        currency: row.currency,
        source_id: row.id,
        source_type: "refund",
      });
      const linked = this.refunds.linkBalanceTransaction(accountId, row.id, balanceTx.id);
      // v1 has no webhook delivery; these are the poll-chain signals agents
      // read after a refund (charge carries the post-refund amount_refunded).
      this.events.create(accountId, { type: "charge.refunded", object: chargeJson(charge) });
      this.events.create(accountId, { type: "refund.created", object: refundJson(linked) });
      return linked;
    });
    const row = tx();
    return {
      body: refundJson(row),
      delta: { before: null, after: rowToRecord(row) },
    };
  }

  retrieveRefund(accountId: string, id: string) {
    return refundJson(this.refunds.requireById(accountId, id));
  }

  listRefunds(accountId: string, input: ListRefundsInput) {
    const { rows, hasMore, limit } = this.refunds.list(accountId, input);
    return serializedList(rows.map(refundJson), hasMore, limit, "/v1/refunds");
  }

  // ---------- Customers ----------

  createCustomer(
    accountId: string,
    input: CustomerFieldsInput
  ): { body: unknown; delta: StateDelta } {
    const row = this.customers.create(accountId, input);
    this.events.create(accountId, { type: "customer.created", object: customerJson(row) });
    return {
      body: customerJson(row),
      delta: { before: null, after: rowToRecord(row) },
    };
  }

  /** Deleted customers serve the `{deleted: true}` stub, like real Stripe. */
  retrieveCustomer(accountId: string, id: string) {
    const row = this.customers.requireById(accountId, id);
    return row.deleted ? deletedCustomerJson(row) : customerJson(row);
  }

  updateCustomer(
    accountId: string,
    id: string,
    input: CustomerFieldsInput
  ): { body: unknown; delta: StateDelta } {
    const before = this.customers.requireLive(accountId, id);
    const row = this.customers.update(accountId, id, input);
    this.events.create(accountId, { type: "customer.updated", object: customerJson(row) });
    return {
      body: customerJson(row),
      delta: { before: rowToRecord(before), after: rowToRecord(row) },
    };
  }

  deleteCustomer(accountId: string, id: string): { body: unknown; delta: StateDelta } {
    const before = this.customers.requireById(accountId, id);
    const attached = this.paymentMethods.allAttachedToCustomer(accountId, id);
    const { row, alreadyDeleted } = this.customers.delete(accountId, id);
    if (!alreadyDeleted) {
      this.events.create(accountId, { type: "customer.deleted", object: deletedCustomerJson(row) });
      // Deletion detached every attached PM (inside customers.delete's
      // transaction); event-polling consumers see one detached event per PM,
      // carrying the post-detach shape.
      for (const pm of attached) {
        this.events.create(accountId, {
          type: "payment_method.detached",
          object: paymentMethodJson(this.paymentMethods.requireById(accountId, pm.id)),
        });
      }
    }
    return {
      body: deletedCustomerJson(row),
      delta: { before: rowToRecord(before), after: rowToRecord(row) },
    };
  }

  listCustomers(accountId: string, input: ListCustomersInput) {
    const { rows, hasMore, limit } = this.customers.list(accountId, input);
    return serializedList(rows.map(customerJson), hasMore, limit, "/v1/customers");
  }

  listCustomerPaymentMethods(
    accountId: string,
    customerId: string,
    input: ListCustomerPaymentMethodsInput
  ) {
    // 404 for unknown AND deleted customers — a deleted customer has no
    // payment-method sub-resource anymore.
    this.customers.requireLive(accountId, customerId);
    const { rows, hasMore, limit } = this.paymentMethods.listForCustomer(
      accountId,
      customerId,
      input
    );
    return serializedList(
      rows.map(paymentMethodJson),
      hasMore,
      limit,
      `/v1/customers/${customerId}/payment_methods`
    );
  }

  // ---------- Payment methods ----------

  createPaymentMethod(
    accountId: string,
    input: CreatePaymentMethodInput
  ): { body: unknown; delta: StateDelta } {
    const row = this.paymentMethods.create(accountId, input);
    return {
      body: paymentMethodJson(row),
      delta: { before: null, after: rowToRecord(row) },
    };
  }

  retrievePaymentMethod(accountId: string, id: string) {
    return paymentMethodJson(this.paymentMethods.requireById(accountId, id));
  }

  attachPaymentMethod(
    accountId: string,
    id: string,
    customerId: string
  ): { body: unknown; delta: StateDelta } {
    // Resolve the customer first so a missing/deleted customer 404s before
    // any PM lifecycle error fires.
    this.customers.requireLive(accountId, customerId);
    const before = this.paymentMethods.requireById(accountId, id);
    const row = this.paymentMethods.attach(accountId, id, customerId);
    this.events.create(accountId, {
      type: "payment_method.attached",
      object: paymentMethodJson(row),
    });
    return {
      body: paymentMethodJson(row),
      delta: { before: rowToRecord(before), after: rowToRecord(row) },
    };
  }

  detachPaymentMethod(accountId: string, id: string): { body: unknown; delta: StateDelta } {
    const before = this.paymentMethods.requireById(accountId, id);
    const row = this.paymentMethods.detach(accountId, id);
    this.events.create(accountId, {
      type: "payment_method.detached",
      object: paymentMethodJson(row),
    });
    return {
      body: paymentMethodJson(row),
      delta: { before: rowToRecord(before), after: rowToRecord(row) },
    };
  }

  // ---------- Charges ----------

  retrieveCharge(accountId: string, id: string) {
    return chargeJson(this.charges.requireById(accountId, id));
  }

  listCharges(accountId: string, input: ListChargesInput) {
    const { rows, hasMore, limit } = this.charges.list(accountId, input);
    return serializedList(rows.map(chargeJson), hasMore, limit, "/v1/charges");
  }

  // ---------- Balance ----------

  retrieveBalance(accountId: string) {
    const { available, pending } = this.balance.current(accountId);
    return balanceJson(available, pending);
  }

  listBalanceTransactions(accountId: string, input: ListBalanceTxInput) {
    const { rows, hasMore, limit } = this.balance.list(accountId, input);
    return serializedList(
      rows.map(balanceTransactionJson),
      hasMore,
      limit,
      "/v1/balance_transactions"
    );
  }

  // ---------- Events ----------

  retrieveEvent(accountId: string, id: string) {
    return eventJson(this.events.requireById(accountId, id));
  }

  listEvents(accountId: string, input: ListEventsInput) {
    const { rows, hasMore, limit } = this.events.list(accountId, input);
    return serializedList(rows.map(eventJson), hasMore, limit, "/v1/events");
  }

  // ---------- State export (for _pome/state) ----------

  /**
   * Account-scoped state export. Used by `/_pome/state` to surface only
   * the calling session's data. Two sessions hitting `_pome/state` see
   * disjoint views of the same DB.
   *
   * Ordering is `created DESC, rowid DESC`: `created` has unix-second
   * resolution, so rows minted within the same second tied and flipped
   * order run-to-run (the F-683 export-race class). The insertion-order
   * tiebreak keeps the export deterministic — same seed + same ops =>
   * same state (test/state-export.test.ts).
   */
  exportState(accountId: string): unknown {
    const pis = this.db
      .prepare(
        "SELECT * FROM payment_intents WHERE account_id = ? ORDER BY created DESC, rowid DESC"
      )
      .all(accountId) as PIRow[];
    const charges = this.db
      .prepare("SELECT * FROM charges WHERE account_id = ? ORDER BY created DESC, rowid DESC")
      .all(accountId) as ChargeRow[];
    const balanceTxs = this.db
      .prepare(
        "SELECT * FROM balance_transactions WHERE account_id = ? ORDER BY created DESC, rowid DESC"
      )
      .all(accountId) as BalanceTxRow[];
    const events = this.db
      .prepare("SELECT * FROM events WHERE account_id = ? ORDER BY created DESC, rowid DESC")
      .all(accountId) as EventRow[];
    const refunds = this.db
      .prepare("SELECT * FROM refunds WHERE account_id = ? ORDER BY created DESC, rowid DESC")
      .all(accountId) as RefundRow[];
    const customers = this.db
      .prepare("SELECT * FROM customers WHERE account_id = ? ORDER BY created DESC, rowid DESC")
      .all(accountId) as CustomerRow[];
    const paymentMethods = this.db
      .prepare(
        "SELECT * FROM payment_methods WHERE account_id = ? ORDER BY created DESC, rowid DESC"
      )
      .all(accountId) as PaymentMethodRow[];
    return {
      payment_intents: pis.map(paymentIntentJson),
      charges: charges.map(chargeJson),
      balance_transactions: balanceTxs.map(balanceTransactionJson),
      events: events.map(eventJson),
      refunds: refunds.map(refundJson),
      customers: customers.map((row) => (row.deleted ? deletedCustomerJson(row) : customerJson(row))),
      payment_methods: paymentMethods.map(paymentMethodJson),
    };
  }
}

function rowToRecord(row: Record<string, unknown>): Record<string, unknown> {
  // Coerce to a plain record so the canonical state_delta schema's
  // z.record(z.string(), z.unknown()) accepts it.
  return { ...row };
}

function missingPaymentMethod(): TwinError {
  return new TwinError(
    "invalid_request_error",
    "payment_intent_unexpected_state",
    "You cannot confirm this PaymentIntent because it's missing a payment method. Update the PaymentIntent with a payment_method and then confirm it again.",
    { statusCode: 400 }
  );
}

/**
 * Stripe's PM lifecycle rules for using a PM on a PI: a previously
 * detached PM may never be used again, and a PM attached to a customer may
 * only be used on that customer's PaymentIntents.
 */
function assertPMUsable(pm: PaymentMethodRow, customerId: string | null) {
  if (pm.detached) {
    throw new TwinError(
      "invalid_request_error",
      "payment_method_previously_detached",
      "A payment method that has been previously detached from a customer may not be used again.",
      { param: "payment_method", statusCode: 400 }
    );
  }
  if (pm.customer_id && pm.customer_id !== customerId) {
    throw new TwinError(
      "invalid_request_error",
      "payment_method_customer_mismatch",
      "The payment method you provided is attached to a customer. You may only use it with that customer via the `customer` parameter.",
      { param: "payment_method", statusCode: 400 }
    );
  }
}

/** Charge.payment_method_details payload for a card charge. */
function cardChargeDetails(pm: PaymentMethodRow) {
  // Same card block paymentMethodJson serves, so Charge.payment_method_details.card
  // can never drift from PaymentMethod.card for the same PM.
  return { type: "card", card: cardJson(pm) };
}
