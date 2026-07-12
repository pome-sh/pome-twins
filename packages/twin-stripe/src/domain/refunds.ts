// SPDX-License-Identifier: Apache-2.0
//
// Refunds domain — FDRS-338 (M3a Lane B).
//
// `create()` runs INSERT refund + UPDATE charges.amount_refunded in a single
// better-sqlite3 transaction so a partial failure between legs can never
// leave the refunds table populated with a charge that doesn't reflect it
// (or vice versa). This is the per-ticket "atomic" guarantee.

import type { ChargeRow, RefundRow, TwinStripeDatabase } from "../types.js";
import { TwinError } from "../errors.js";
import { newId } from "../ids.js";
import { nowUnix } from "../util.js";
import { ensureStripeTables } from "./schema.js";
import { listPaginated } from "./payment-intents.js";

export type CreateRefundInput = {
  charge: string;
  amount?: number;
  reason?: string | null;
  idempotency_key?: string | null;
};

export type ListRefundsInput = {
  limit?: number;
  starting_after?: string;
  ending_before?: string;
  charge?: string;
  payment_intent?: string;
  created_gt?: number;
  created_gte?: number;
  created_lt?: number;
  created_lte?: number;
};

export type CreateRefundResult = {
  row: RefundRow;
  charge: ChargeRow;
};

export class RefundsDomain {
  constructor(readonly db: TwinStripeDatabase) {
    ensureStripeTables(db);
  }

  /**
   * Create a refund against an existing charge. The INSERT into `refunds`
   * and the UPDATE of `charges.amount_refunded` run inside a single
   * better-sqlite3 transaction (synchronous + atomic). Returns the new
   * refund row alongside the post-update charge row so the route can
   * emit the recorder `state_delta`.
   */
  create(accountId: string, input: CreateRefundInput): CreateRefundResult {
    if (!input.charge) {
      throw new TwinError(
        "invalid_request_error",
        "parameter_missing",
        "Missing required param: charge.",
        { param: "charge", statusCode: 400 }
      );
    }
    if (input.amount !== undefined) {
      if (!Number.isInteger(input.amount) || input.amount <= 0) {
        throw new TwinError(
          "invalid_request_error",
          "parameter_invalid_integer",
          "Amount must be a positive integer.",
          { param: "amount", statusCode: 400 }
        );
      }
    }

    const tx = this.db.transaction((): CreateRefundResult => {
      const charge = this.requireCharge(accountId, input.charge);
      // F-731 mints `failed` charges for declined card attempts; real
      // Stripe refuses to refund a charge that never captured.
      if (charge.status !== "succeeded") {
        throw new TwinError(
          "invalid_request_error",
          "charge_not_refundable",
          `This charge (${charge.id}) has a status of '${charge.status}' and cannot be refunded.`,
          { param: "charge", statusCode: 400 }
        );
      }
      const refundable = charge.amount - charge.amount_refunded;
      const amount = input.amount ?? refundable;
      if (amount <= 0 || amount > refundable) {
        throw new TwinError(
          "invalid_request_error",
          "charge_already_refunded",
          amount <= 0
            ? "Refund amount must be positive."
            : `Refund amount exceeds the remaining refundable balance of ${refundable}.`,
          { param: "amount", statusCode: 400 }
        );
      }

      const id = newId("refund");
      const now = nowUnix();
      this.db
        .prepare(
          `INSERT INTO refunds (
            id, account_id, charge_id, payment_intent_id, amount, currency,
            status, reason, idempotency_key, created
          ) VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?)`
        )
        .run(
          id,
          accountId,
          charge.id,
          charge.payment_intent_id,
          amount,
          charge.currency,
          input.reason ?? null,
          input.idempotency_key ?? null,
          now
        );
      this.db
        .prepare(
          "UPDATE charges SET amount_refunded = amount_refunded + ? WHERE id = ? AND account_id = ?"
        )
        .run(amount, charge.id, accountId);

      const row = this.requireById(accountId, id);
      const updatedCharge = this.requireCharge(accountId, charge.id);
      return { row, charge: updatedCharge };
    });
    return tx();
  }

  /**
   * Backfill the ledger link after StripeDomain mints the refund's balance
   * transaction (the txn needs the refund row's id/amount first, so the two
   * inserts can't be reordered). Runs inside the coordinator's transaction.
   */
  linkBalanceTransaction(
    accountId: string,
    id: string,
    balanceTransactionId: string
  ): RefundRow {
    this.db
      .prepare(
        "UPDATE refunds SET balance_transaction_id = ? WHERE id = ? AND account_id = ?"
      )
      .run(balanceTransactionId, id, accountId);
    return this.requireById(accountId, id);
  }

  getById(accountId: string, id: string): RefundRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM refunds WHERE id = ? AND account_id = ?")
        .get(id, accountId) as RefundRow | undefined) ?? null
    );
  }

  requireById(accountId: string, id: string): RefundRow {
    const row = this.getById(accountId, id);
    if (!row) {
      throw new TwinError(
        "invalid_request_error",
        "resource_missing",
        `No such refund: '${id}'.`,
        { param: "refund", statusCode: 404 }
      );
    }
    return row;
  }

  list(
    accountId: string,
    input: ListRefundsInput
  ): { rows: RefundRow[]; hasMore: boolean; limit: number } {
    // listPaginated supports `payment_intent` natively; `charge` is a
    // refunds-specific filter so we apply it after fetching pages. Cheap
    // enough at v1 scale (no real customers, single-digit refunds per run).
    if (input.charge) {
      const wide = listPaginated<RefundRow & { charge_id: string }>(
        this.db,
        "refunds",
        accountId,
        input
      );
      const filtered = wide.rows.filter((r) => r.charge_id === input.charge);
      return { rows: filtered, hasMore: wide.hasMore, limit: wide.limit };
    }
    return listPaginated<RefundRow>(this.db, "refunds", accountId, input);
  }

  private requireCharge(accountId: string, id: string): ChargeRow {
    const row = this.db
      .prepare("SELECT * FROM charges WHERE id = ? AND account_id = ?")
      .get(id, accountId) as ChargeRow | undefined;
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
}
