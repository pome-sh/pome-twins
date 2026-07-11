// SPDX-License-Identifier: Apache-2.0
//
// Billing domain — F-734 (M5 warm surfaces: products, prices, subscriptions).
//
// SHAPE TIER by ruling (F-729): these are stored rows served back in Stripe
// shape, deliberately without the semantic billing machine. Concretely:
// no events are emitted, no invoices are minted, no proration or
// billing-cycle arithmetic runs, and cancellation is a plain status flip.
// Referential integrity IS enforced (unknown product / price / customer
// 404s with Stripe's resource_missing) so agents get loud, Stripe-shaped
// failures instead of dangling references.

import type {
  PriceRow,
  ProductRow,
  SubscriptionRow,
  TwinStripeDatabase,
} from "../types.js";
import { TwinError } from "../errors.js";
import { newId } from "../ids.js";
import { nowUnix } from "../util.js";
import { ensureStripeTables } from "./schema.js";
import { listPaginated } from "./payment-intents.js";

export type ProductFieldsInput = {
  name?: string | null;
  description?: string | null;
  active?: boolean;
  metadata?: Record<string, string | null>;
};

// Required-param fields are optional at the type level so the routes can
// hand the parsed body straight through and the domain can answer Stripe's
// `parameter_missing` envelope (instead of a zod parameter_invalid).
export type CreatePriceInput = {
  currency?: string;
  product?: string;
  unit_amount?: number;
  recurring?: { interval: string; interval_count?: number };
  nickname?: string | null;
  lookup_key?: string | null;
  active?: boolean;
  metadata?: Record<string, string | null>;
};

export type SubscriptionItemInput = { price?: string; quantity?: number };

export type CreateSubscriptionInput = {
  customer?: string;
  items?: SubscriptionItemInput[];
  cancel_at_period_end?: boolean;
  metadata?: Record<string, string | null>;
};

export type UpdateSubscriptionInput = {
  cancel_at_period_end?: boolean;
  metadata?: Record<string, string | null>;
};

export type ListBillingInput = {
  limit?: number;
  starting_after?: string;
  ending_before?: string;
  created_gt?: number;
  created_gte?: number;
  created_lt?: number;
  created_lte?: number;
};

/** Stored subscription item shape (items_json). */
export type SubscriptionItem = { id: string; price: string; quantity: number };

export class BillingDomain {
  constructor(readonly db: TwinStripeDatabase) {
    ensureStripeTables(db);
  }

  // ---------- Products ----------

  createProduct(accountId: string, input: ProductFieldsInput): ProductRow {
    if (!input.name) throw missingParam("name");
    const now = nowUnix();
    const id = newId("product");
    this.db
      .prepare(
        `INSERT INTO products (id, account_id, name, description, active, metadata_json, created, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        accountId,
        input.name,
        input.description ?? null,
        input.active === false ? 0 : 1,
        JSON.stringify(liveMetadata(input.metadata)),
        now,
        now
      );
    return this.requireProduct(accountId, id);
  }

  requireProduct(accountId: string, id: string): ProductRow {
    const row = this.db
      .prepare("SELECT * FROM products WHERE id = ? AND account_id = ?")
      .get(id, accountId) as ProductRow | undefined;
    if (!row) throw noSuch("product", id);
    return row;
  }

  listProducts(
    accountId: string,
    input: ListBillingInput & { active?: boolean }
  ): { rows: ProductRow[]; hasMore: boolean; limit: number } {
    const extra: Array<{ sql: string; args: unknown[] }> = [];
    if (input.active !== undefined) {
      extra.push({ sql: "active = ?", args: [input.active ? 1 : 0] });
    }
    return listPaginated<ProductRow>(this.db, "products", accountId, input, extra);
  }

  // ---------- Prices ----------

  createPrice(accountId: string, input: CreatePriceInput): PriceRow {
    if (!input.currency) throw missingParam("currency");
    if (!input.product) throw missingParam("product");
    // Referential check: the price must point at a real product.
    this.requireProduct(accountId, input.product);
    const id = newId("price");
    this.db
      .prepare(
        `INSERT INTO prices (
          id, account_id, product_id, currency, unit_amount, recurring_interval,
          recurring_interval_count, active, nickname, lookup_key, metadata_json, created
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        accountId,
        input.product,
        input.currency.toLowerCase(),
        input.unit_amount ?? null,
        input.recurring?.interval ?? null,
        input.recurring ? input.recurring.interval_count ?? 1 : null,
        input.active === false ? 0 : 1,
        input.nickname ?? null,
        input.lookup_key ?? null,
        JSON.stringify(liveMetadata(input.metadata)),
        nowUnix()
      );
    return this.requirePrice(accountId, id);
  }

  requirePrice(accountId: string, id: string): PriceRow {
    const row = this.db
      .prepare("SELECT * FROM prices WHERE id = ? AND account_id = ?")
      .get(id, accountId) as PriceRow | undefined;
    if (!row) throw noSuch("price", id);
    return row;
  }

  listPrices(
    accountId: string,
    input: ListBillingInput & { product?: string; active?: boolean }
  ): { rows: PriceRow[]; hasMore: boolean; limit: number } {
    const extra: Array<{ sql: string; args: unknown[] }> = [];
    if (input.product) extra.push({ sql: "product_id = ?", args: [input.product] });
    if (input.active !== undefined) {
      extra.push({ sql: "active = ?", args: [input.active ? 1 : 0] });
    }
    return listPaginated<PriceRow>(this.db, "prices", accountId, input, extra);
  }

  // ---------- Subscriptions ----------

  createSubscription(accountId: string, input: CreateSubscriptionInput): SubscriptionRow {
    if (!input.customer) throw missingParam("customer");
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw missingParam("items");
    }
    const items: SubscriptionItem[] = input.items.map((item, index) => {
      if (!item.price) throw missingParam(`items[${index}][price]`);
      // Referential check: every item must point at a real price.
      this.requirePrice(accountId, item.price);
      return {
        id: newId("subscription_item"),
        price: item.price,
        quantity: item.quantity ?? 1,
      };
    });
    const id = newId("subscription");
    this.db
      .prepare(
        `INSERT INTO subscriptions (
          id, account_id, customer_id, status, items_json, cancel_at_period_end,
          canceled_at, ended_at, metadata_json, created
        ) VALUES (?, ?, ?, 'active', ?, ?, NULL, NULL, ?, ?)`
      )
      .run(
        id,
        accountId,
        input.customer,
        JSON.stringify(items),
        input.cancel_at_period_end ? 1 : 0,
        JSON.stringify(liveMetadata(input.metadata)),
        nowUnix()
      );
    return this.requireSubscription(accountId, id);
  }

