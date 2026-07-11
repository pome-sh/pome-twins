// SPDX-License-Identifier: Apache-2.0
// Charges domain. Owned by AGENT-B.
//
// v1 scope: charges are read-only from the agent's POV. They are minted
// by `simulate_crypto_deposit` after a PI settles. Stripe wants new
// traffic on PI, so we deliberately do not expose POST /v1/charges.
import type { TwinStripeDatabase, ChargeRow } from "../types.js";
import { TwinError } from "../errors.js";
import { newId } from "../ids.js";
import { nowUnix } from "../util.js";
import { ensureStripeTables } from "./schema.js";
import { listPaginated } from "./payment-intents.js";

export type CreateChargeInput = {
  payment_intent_id: string;
  amount: number;
  currency: string;
  balance_transaction_id?: string | null;
  /** Card charges (F-731): the PM used and its serialized card details. */
  payment_method_id?: string | null;
  payment_method_details_json?: string | null;
  /** Inherited from the PI so customer settlement reads can attribute it. */
  customer_id?: string | null;
  /** Declined card attempts mint a `failed` charge, like real Stripe. */
  status?: "succeeded" | "failed";
  failure_code?: string | null;
  failure_decline_code?: string | null;
  failure_message?: string | null;
};

export type ListChargesInput = {
  limit?: number;
  payment_intent?: string;
  customer?: string;
  created_gt?: number;
  created_gte?: number;
  created_lt?: number;
  created_lte?: number;
};

export class ChargesDomain {
  constructor(readonly db: TwinStripeDatabase) {
    ensureStripeTables(db);
  }

  /**
   * Mint a fresh charge attached to a PI. Defaults to `succeeded` +
   * `captured` (the settle paths); a declined card attempt passes
   * `status: "failed"` and the failure columns instead.
   */
  createForPI(accountId: string, input: CreateChargeInput): ChargeRow {
    const id = newId("charge");
    const now = nowUnix();
    const status = input.status ?? "succeeded";
    const succeeded = status === "succeeded";
    this.db
      .prepare(
        `INSERT INTO charges (
          id, account_id, payment_intent_id, amount, amount_captured, amount_refunded,
          status, balance_transaction_id, captured, currency, created,
          payment_method_id, payment_method_details_json,
          failure_code, failure_decline_code, failure_message, customer_id
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        accountId,
        input.payment_intent_id,
        input.amount,
        succeeded ? input.amount : 0,
        status,
        input.balance_transaction_id ?? null,
        succeeded ? 1 : 0,
        input.currency,
        now,
        input.payment_method_id ?? null,
        input.payment_method_details_json ?? null,
        input.failure_code ?? null,
        input.failure_decline_code ?? null,
        input.failure_message ?? null,
        input.customer_id ?? null
      );
    return this.requireById(accountId, id);
  }

  getById(accountId: string, id: string): ChargeRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM charges WHERE id = ? AND account_id = ?")
        .get(id, accountId) as ChargeRow | undefined) ?? null
    );
  }

  requireById(accountId: string, id: string): ChargeRow {
    const row = this.getById(accountId, id);
    if (!row) {
      throw new TwinError(
        "invalid_request_error",
        "resource_missing",
        `No such charge: '${id}'.`,
        { param: "charge", statusCode: 404 }
      );
    }
    return row;
  }

  list(accountId: string, input: ListChargesInput): { rows: ChargeRow[]; hasMore: boolean; limit: number } {
    // `customer` filters on the inherited customer_id column; listPaginated
    // only knows type/payment_intent natively, so it rides extraWheres.
    const { customer, ...rest } = input;
    const extra = customer ? [{ sql: "customer_id = ?", args: [customer] }] : [];
    return listPaginated<ChargeRow>(this.db, "charges", accountId, rest, extra);
  }

  /** Count charges for a PI. Used by the concurrency test. */
  countForPI(accountId: string, piId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as n FROM charges WHERE payment_intent_id = ? AND account_id = ?")
      .get(piId, accountId) as { n: number };
    return row.n;
  }
}
