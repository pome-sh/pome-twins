// SPDX-License-Identifier: Apache-2.0
//
// Customers domain — F-732 (M5 customer-management hot path).
//
// Stripe semantics carried here: metadata updates merge per-key (an empty
// or null value unsets the key), DELETE is a soft delete that keeps the row
// so retrieve can serve the `{deleted: true}` stub exactly like real
// Stripe, and deleting a customer detaches its payment methods in the same
// better-sqlite3 transaction.

import type { CustomerRow, TwinStripeDatabase } from "../types.js";
import { TwinError } from "../errors.js";
import { newId } from "../ids.js";
import { nowUnix } from "../util.js";
import { ensureStripeTables } from "./schema.js";
import { listPaginated } from "./payment-intents.js";

export type CustomerFieldsInput = {
  name?: string | null;
  email?: string | null;
  description?: string | null;
  phone?: string | null;
  metadata?: Record<string, string | null>;
};

export type ListCustomersInput = {
  limit?: number;
  starting_after?: string;
  ending_before?: string;
  email?: string;
  created_gt?: number;
  created_gte?: number;
  created_lt?: number;
  created_lte?: number;
};

export class CustomersDomain {
  constructor(readonly db: TwinStripeDatabase) {
    ensureStripeTables(db);
  }

  create(accountId: string, input: CustomerFieldsInput): CustomerRow {
    const id = newId("customer");
    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.metadata ?? {})) {
      if (value !== null && value !== "") metadata[key] = value;
    }
    this.db
      .prepare(
        `INSERT INTO customers (
          id, account_id, name, email, description, phone, metadata_json, deleted, created
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(
        id,
        accountId,
        input.name ?? null,
        input.email ?? null,
        input.description ?? null,
        input.phone ?? null,
        JSON.stringify(metadata),
        nowUnix()
      );
    return this.requireById(accountId, id);
  }

  getById(accountId: string, id: string): CustomerRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM customers WHERE id = ? AND account_id = ?")
        .get(id, accountId) as CustomerRow | undefined) ?? null
    );
  }

  /** Any row, deleted or live. Missing id → Stripe's 404 resource_missing. */
  requireById(accountId: string, id: string): CustomerRow {
    const row = this.getById(accountId, id);
    if (!row) throw noSuchCustomer(id);
    return row;
  }

  /** Live row only. Deleted customers 404 for writes and sub-resources. */
  requireLive(accountId: string, id: string): CustomerRow {
    const row = this.requireById(accountId, id);
    if (row.deleted) throw noSuchCustomer(id);
    return row;
  }

  /**
   * Update fields; metadata merges per-key, an empty/null value unsets the
   * key (real Stripe's metadata contract).
   */
  update(accountId: string, id: string, input: CustomerFieldsInput): CustomerRow {
    const existing = this.requireLive(accountId, id);
    const metadata = JSON.parse(existing.metadata_json) as Record<string, string>;
    for (const [key, value] of Object.entries(input.metadata ?? {})) {
      if (value === null || value === "") delete metadata[key];
      else metadata[key] = value;
    }
    this.db
      .prepare(
        `UPDATE customers SET name = ?, email = ?, description = ?, phone = ?, metadata_json = ?
          WHERE id = ? AND account_id = ?`
      )
      .run(
        input.name !== undefined ? input.name : existing.name,
        input.email !== undefined ? input.email : existing.email,
        input.description !== undefined ? input.description : existing.description,
        input.phone !== undefined ? input.phone : existing.phone,
        JSON.stringify(metadata),
        id,
        accountId
      );
    return this.requireById(accountId, id);
  }

  /**
   * Soft-delete. Detaches the customer's payment methods in the same
   * transaction (real Stripe invalidates them on customer deletion).
   * Idempotent: deleting an already-deleted customer returns the row.
   */
  delete(accountId: string, id: string): { row: CustomerRow; alreadyDeleted: boolean } {
    const tx = this.db.transaction((): { row: CustomerRow; alreadyDeleted: boolean } => {
      const existing = this.requireById(accountId, id);
      if (existing.deleted) return { row: existing, alreadyDeleted: true };
      this.db
        .prepare("UPDATE customers SET deleted = 1 WHERE id = ? AND account_id = ?")
        .run(id, accountId);
      this.db
        .prepare(
          "UPDATE payment_methods SET customer_id = NULL, detached = 1 WHERE customer_id = ? AND account_id = ?"
        )
        .run(id, accountId);
      return { row: this.requireById(accountId, id), alreadyDeleted: false };
    });
    return tx();
  }

  list(
    accountId: string,
    input: ListCustomersInput
  ): { rows: CustomerRow[]; hasMore: boolean; limit: number } {
    const extra: Array<{ sql: string; args: unknown[] }> = [{ sql: "deleted = 0", args: [] }];
    if (input.email) extra.push({ sql: "email = ?", args: [input.email] });
    return listPaginated<CustomerRow>(this.db, "customers", accountId, input, extra);
  }
}

function noSuchCustomer(id: string): TwinError {
  return new TwinError(
    "invalid_request_error",
    "resource_missing",
    `No such customer: '${id}'.`,
    { param: "customer", statusCode: 404 }
  );
}