  requireSubscription(accountId: string, id: string): SubscriptionRow {
    const row = this.db
      .prepare("SELECT * FROM subscriptions WHERE id = ? AND account_id = ?")
      .get(id, accountId) as SubscriptionRow | undefined;
    if (!row) throw noSuch("subscription", id);
    return row;
  }

  /**
   * Update: metadata merges per-key (empty/null unsets — Stripe's metadata
   * contract, same as customers), cancel_at_period_end flips. A canceled
   * subscription refuses updates like real Stripe.
   */
  updateSubscription(
    accountId: string,
    id: string,
    input: UpdateSubscriptionInput
  ): SubscriptionRow {
    const existing = this.requireSubscription(accountId, id);
    if (existing.status === "canceled") {
      throw new TwinError(
        "invalid_request_error",
        "resource_missing",
        "A canceled subscription can only update its metadata.",
        { param: "subscription", statusCode: 400 }
      );
    }
    const metadata = JSON.parse(existing.metadata_json) as Record<string, string>;
    for (const [key, value] of Object.entries(input.metadata ?? {})) {
      if (value === null || value === "") delete metadata[key];
      else metadata[key] = value;
    }
    this.db
      .prepare(
        "UPDATE subscriptions SET cancel_at_period_end = ?, metadata_json = ? WHERE id = ? AND account_id = ?"
      )
      .run(
        input.cancel_at_period_end === undefined
          ? existing.cancel_at_period_end
          : input.cancel_at_period_end
            ? 1
            : 0,
        JSON.stringify(metadata),
        id,
        accountId
      );
    return this.requireSubscription(accountId, id);
  }

  /**
   * DELETE /v1/subscriptions/:id — immediate cancel: status → canceled with
   * canceled_at/ended_at stamped. Idempotent (re-cancel returns the row);
   * shape tier, so no invoice settlement or proration runs.
   */
  cancelSubscription(accountId: string, id: string): SubscriptionRow {
    const existing = this.requireSubscription(accountId, id);
    if (existing.status === "canceled") return existing;
    const now = nowUnix();
    this.db
      .prepare(
        "UPDATE subscriptions SET status = 'canceled', canceled_at = ?, ended_at = ? WHERE id = ? AND account_id = ?"
      )
      .run(now, now, id, accountId);
    return this.requireSubscription(accountId, id);
  }

  /**
   * Like real Stripe, the default list excludes canceled subscriptions;
   * `status=canceled` selects them and `status=all` lifts the filter.
   */
  listSubscriptions(
    accountId: string,
    input: ListBillingInput & { customer?: string; status?: string }
  ): { rows: SubscriptionRow[]; hasMore: boolean; limit: number } {
    const extra: Array<{ sql: string; args: unknown[] }> = [];
    if (input.customer) extra.push({ sql: "customer_id = ?", args: [input.customer] });
    if (input.status === undefined) {
      extra.push({ sql: "status != 'canceled'", args: [] });
    } else if (input.status !== "all") {
      extra.push({ sql: "status = ?", args: [input.status] });
    }
    return listPaginated<SubscriptionRow>(this.db, "subscriptions", accountId, input, extra);
  }
}

/** Drop empty/null metadata values on create (Stripe stores only set keys). */
function liveMetadata(
  metadata: Record<string, string | null> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value !== null && value !== "") out[key] = value;
  }
  return out;
}

function missingParam(param: string): TwinError {
  return new TwinError(
    "invalid_request_error",
    "parameter_missing",
    `Missing required param: ${param}.`,
    { param, statusCode: 400 }
  );
}

export function noSuch(kind: string, id: string): TwinError {
  return new TwinError(
    "invalid_request_error",
    "resource_missing",
    `No such ${kind}: '${id}'.`,
    { param: kind, statusCode: 404 }
  );
}
