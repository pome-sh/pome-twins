// SPDX-License-Identifier: Apache-2.0
// v1 default seed mints exactly one api key (sk_test_pome_default → sid="default").
// Other twin state is empty by design — agent runs create their own PIs.
//
// FDRS-364 extends the seed shape to also accept prerequisite Stripe state
// (payment_intents / charges / refunds / balance_transactions) so scenarios
// can stand up "agent walks in mid-flow" situations like scenario 14's
// refund-retry double-charge. Each new collection mirrors the wire shape
// returned by `GET /v1/<resource>/:id`; on apply, rows are inserted directly
// into the same SQLite tables the domain helpers write to, so a seeded row
// is indistinguishable from one created by `simulateCryptoDeposit` /
// `POST /v1/refunds` on read.
import { z } from "zod";
import {
  failureInjectionRuleSchema,
  type FailureInjectionStore,
} from "@pome-sh/sdk/server";
import { mintApiKey } from "./api-keys.js";
import { ensureStripeTables } from "./domain/schema.js";
import type { SeedState, TwinStripeDatabase } from "./types.js";

export const DEFAULT_SID = "default";
export const DEFAULT_API_KEY = "sk_test_pome_default";

const PI_STATUSES = [
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "processing",
  "requires_capture",
  "canceled",
  "succeeded",
] as const;

const CHARGE_STATUSES = ["pending", "succeeded", "failed"] as const;
const REFUND_STATUSES = ["succeeded", "pending", "failed", "canceled"] as const;
const BALANCE_TX_STATUSES = ["pending", "available"] as const;

const paymentIntentSeedSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  amount: z.number().int(),
  currency: z.string().min(1),
  status: z.enum(PI_STATUSES),
  payment_method_types: z.array(z.string()).default(["crypto"]),
  next_action: z.unknown().nullable().optional(),
  latest_charge_id: z.string().nullable().optional(),
  capture_method: z.string().default("automatic"),
  confirmation_method: z.string().default("automatic"),
  idempotency_key: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).default({}),
  crypto_deposit: z.unknown().nullable().optional(),
  client_secret: z.string().min(1),
  created: z.number().int(),
  updated: z.number().int(),
  canceled_at: z.number().int().nullable().optional(),
  captured_at: z.number().int().nullable().optional(),
});

const chargeSeedSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  payment_intent_id: z.string().min(1),
  amount: z.number().int(),
  amount_captured: z.number().int().default(0),
  amount_refunded: z.number().int().default(0),
  status: z.enum(CHARGE_STATUSES),
  balance_transaction_id: z.string().nullable().optional(),
  captured: z.boolean().default(true),
  currency: z.string().min(1),
  created: z.number().int(),
});

const refundSeedSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  charge_id: z.string().min(1),
  payment_intent_id: z.string().min(1),
  amount: z.number().int(),
  currency: z.string().min(1),
  status: z.enum(REFUND_STATUSES),
  reason: z.string().nullable().optional(),
  balance_transaction_id: z.string().nullable().optional(),
  idempotency_key: z.string().nullable().optional(),
  created: z.number().int(),
});

const balanceTransactionSeedSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  type: z.string().min(1),
  amount: z.number().int(),
  fee: z.number().int().default(0),
  net: z.number().int(),
  currency: z.string().min(1),
  source_id: z.string().nullable().optional(),
  source_type: z.string().nullable().optional(),
  available_on: z.number().int(),
  status: z.enum(BALANCE_TX_STATUSES).default("available"),
  created: z.number().int(),
});

export type PaymentIntentSeed = z.infer<typeof paymentIntentSeedSchema>;
export type ChargeSeed = z.infer<typeof chargeSeedSchema>;
export type RefundSeed = z.infer<typeof refundSeedSchema>;
export type BalanceTransactionSeed = z.infer<typeof balanceTransactionSeedSchema>;

export const seedSchema = z.object({
  api_keys: z
    .array(
      z.object({
        key: z.string().min(1),
        sid: z.string().min(1),
        account_id: z.string().min(1).optional()
      })
    )
    .default([]),
  failure_injection: z.array(failureInjectionRuleSchema).default([]),
  payment_intents: z.array(paymentIntentSeedSchema).default([]),
  charges: z.array(chargeSeedSchema).default([]),
  refunds: z.array(refundSeedSchema).default([]),
  balance_transactions: z.array(balanceTransactionSeedSchema).default([]),
});

export function parseSeed(input: unknown): SeedState {
  return seedSchema.parse(input);
}

/**
 * Boot-time seed loader: prefer `POME_SEED_JSON` env (set by the cloud
 * control-plane from the CLI-supplied scenario seed; see FDRS-353 +
 * FDRS-361) and fall back to `defaultSeed()` when the env is absent.
 *
 * Unwrap contract (FDRS-365 + FDRS-369): scenarios may send the
 * canonical wrapped shape `{ stripe: { seed: {...} } }` (what scenario
 * 14 uses) or the flat shape `{ payment_intents: [...], ... }`. We peel
 * `body.stripe?.seed ?? body` so both shapes work end-to-end without
 * a cloud-side rewrite. Throws on malformed JSON or schema-invalid
 * seed, so a misconfigured cloud deploy fails the twin server's
 * healthz instead of silently booting with an empty Stripe world.
 */
