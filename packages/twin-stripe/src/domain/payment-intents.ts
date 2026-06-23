// SPDX-License-Identifier: Apache-2.0
//
// PaymentIntent state machine + CAS, owned by AGENT-B.
// v1 scope: x402 crypto-deposit PIs only.
//
// State machine (v1, crypto-deposit only):
//
//      create (with payment_method_types: ["crypto"])
//         │
//         ▼
//   requires_action  ◀──── confirm (idempotent no-op for crypto)
//         │  cancel
//         ▼
//      canceled                   ← terminal
//         │
//         ▼  (simulate_crypto_deposit, leg 1)
//      processing
//         │
//         ▼  (simulate_crypto_deposit, leg 2 — synchronous)
//      succeeded                  ← terminal
//
// All status transitions go through `casStatus()`, a SQL UPDATE with a
// `WHERE status = ?` predicate. Zero rows updated ⇒ another writer beat us
// ⇒ 409 with `payment_intent_unexpected_state`. This is the
// "exactly one of N parallel confirms wins" guarantee that the
// concurrency test depends on.

import { createHash } from "node:crypto";
import type { TwinStripeDatabase, PIRow, PIStatus } from "../types.js";
import { TwinError } from "../errors.js";
import { newId, newClientSecret } from "../ids.js";
import { nowUnix } from "../util.js";
import {
  BASE_USDC_CONTRACT_ADDRESS,
  CRYPTO_CURRENCIES,
  DEFAULT_CAPTURE_METHOD,
  DEFAULT_CONFIRMATION_METHOD,
  SUPPORTED_NETWORKS,
} from "./constants.js";
import { ensureStripeTables } from "./schema.js";

export type PaymentMethodOptionsCrypto = {
  mode: "deposit";
  deposit_options?: {
    networks?: ReadonlyArray<string>;
  };
};

export type CreatePIInput = {
  amount: number;
  currency: string;
  payment_method_types: ReadonlyArray<string>;
  payment_method_options?: { crypto?: PaymentMethodOptionsCrypto };
  metadata?: Record<string, string>;
  capture_method?: string;
  confirmation_method?: string;
  idempotency_key?: string | null;
};

export type ListPIsInput = {
  limit?: number;
  starting_after?: string;
  ending_before?: string;
  created_gt?: number;
  created_gte?: number;
  created_lt?: number;
  created_lte?: number;
};

const TERMINAL_STATES: ReadonlySet<PIStatus> = new Set([
  "succeeded",
  "canceled",
]);

export class PaymentIntentsDomain {
  constructor(readonly db: TwinStripeDatabase) {
    ensureStripeTables(db);
  }

  // ---------- create ----------

  create(accountId: string, input: CreatePIInput): PIRow {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new TwinError(
        "invalid_request_error",
        "parameter_invalid_integer",
        "Amount must be a positive integer.",
        { param: "amount", statusCode: 400 }
      );
    }
    const currency = (input.currency ?? "").toLowerCase();
    if (!currency) {
      throw new TwinError(
        "invalid_request_error",
        "parameter_missing",
        "Missing required param: currency.",
        { param: "currency", statusCode: 400 }
      );
    }
    if (!CRYPTO_CURRENCIES.includes(currency as (typeof CRYPTO_CURRENCIES)[number])) {
      throw new TwinError(
        "invalid_request_error",
        "currency_not_supported",
        `Currency '${currency}' is not supported by this twin (v1 supports: ${CRYPTO_CURRENCIES.join(", ")}).`,
        { param: "currency", statusCode: 400 }
      );
    }
    const pmTypes = input.payment_method_types ?? [];
    if (!Array.isArray(pmTypes) || pmTypes.length !== 1 || pmTypes[0] !== "crypto") {
      throw new TwinError(
        "invalid_request_error",
        "parameter_invalid_string",
        "payment_method_types must be exactly [\"crypto\"] for v1 of this twin.",
        { param: "payment_method_types", statusCode: 400 }
      );
    }
    const cryptoOpts = input.payment_method_options?.crypto;
    if (!cryptoOpts || cryptoOpts.mode !== "deposit") {
      throw new TwinError(
        "invalid_request_error",
        "parameter_invalid_string",
        "payment_method_options.crypto.mode must be \"deposit\" for v1 of this twin.",
        { param: "payment_method_options[crypto][mode]", statusCode: 400 }
      );
    }
    const networks = cryptoOpts.deposit_options?.networks ?? [];
    const network = networks[0];
    if (!network || !SUPPORTED_NETWORKS.includes(network as (typeof SUPPORTED_NETWORKS)[number])) {
      throw new TwinError(
        "invalid_request_error",
        "parameter_invalid_string",
        `payment_method_options.crypto.deposit_options.networks must include one of: ${SUPPORTED_NETWORKS.join(", ")}.`,
        { param: "payment_method_options[crypto][deposit_options][networks]", statusCode: 400 }
      );
    }

