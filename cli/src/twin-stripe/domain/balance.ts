// SPDX-License-Identifier: Apache-2.0
// Balance + balance transactions. Owned by AGENT-B.
//
// In real Stripe, `available` and `pending` are separated by deposit time
// (T+2 etc). For this twin every settled PI hits `available` immediately
// — we don't model the float. `available_on` is set to `created` for the
// same reason. Documented in FIDELITY.md.

import type { TwinStripeDatabase, BalanceTxRow } from "../types.js";
import { TwinError } from "../errors.js";
import { newId } from "../ids.js";
import { nowUnix } from "../util.js";
import { ensureStripeTables } from "./schema.js";
import { listPaginated } from "./payment-intents.js";

export type CreateBalanceTxInput = {
  type: "charge" | "refund" | "adjustment" | "fee";
  amount: number;
  fee?: number;
  currency: string;
  source_id?: string;
  source_type?: string;
};

export type ListBalanceTxInput = {
  limit?: number;
  type?: string;
  created_gt?: number;
  created_gte?: number;
  created_lt?: number;
  created_lte?: number;
};

export class BalanceDomain {
  constructor(readonly db: TwinStripeDatabase) {
    ensureStripeTables(db);
  }

  create(accountId: string, input: CreateBalanceTxInput): BalanceTxRow {
    const id = newId("balance_transaction");
    const now = nowUnix();
    const fee = input.fee ?? 0;
    const net = input.amount - fee;
    this.db
      .prepare(
        `INSERT INTO balance_transactions (
          id, account_id, type, amount, fee, net, currency, source_id, source_type,
          available_on, status, created
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?)`
      )
      .run(
        id,
        accountId,
        input.type,
        input.amount,
        fee,
        net,
        input.currency,
        input.source_id ?? null,
        input.source_type ?? null,
        now,
        now
      );
    return this.requireById(accountId, id);
  }

  getById(accountId: string, id: string): BalanceTxRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM balance_transactions WHERE id = ? AND account_id = ?")
        .get(id, accountId) as BalanceTxRow | undefined) ?? null
    );
  }

  requireById(accountId: string, id: string): BalanceTxRow {
    const row = this.getById(accountId, id);
    if (!row) {
      throw new TwinError(
        "invalid_request_error",
        "resource_missing",
        `No such balance_transaction: '${id}'.`,
        { param: "balance_transaction", statusCode: 404 }
      );
    }
    return row;
  }

  list(accountId: string, input: ListBalanceTxInput): {
    rows: BalanceTxRow[];
    hasMore: boolean;
    limit: number;
  } {
    return listPaginated<BalanceTxRow>(this.db, "balance_transactions", accountId, input);
  }

  /**
   * Compute current balance grouped by currency. v1 deviation: we lump
   * everything into `available`; `pending` is always [].
   */
  current(accountId: string): {
    available: Array<{ currency: string; amount: number; source_types: { card: number } }>;
    pending: Array<{ currency: string; amount: number; source_types: { card: number } }>;
  } {
    const rows = this.db
      .prepare(
        "SELECT currency, COALESCE(SUM(net), 0) AS amount FROM balance_transactions WHERE account_id = ? GROUP BY currency"
      )
      .all(accountId) as Array<{ currency: string; amount: number }>;
    const available = rows.map((row) => ({
      currency: row.currency,
      amount: row.amount,
      source_types: { card: 0 },
    }));
    return { available, pending: [] };
  }

  /** Count balance txns for a given source (PI). Used by concurrency test. */
  countForSource(accountId: string, sourceId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as n FROM balance_transactions WHERE source_id = ? AND account_id = ?"
      )
      .get(sourceId, accountId) as { n: number };
    return row.n;
  }

  /** Sum of all `net` amounts. Used by concurrency test (assert total == PI amount). */
  totalNet(accountId: string, currency = "usd"): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(net), 0) AS total FROM balance_transactions WHERE currency = ? AND account_id = ?"
      )
      .get(currency, accountId) as { total: number };
    return row.total;
  }
}
