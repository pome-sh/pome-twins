// file-size: the PI state machine intentionally keeps both rails (x402 crypto + F-731 card) on one CAS core, plus the listPaginated helper every sibling domain imports.
// SPDX-License-Identifier: Apache-2.0
//
// PaymentIntent state machine + CAS, owned by AGENT-B.
// Two rails: x402 crypto-deposit PIs (v1) and card PIs (F-731).
//
// Crypto rail (x402):
//
//      create (payment_method_types: ["crypto"])
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
// Card rail (F-731):
//
//      create (payment_method_types: ["card"])
//         │ no payment_method            │ payment_method
//         ▼                              ▼
//   requires_payment_method  ──update──▶ requires_confirmation
//         ▲                              │ confirm (leg 1 CAS → processing)
//         │ decline (magic test PM;      ▼
//         │  failed charge +          processing
//         │  last_payment_error)         │ leg 2 (synchronous outcome)
//         └──────────────────────────────┤
//                                        ▼
//                                    succeeded                ← terminal
//
// All status transitions go through `casStatus()`, a SQL UPDATE with a
// `WHERE status = ?` predicate. Zero rows updated ⇒ another writer beat us
// ⇒ 400 with `payment_intent_unexpected_state`. This is the
// "exactly one of N parallel confirms wins" guarantee that the
// concurrency tests depend on.

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
  payment_method?: string;
  customer?: string;
  confirm?: boolean;
  metadata?: Record<string, string>;
  capture_method?: string;
  confirmation_method?: string;
  idempotency_key?: string | null;
};

