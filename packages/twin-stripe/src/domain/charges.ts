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

  /** Mint a fresh `succeeded` + `captured` charge attached to a PI. */
  createForPI(accountId: string, input: CreateChargeInput): ChargeRow {
    const id = newId("charge");
    const now = nowUnix();
    this.db
      .prepare(
        `INSERT INTO charges (
          id, account_id, payment_intent_id, amount, amount_captured, amount_refunded,
          status, balance_transaction_id, captured, currency, created
        ) VALUES (?, ?, ?, ?, ?, 0, 'succeeded', ?, 1, ?, ?)`
      )
      .run(
        id,
        accountId,
        input.payment_intent_id,
        input.amount,
        input.amount,
        input.balance_transaction_id ?? null,
        input.currency,
        now
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
    return listPaginated<ChargeRow>(this.db, "charges", accountId, input);
  }

  /** Count charges for a PI. Used by the concurrency test. */
  countForPI(accountId: string, piId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as n FROM charges WHERE payment_intent_id = ? AND account_id = ?")
      .get(piId, accountId) as { n: number };
    return row.n;
  }
}
