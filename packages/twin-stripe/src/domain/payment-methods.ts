// SPDX-License-Identifier: Apache-2.0
//
// Payment methods domain — F-732 (M5 card-on-file chain).
//
// Card-only in this milestone (card PIs land in F-731). The PAN is never
// stored: creation derives brand/last4/fingerprint and drops the number.
// Attach/detach carries Stripe's lifecycle rules — one customer per PM,
// and a detached PM can never be reattached.

import { createHash } from "node:crypto";
import type { PaymentMethodRow, TwinStripeDatabase } from "../types.js";
import { TwinError } from "../errors.js";
import { newId } from "../ids.js";
import { nowUnix } from "../util.js";
import { ensureStripeTables } from "./schema.js";
import { listPaginated } from "./payment-intents.js";

export type CreatePaymentMethodInput = {
  type?: unknown;
  card?: {
    number?: unknown;
    exp_month?: unknown;
    exp_year?: unknown;
    cvc?: unknown;
  } | null;
};

export type ListCustomerPaymentMethodsInput = {
  limit?: number;
  starting_after?: string;
  ending_before?: string;
  type?: string;
};

export class PaymentMethodsDomain {
  constructor(readonly db: TwinStripeDatabase) {
    ensureStripeTables(db);
  }

  create(accountId: string, input: CreatePaymentMethodInput): PaymentMethodRow {
    if (typeof input.type !== "string" || input.type.length === 0) {
      throw new TwinError(
        "invalid_request_error",
        "parameter_missing",
        "Missing required param: type.",
        { param: "type", statusCode: 400 }
      );
    }
    if (input.type !== "card") {
      throw new TwinError(
        "invalid_request_error",
        "parameter_invalid_string",
        `payment method type must be "card" for v1 of this twin (got '${input.type}').`,
        { param: "type", statusCode: 400 }
      );
    }
    const card = input.card;
    if (!card || typeof card !== "object") {
      throw new TwinError(
        "invalid_request_error",
        "parameter_missing",
        "Missing required param: card.",
        { param: "card", statusCode: 400 }
      );
    }
    const number = typeof card.number === "string" ? card.number.replace(/[\s-]/g, "") : "";
    if (!/^\d{12,19}$/.test(number) || !passesLuhn(number)) {
      throw new TwinError("card_error", "incorrect_number", "Your card number is incorrect.", {
        param: "card[number]",
        statusCode: 402,
      });
    }
    const expMonth = Number(card.exp_month);
    if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12) {
      throw new TwinError(
        "card_error",
        "invalid_expiry_month",
        "Your card's expiration month is invalid.",
        { param: "card[exp_month]", statusCode: 402 }
      );
    }
    const expYear = Number(card.exp_year);
    const now = new Date(nowUnix() * 1000);
    const currentYear = now.getUTCFullYear();
    if (!Number.isInteger(expYear) || expYear < currentYear) {
      throw new TwinError(
        "card_error",
        "invalid_expiry_year",
        "Your card's expiration year is invalid.",
        { param: "card[exp_year]", statusCode: 402 }
      );
    }
    // Cards expire at end-of-month: the current month is still valid, a past
    // month of the current year is not.
    if (expYear === currentYear && expMonth < now.getUTCMonth() + 1) {
      throw new TwinError(
        "card_error",
        "invalid_expiry_month",
        "Your card's expiration month is invalid.",
        { param: "card[exp_month]", statusCode: 402 }
      );
    }

    const id = newId("payment_method");
    this.db
      .prepare(
        `INSERT INTO payment_methods (
          id, account_id, type, card_brand, card_last4, card_exp_month,
          card_exp_year, card_fingerprint, customer_id, detached, created
        ) VALUES (?, ?, 'card', ?, ?, ?, ?, ?, NULL, 0, ?)`
      )
      .run(
        id,
        accountId,
        brandFromNumber(number),
        number.slice(-4),
        expMonth,
        expYear,
        // Stable per PAN, like Stripe's card fingerprint — but derived, so
        // the PAN itself is never persisted anywhere.
        createHash("sha256").update(number).digest("hex").slice(0, 16),
        nowUnix()
      );
    return this.requireById(accountId, id);
  }

  getById(accountId: string, id: string): PaymentMethodRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM payment_methods WHERE id = ? AND account_id = ?")
        .get(id, accountId) as PaymentMethodRow | undefined) ?? null
    );
  }

  requireById(accountId: string, id: string): PaymentMethodRow {
    const row = this.getById(accountId, id);
    if (!row) {
      throw new TwinError(
        "invalid_request_error",
        "resource_missing",
        `No such payment_method: '${id}'.`,
        { param: "payment_method", statusCode: 404 }
      );
    }
    return row;
  }

  /**
   * Attach to a customer. Caller has already resolved the customer as live.
   * Stripe rules: one customer per PM, and a previously-detached PM may
   * never be reattached.
   */
  attach(accountId: string, id: string, customerId: string): PaymentMethodRow {
    const pm = this.requireById(accountId, id);
    if (pm.customer_id) {
      throw new TwinError(
        "invalid_request_error",
        "payment_method_already_attached",
        "This PaymentMethod has already been attached to a customer.",
        { param: "payment_method", statusCode: 400 }
      );
    }
    if (pm.detached) {
      throw new TwinError(
        "invalid_request_error",
        "payment_method_previously_detached",
        "A payment method that has been previously detached from a customer may not be reattached.",
        { param: "payment_method", statusCode: 400 }
      );
    }
    this.db
      .prepare("UPDATE payment_methods SET customer_id = ? WHERE id = ? AND account_id = ?")
      .run(customerId, id, accountId);
    return this.requireById(accountId, id);
  }

  detach(accountId: string, id: string): PaymentMethodRow {
    const pm = this.requireById(accountId, id);
    if (!pm.customer_id) {
      throw new TwinError(
        "invalid_request_error",
        "payment_method_not_attached",
        "The payment method you provided is not attached to a customer.",
        { param: "payment_method", statusCode: 400 }
      );
    }
    this.db
      .prepare(
        "UPDATE payment_methods SET customer_id = NULL, detached = 1 WHERE id = ? AND account_id = ?"
      )
      .run(id, accountId);
    return this.requireById(accountId, id);
  }

  /** All PMs currently attached to a customer (no pagination — used by
   *  customer deletion to emit one detached event per PM). */
  allAttachedToCustomer(accountId: string, customerId: string): PaymentMethodRow[] {
    return this.db
      .prepare("SELECT * FROM payment_methods WHERE customer_id = ? AND account_id = ?")
      .all(customerId, accountId) as PaymentMethodRow[];
  }

  listForCustomer(
    accountId: string,
    customerId: string,
    input: ListCustomerPaymentMethodsInput
  ): { rows: PaymentMethodRow[]; hasMore: boolean; limit: number } {
    return listPaginated<PaymentMethodRow>(this.db, "payment_methods", accountId, input, [
      { sql: "customer_id = ?", args: [customerId] },
    ]);
  }
}

function passesLuhn(number: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = number.length - 1; i >= 0; i--) {
    let digit = number.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function brandFromNumber(number: string): string {
  if (/^4/.test(number)) return "visa";
  if (/^(5[1-5]|2[2-7])/.test(number)) return "mastercard";
  if (/^3[47]/.test(number)) return "amex";
  if (/^6(011|5)/.test(number)) return "discover";
  return "unknown";
}