export type UpdatePIInput = {
  amount?: number;
  metadata?: Record<string, string | null>;
  payment_method?: string;
  customer?: string;
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

  /**
   * Insert a fresh PI. The caller (StripeDomain) has already resolved and
   * cross-validated `payment_method` / `customer` for the card rail —
   * `resolved` carries the validated ids so this module stays free of the
   * sibling domains.
   */
  create(
    accountId: string,
    input: CreatePIInput,
    resolved: { paymentMethodId: string | null; customerId: string | null }
  ): PIRow {
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
    const pmType = pmTypes.length === 1 ? pmTypes[0] : undefined;
    if (pmType !== "crypto" && pmType !== "card") {
      throw new TwinError(
        "invalid_request_error",
        "parameter_invalid_string",
        "payment_method_types must be exactly [\"crypto\"] or [\"card\"] for this twin.",
        { param: "payment_method_types", statusCode: 400 }
      );
    }

    const id = newId("payment_intent");
    const clientSecret = newClientSecret(id);
    const now = nowUnix();

    let status: PIStatus;
    let nextActionJson: string | null = null;
    let cryptoDepositJson: string | null = null;

    if (pmType === "crypto") {
      // Mirror image of the card rail's crypto-options rejection: the
      // card-only params fail loudly instead of being silently dropped.
      if (input.payment_method || input.customer || input.confirm) {
        throw new TwinError(
          "invalid_request_error",
          "parameter_invalid_string",
          "payment_method, customer, and confirm are only valid with payment_method_types [\"card\"].",
          { param: "payment_method", statusCode: 400 }
        );
      }
      const cryptoOpts = input.payment_method_options?.crypto;
      if (!cryptoOpts || cryptoOpts.mode !== "deposit") {
        throw new TwinError(
          "invalid_request_error",
          "parameter_invalid_string",
          "payment_method_options.crypto.mode must be \"deposit\" for crypto PaymentIntents.",
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
      status = "requires_action";
      nextActionJson = JSON.stringify({
        type: "display_crypto_deposit_information",
        crypto_display_details: cryptoDeposit,
      });
      cryptoDepositJson = JSON.stringify(cryptoDeposit);
    } else {
      // Card rail: the crypto deposit options are the x402 rail only.
      if (input.payment_method_options?.crypto) {
        throw new TwinError(
          "invalid_request_error",
          "parameter_invalid_string",
          "payment_method_options.crypto is only valid with payment_method_types [\"crypto\"].",
          { param: "payment_method_options[crypto]", statusCode: 400 }
        );
      }
      status = resolved.paymentMethodId ? "requires_confirmation" : "requires_payment_method";
    }

    this.db
      .prepare(
        `INSERT INTO payment_intents (
          id, account_id, amount, currency, status,
          payment_method_types_json, next_action_json,
          latest_charge_id, capture_method, confirmation_method,
          idempotency_key, metadata_json, crypto_deposit_json,
          client_secret, created, updated, canceled_at, captured_at,
          payment_method_id, customer_id, last_payment_error_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`
      )
      .run(
        id,
        accountId,
        input.amount,
        currency,
        status,
        JSON.stringify(pmTypes),
        nextActionJson,
        input.capture_method ?? DEFAULT_CAPTURE_METHOD,
        input.confirmation_method ?? DEFAULT_CONFIRMATION_METHOD,
        input.idempotency_key ?? null,
        JSON.stringify(input.metadata ?? {}),
        cryptoDepositJson,
        clientSecret,
        now,
        now,
        resolved.paymentMethodId,
        resolved.customerId
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

  /**
   * Card confirm leg 1: CAS the observed pre-confirm status
   * (`requires_confirmation` or `requires_payment_method`) → `processing`,
   * stamping the PM being attempted. Exactly one of N parallel confirms
   * wins this CAS; losers see `payment_intent_unexpected_state`.
   */
  confirmCardLeg1(
    accountId: string,
    id: string,
    expected: PIStatus,
    paymentMethodId: string
  ): PIRow {
    return this.casStatusOrThrow(accountId, id, expected, "processing", {
      payment_method_id: paymentMethodId,
    });
  }

  /** Card confirm leg 2, success: processing → succeeded with the charge. */
  finalizeCardSuccess(accountId: string, id: string, latestChargeId: string): PIRow {
    return this.casStatusOrThrow(accountId, id, "processing", "succeeded", {
      latest_charge_id: latestChargeId,
      captured_at: nowUnix(),
      last_payment_error_json: null,
    });
  }

  /**
   * Card confirm leg 2, decline: processing → requires_payment_method with
   * the failed charge and `last_payment_error` on the record. The declined
   * PM is dropped from the PI, like real Stripe.
   */
  finalizeCardDecline(
    accountId: string,
    id: string,
    failedChargeId: string,
    lastPaymentErrorJson: string
  ): PIRow {
    return this.casStatusOrThrow(accountId, id, "processing", "requires_payment_method", {
      latest_charge_id: failedChargeId,
      payment_method_id: null,
      last_payment_error_json: lastPaymentErrorJson,
    });
  }

  // ---------- update (POST /v1/payment_intents/:id, F-731) ----------

  /**
   * Update a non-terminal PI. Metadata merges per-key (empty/null unsets,
   * Stripe's metadata contract). `payment_method` / `customer` are only
   * valid on the card rail and have been resolved by the caller;
   * attaching a PM moves requires_payment_method → requires_confirmation.
   * The UPDATE is guarded on the observed status so a racing confirm wins.
   */
  update(
    accountId: string,
    id: string,
    input: UpdatePIInput,
    resolved: { paymentMethodId?: string | null; customerId?: string | null } = {}
  ): PIRow {
    const pi = this.requireById(accountId, id);
    const updatable: ReadonlySet<PIStatus> = new Set([
      "requires_payment_method",
      "requires_confirmation",
      "requires_action",
    ]);
    if (!updatable.has(pi.status)) {
      throw piUnexpectedState(pi.status);
    }
    const isCard = piTypes(pi).includes("card");
    // Crypto PIs accept metadata-only updates: the x402 challenge (amount,
    // deposit address) is minted at create time and must stay consistent
    // with the middleware's cached challenge.
    if (
      !isCard &&
      (input.amount !== undefined ||
        input.payment_method !== undefined ||
        input.customer !== undefined)
    ) {
      throw new TwinError(
        "invalid_request_error",
        "parameter_invalid_string",
        "Only metadata can be updated on crypto PaymentIntents.",
        { param: "payment_method", statusCode: 400 }
      );
    }
    if (input.amount !== undefined && (!Number.isInteger(input.amount) || input.amount <= 0)) {
      throw new TwinError(
        "invalid_request_error",
        "parameter_invalid_integer",
        "Amount must be a positive integer.",
        { param: "amount", statusCode: 400 }
      );
    }

    const metadata = JSON.parse(pi.metadata_json) as Record<string, string>;
    for (const [key, value] of Object.entries(input.metadata ?? {})) {
      if (value === null || value === "") delete metadata[key];
      else metadata[key] = value;
    }

    const nextPaymentMethodId =
      input.payment_method !== undefined ? (resolved.paymentMethodId ?? null) : pi.payment_method_id;
    const nextCustomerId =
      input.customer !== undefined ? (resolved.customerId ?? null) : pi.customer_id;
    let nextStatus = pi.status;
    if (isCard) {
      if (nextPaymentMethodId && pi.status === "requires_payment_method") {
        nextStatus = "requires_confirmation";
      } else if (!nextPaymentMethodId && pi.status === "requires_confirmation") {
        nextStatus = "requires_payment_method";
      }
    }

    const updated = this.db
      .prepare(
        `UPDATE payment_intents SET
           amount = ?, metadata_json = ?, payment_method_id = ?, customer_id = ?,
           status = ?, updated = ?
         WHERE id = ? AND account_id = ? AND status = ? RETURNING *`
      )
      .get(
        input.amount ?? pi.amount,
        JSON.stringify(metadata),
        nextPaymentMethodId,
        nextCustomerId,
        nextStatus,
        nowUnix(),
        id,
        accountId,
        pi.status
      ) as PIRow | undefined;
    if (!updated) {
      const fresh = this.requireById(accountId, id);
      throw piUnexpectedState(fresh.status);
    }
    return updated;
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
    return this.casStatusOrThrow(accountId, id, "requires_action", "processing");
  }

  /** Second CAS leg: processing → succeeded. */
  simulateCryptoDepositLeg2(accountId: string, id: string, latestChargeId: string): PIRow {
    return this.casStatusOrThrow(accountId, id, "processing", "succeeded", {
      latest_charge_id: latestChargeId,
      captured_at: nowUnix(),
    });
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
   * casStatus + the shared lost-the-race contract: re-read the fresh row
   * so the loser's `payment_intent_unexpected_state` names the status that
   * actually beat it. Every CAS leg on both rails goes through here.
   */
  private casStatusOrThrow(
    accountId: string,
    id: string,
    expected: PIStatus,
    next: PIStatus,
    extras: Partial<PIRow> = {}
  ): PIRow {
    const updated = this.casStatus(accountId, id, expected, next, extras);
    if (!updated) {
      const fresh = this.requireById(accountId, id);
      throw piUnexpectedState(fresh.status);
    }
    return updated;
  }

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
    if ("payment_method_id" in extras) {
      sets.push("payment_method_id = ?");
      values.push(extras.payment_method_id ?? null);
    }
    if ("last_payment_error_json" in extras) {
      sets.push("last_payment_error_json = ?");
      values.push(extras.last_payment_error_json ?? null);
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

/** Parsed payment_method_types for a PI row (["crypto"] fallback, pre-F-731 rows). */
export function piTypes(pi: PIRow): string[] {
  try {
    const parsed = JSON.parse(pi.payment_method_types_json) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : ["crypto"];
  } catch {
    return ["crypto"];
  }
}

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
 *
 * `extraWheres` lets a caller inject table-specific predicates (e.g. the
 * customers table's `deleted = 0`, payment_methods' `customer_id = ?`)
 * without teaching this generic helper every column name.
 */
export function listPaginated<T extends { id: string; created: number }>(
  db: TwinStripeDatabase,
  table: string,
  accountId: string,
  input: ListPIsInput & { type?: string; payment_intent?: string; customer?: string },
  extraWheres: Array<{ sql: string; args: unknown[] }> = []
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
  for (const extra of extraWheres) {
    wheres.push(extra.sql);
    args.push(...extra.args);
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