    const id = newId("payment_intent");
    const clientSecret = newClientSecret(id);
    const now = nowUnix();

    // Deterministic 0x deposit address derived from the PI ID. 40 hex chars.
    const address = depositAddressFromId(id);

    const cryptoDeposit = {
      deposit_addresses: {
        [network]: {
          address,
          supported_tokens: [
            {
              token_currency: "usdc",
              token_contract_address: BASE_USDC_CONTRACT_ADDRESS,
            },
          ],
        },
      },
    };

    const nextAction = {
      type: "display_crypto_deposit_information",
      crypto_display_details: cryptoDeposit,
    };

    this.db
      .prepare(
        `INSERT INTO payment_intents (
          id, account_id, amount, currency, status,
          payment_method_types_json, next_action_json,
          latest_charge_id, capture_method, confirmation_method,
          idempotency_key, metadata_json, crypto_deposit_json,
          client_secret, created, updated, canceled_at, captured_at
        ) VALUES (?, ?, ?, ?, 'requires_action', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
      )
      .run(
        id,
        accountId,
        input.amount,
        currency,
        JSON.stringify(pmTypes),
        JSON.stringify(nextAction),
        input.capture_method ?? DEFAULT_CAPTURE_METHOD,
        input.confirmation_method ?? DEFAULT_CONFIRMATION_METHOD,
        input.idempotency_key ?? null,
        JSON.stringify(input.metadata ?? {}),
        JSON.stringify(cryptoDeposit),
        clientSecret,
        now,
        now
      );

    return this.requireById(accountId, id);
  }

  // ---------- confirm ----------

  /**
   * Crypto-deposit confirm is idempotent. If the PI is already in
   * `requires_action`, return it unchanged. If it's mid- or post-flight
   * (`processing` / `succeeded`), return it. Only `canceled` is rejected.
   */
  confirm(accountId: string, id: string): PIRow {
    const pi = this.requireById(accountId, id);
    if (pi.status === "canceled") {
      throw piUnexpectedState(pi.status);
    }
    return pi;
  }

  // ---------- cancel ----------

  cancel(accountId: string, id: string): PIRow {
    const pi = this.requireById(accountId, id);
    if (pi.status === "succeeded") {
      throw piUnexpectedState(pi.status, "Cannot cancel a succeeded PaymentIntent.");
    }
    if (pi.status === "canceled") {
      // Idempotent: return existing.
      return pi;
    }
    // CAS from current non-terminal status → 'canceled'.
    const updated = this.casStatus(accountId, id, pi.status, "canceled", { canceled_at: nowUnix() });
    if (!updated) throw piUnexpectedState(pi.status);
    return updated;
  }

  // ---------- simulate_crypto_deposit (test_helpers) ----------

  /**
   * Drive a PI from requires_action → processing → succeeded.
   * Both transitions are CAS — exactly one parallel call wins each leg.
   * Returns { pi, charge, balanceTx, events: rows of side-effect ids }.
   * Side-effect emission (events, charge mint, balance txn) is the
   * caller's job — `simulate` is the bare state-advancement here. To keep
   * the routes simple we colocate it. See routes/payment-intents.ts.
   */
  simulateCryptoDepositLeg1(accountId: string, id: string): PIRow {
    const pi = this.requireById(accountId, id);
    if (pi.status === "succeeded" || pi.status === "canceled") {
      throw piUnexpectedState(
        pi.status,
        `PaymentIntent is in terminal state '${pi.status}' and cannot be advanced.`
      );
    }
    if (pi.status !== "requires_action") {
      throw piUnexpectedState(pi.status);
    }
    const updated = this.casStatus(accountId, id, "requires_action", "processing");
    if (!updated) {
      // Lost the race. Read fresh state for the error message.
      const fresh = this.requireById(accountId, id);
      throw piUnexpectedState(fresh.status);
    }
    return updated;
  }

  /** Second CAS leg: processing → succeeded. */
  simulateCryptoDepositLeg2(accountId: string, id: string, latestChargeId: string): PIRow {
    const updated = this.casStatus(accountId, id, "processing", "succeeded", {
      latest_charge_id: latestChargeId,
      captured_at: nowUnix(),
    });
    if (!updated) {
      const fresh = this.requireById(accountId, id);
      throw piUnexpectedState(fresh.status);
    }
    return updated;
  }

  // ---------- read ----------

  getById(accountId: string, id: string): PIRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM payment_intents WHERE id = ? AND account_id = ?")
        .get(id, accountId) as PIRow | undefined) ?? null
    );
  }

  requireById(accountId: string, id: string): PIRow {
    const pi = this.getById(accountId, id);
    if (!pi) {
      throw new TwinError(
        "invalid_request_error",
        "resource_missing",
        `No such payment_intent: '${id}'.`,
        { param: "intent", statusCode: 404 }
      );
    }
    return pi;
  }

  list(accountId: string, input: ListPIsInput): { rows: PIRow[]; hasMore: boolean; limit: number } {
    return listPaginated<PIRow>(this.db, "payment_intents", accountId, input);
  }

  // ---------- internals ----------

  /**
   * Compare-and-swap on `status`. Returns the new row, or `null` if no row
   * matched the predicate. The predicate is `(id = ? AND account_id = ? AND status = ?)`.
   */
  private casStatus(
    accountId: string,
    id: string,
    expected: PIStatus,
    next: PIStatus,
    extras: Partial<PIRow> = {}
  ): PIRow | null {
    const sets = ["status = ?", "updated = ?"];
    const values: unknown[] = [next, nowUnix()];
    if ("latest_charge_id" in extras) {
      sets.push("latest_charge_id = ?");
      values.push(extras.latest_charge_id ?? null);
    }
    if ("canceled_at" in extras) {
      sets.push("canceled_at = ?");
      values.push(extras.canceled_at ?? null);
    }
    if ("captured_at" in extras) {
      sets.push("captured_at = ?");
      values.push(extras.captured_at ?? null);
    }
    const sql = `UPDATE payment_intents SET ${sets.join(", ")} WHERE id = ? AND account_id = ? AND status = ? RETURNING *`;
    values.push(id, accountId, expected);
    return (
      (this.db.prepare(sql).get(...(values as unknown[])) as PIRow | undefined) ??
      null
    );
  }
}

// ---------- helpers used by routes/serializers too ----------

export function piUnexpectedState(currentStatus: string, message?: string): TwinError {
  return new TwinError(
    "invalid_request_error",
    "payment_intent_unexpected_state",
    message ??
      `The PaymentIntent has a status of '${currentStatus}'. The requested action could not be performed.`,
    { statusCode: 400 }
  );
}

/**
 * Deterministic 0x address (40 hex chars) derived from the PI ID. Stable
 * across processes — so a buyer agent can reproduce the address from the PI
 * ID for the x402 flow.
 */
export function depositAddressFromId(id: string): string {
  // Deterministic deposit address derived from PI ID via sha256.
  // PI IDs are `pi_<24chars base62>`; the digest gives plenty of hex.
  const digest = createHash("sha256").update(id).digest("hex");
  return `0x${digest.slice(0, 40)}`;
}

/**
 * Cursor pagination over a single Stripe-shaped table.
 *
 * `accountId` scopes results to the calling session's account so two
 * sessions sharing a DB file cannot see each other's rows.
 */
export function listPaginated<T extends { id: string; created: number }>(
  db: TwinStripeDatabase,
  table: string,
  accountId: string,
  input: ListPIsInput & { type?: string; payment_intent?: string; customer?: string }
): { rows: T[]; hasMore: boolean; limit: number } {
  const limitRaw = input.limit ?? 10;
  const limit = Math.min(100, Math.max(1, Math.floor(limitRaw)));

  const wheres: string[] = ["account_id = ?"];
  const args: unknown[] = [accountId];

  if (input.starting_after) {
    const cursor = cursorRow(db, table, accountId, input.starting_after);
    if (cursor) {
      wheres.push("(created < ? OR (created = ? AND id < ?))");
      args.push(cursor.created, cursor.created, cursor.id);
    }
  }
  if (input.ending_before) {
    const cursor = cursorRow(db, table, accountId, input.ending_before);
    if (cursor) {
      wheres.push("(created > ? OR (created = ? AND id > ?))");
      args.push(cursor.created, cursor.created, cursor.id);
    }
  }
  if (typeof input.created_gt === "number") {
    wheres.push("created > ?");
    args.push(input.created_gt);
  }
  if (typeof input.created_gte === "number") {
    wheres.push("created >= ?");
    args.push(input.created_gte);
  }
  if (typeof input.created_lt === "number") {
    wheres.push("created < ?");
    args.push(input.created_lt);
  }
  if (typeof input.created_lte === "number") {
    wheres.push("created <= ?");
    args.push(input.created_lte);
  }
  if (input.type) {
    wheres.push("type = ?");
    args.push(input.type);
  }
  if (input.payment_intent) {
    wheres.push("payment_intent_id = ?");
    args.push(input.payment_intent);
  }

  const where = `WHERE ${wheres.join(" AND ")}`;
  const sql = `SELECT * FROM ${table} ${where} ORDER BY created DESC, id DESC LIMIT ?`;
  // Fetch limit + 1 to compute `has_more`.
  const rows = db.prepare(sql).all(...args, limit + 1) as T[];
  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore, limit };
}

function cursorRow(
  db: TwinStripeDatabase,
  table: string,
  accountId: string,
  id: string
): { id: string; created: number } | null {
  return (
    (db
      .prepare(`SELECT id, created FROM ${table} WHERE id = ? AND account_id = ?`)
      .get(id, accountId) as { id: string; created: number } | undefined) ?? null
  );
}

export { TERMINAL_STATES };