export function loadSeedFromEnv(env: NodeJS.ProcessEnv = process.env): SeedState {
  const raw = env.POME_SEED_JSON;
  if (raw === undefined || raw === "") {
    return defaultSeed();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `POME_SEED_JSON is not valid JSON: ${(err as Error).message}`
    );
  }
  const unwrapped = unwrapStripeSeed(parsed);
  return parseSeed(unwrapped);
}

function unwrapStripeSeed(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const stripeKey = (value as Record<string, unknown>).stripe;
    if (stripeKey && typeof stripeKey === "object" && !Array.isArray(stripeKey)) {
      const inner = (stripeKey as Record<string, unknown>).seed;
      if (inner !== undefined) {
        return inner;
      }
    }
  }
  return value;
}

export function defaultSeed(): SeedState {
  return {
    api_keys: [
      { key: DEFAULT_API_KEY, sid: DEFAULT_SID, account_id: `acct_${DEFAULT_SID}` }
    ],
    failure_injection: [],
    payment_intents: [],
    charges: [],
    refunds: [],
    balance_transactions: [],
  };
}

export function applySeed(
  db: TwinStripeDatabase,
  seed: SeedState,
  failureInjection?: FailureInjectionStore
): void {
  // Ensure Stripe domain tables exist before inserting prerequisite rows.
  // Mirrors what each Domain class does in its constructor; harmless when
  // already migrated.
  ensureStripeTables(db);

  for (const entry of seed.api_keys ?? []) {
    mintApiKey(db, {
      sid: entry.sid,
      account_id: entry.account_id,
      key: entry.key
    });
  }
  for (const row of seed.payment_intents ?? []) {
    insertSeedPaymentIntent(db, row);
  }
  for (const row of seed.charges ?? []) {
    insertSeedCharge(db, row);
  }
  for (const row of seed.balance_transactions ?? []) {
    insertSeedBalanceTransaction(db, row);
  }
  for (const row of seed.refunds ?? []) {
    insertSeedRefund(db, row);
  }
  if (failureInjection) {
    failureInjection.setRules(seed.failure_injection ?? []);
  }
}

// ---------- raw row inserts ----------
//
// These bypass the domain classes' business rules (PI state machine, charge
// minting invariants, refund atomic transaction, etc.) and write directly to
// the tables defined in `domain/schema.ts`. The point is that the rows must
// be read back via the same domain helpers and serializers the live handlers
// use, with no observable difference from agent-created rows.

function insertSeedPaymentIntent(
  db: TwinStripeDatabase,
  row: PaymentIntentSeed
): void {
  db.prepare(
    `INSERT INTO payment_intents (
      id, account_id, amount, currency, status,
      payment_method_types_json, next_action_json,
      latest_charge_id, capture_method, confirmation_method,
      idempotency_key, metadata_json, crypto_deposit_json,
      client_secret, created, updated, canceled_at, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.account_id,
    row.amount,
    row.currency,
    row.status,
    JSON.stringify(row.payment_method_types),
    row.next_action === undefined || row.next_action === null
      ? null
      : JSON.stringify(row.next_action),
    row.latest_charge_id ?? null,
    row.capture_method,
    row.confirmation_method,
    row.idempotency_key ?? null,
    JSON.stringify(row.metadata),
    row.crypto_deposit === undefined || row.crypto_deposit === null
      ? null
      : JSON.stringify(row.crypto_deposit),
    row.client_secret,
    row.created,
    row.updated,
    row.canceled_at ?? null,
    row.captured_at ?? null
  );
}

function insertSeedCharge(db: TwinStripeDatabase, row: ChargeSeed): void {
  db.prepare(
    `INSERT INTO charges (
      id, account_id, payment_intent_id, amount, amount_captured, amount_refunded,
      status, balance_transaction_id, captured, currency, created
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.account_id,
    row.payment_intent_id,
    row.amount,
    row.amount_captured,
    row.amount_refunded,
    row.status,
    row.balance_transaction_id ?? null,
    row.captured ? 1 : 0,
    row.currency,
    row.created
  );
}

function insertSeedRefund(db: TwinStripeDatabase, row: RefundSeed): void {
  db.prepare(
    `INSERT INTO refunds (
      id, account_id, charge_id, payment_intent_id, amount, currency,
      status, reason, balance_transaction_id, idempotency_key, created
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.account_id,
    row.charge_id,
    row.payment_intent_id,
    row.amount,
    row.currency,
    row.status,
    row.reason ?? null,
    row.balance_transaction_id ?? null,
    row.idempotency_key ?? null,
    row.created
  );
}

function insertSeedBalanceTransaction(
  db: TwinStripeDatabase,
  row: BalanceTransactionSeed
): void {
  db.prepare(
    `INSERT INTO balance_transactions (
      id, account_id, type, amount, fee, net, currency, source_id, source_type,
      available_on, status, created
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.account_id,
    row.type,
    row.amount,
    row.fee,
    row.net,
    row.currency,
    row.source_id ?? null,
    row.source_type ?? null,
    row.available_on,
    row.status,
    row.created
  );
}
