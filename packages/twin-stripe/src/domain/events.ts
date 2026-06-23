// SPDX-License-Identifier: Apache-2.0
// Events domain. Owned by AGENT-B.
//
// v1 does NOT deliver webhooks. Agents poll `GET /v1/events`.
// Webhook endpoint CRUD + delivery loop is deferred to v2.

import type { TwinStripeDatabase, EventRow } from "../types.js";
import { TwinError } from "../errors.js";
import { newId } from "../ids.js";
import { nowUnix } from "../util.js";
import { STRIPE_API_VERSION } from "./constants.js";
import { ensureStripeTables } from "./schema.js";
import { listPaginated } from "./payment-intents.js";

export type EventType =
  | "payment_intent.created"
  | "payment_intent.requires_action"
  | "payment_intent.processing"
  | "payment_intent.succeeded"
  | "payment_intent.canceled"
  | "charge.succeeded"
  | "charge.refunded";

export type CreateEventInput = {
  type: EventType;
  // Serialized Stripe-shape object (PI/charge/etc). Stored as `data.object`
  // when the event is serialized out.
  object: unknown;
  request_idempotency_key?: string | null;
};

export type ListEventsInput = {
  limit?: number;
  type?: string;
  created_gt?: number;
  created_gte?: number;
  created_lt?: number;
  created_lte?: number;
};

export class EventsDomain {
  constructor(readonly db: TwinStripeDatabase) {
    ensureStripeTables(db);
  }

  create(accountId: string, input: CreateEventInput): EventRow {
    const id = newId("event");
    const now = nowUnix();
    this.db
      .prepare(
        `INSERT INTO events (
          id, account_id, type, data_json, request_idempotency_key, livemode,
          api_version, created
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        id,
        accountId,
        input.type,
        JSON.stringify({ object: input.object }),
        input.request_idempotency_key ?? null,
        STRIPE_API_VERSION,
        now
      );
    return this.requireById(accountId, id);
  }

  getById(accountId: string, id: string): EventRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM events WHERE id = ? AND account_id = ?")
        .get(id, accountId) as EventRow | undefined) ?? null
    );
  }

  requireById(accountId: string, id: string): EventRow {
    const row = this.getById(accountId, id);
    if (!row) {
      throw new TwinError(
        "invalid_request_error",
        "resource_missing",
        `No such event: '${id}'.`,
        { param: "event", statusCode: 404 }
      );
    }
    return row;
  }

  list(accountId: string, input: ListEventsInput): { rows: EventRow[]; hasMore: boolean; limit: number } {
    return listPaginated<EventRow>(this.db, "events", accountId, input);
  }
}
