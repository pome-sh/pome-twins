// SPDX-License-Identifier: Apache-2.0
// Stripe domain table migrations. Owned by AGENT-B.
//
// AGENT-A's `src/db.ts` is responsible for opening the database and
// running cross-cutting migrations (idempotency_keys, api_keys, audit_log).
// This module defines the Stripe-specific tables (PIs, charges, balance
// transactions, events) and is called from anywhere a fresh DB is opened.
//
// Idempotent: every CREATE is `IF NOT EXISTS`. Safe to call repeatedly.

import type { TwinStripeDatabase } from "../types.js";

const STRIPE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  payment_method_types_json TEXT NOT NULL,
  next_action_json TEXT,
  latest_charge_id TEXT,
  capture_method TEXT NOT NULL DEFAULT 'automatic',
  confirmation_method TEXT NOT NULL DEFAULT 'automatic',
  idempotency_key TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  crypto_deposit_json TEXT,
  client_secret TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  canceled_at INTEGER,
  captured_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_payment_intents_created ON payment_intents(created);
CREATE INDEX IF NOT EXISTS idx_payment_intents_status ON payment_intents(status);
CREATE INDEX IF NOT EXISTS idx_payment_intents_account_id ON payment_intents(account_id);

CREATE TABLE IF NOT EXISTS charges (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  payment_intent_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  amount_captured INTEGER NOT NULL DEFAULT 0,
  amount_refunded INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  balance_transaction_id TEXT,
  captured INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (payment_intent_id) REFERENCES payment_intents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_charges_pi ON charges(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_charges_created ON charges(created);
CREATE INDEX IF NOT EXISTS idx_charges_account_id ON charges(account_id);

CREATE TABLE IF NOT EXISTS balance_transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0,
  net INTEGER NOT NULL,
  currency TEXT NOT NULL,
  source_id TEXT,
  source_type TEXT,
  available_on INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_balance_tx_created ON balance_transactions(created);
CREATE INDEX IF NOT EXISTS idx_balance_tx_source ON balance_transactions(source_id);
CREATE INDEX IF NOT EXISTS idx_balance_tx_account_id ON balance_transactions(account_id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  request_idempotency_key TEXT,
  livemode INTEGER NOT NULL DEFAULT 0,
  api_version TEXT NOT NULL,
  created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created);
CREATE INDEX IF NOT EXISTS idx_events_account_id ON events(account_id);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  charge_id TEXT NOT NULL,
  payment_intent_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  idempotency_key TEXT,
  created INTEGER NOT NULL,
  FOREIGN KEY (charge_id) REFERENCES charges(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_refunds_charge ON refunds(charge_id);
CREATE INDEX IF NOT EXISTS idx_refunds_payment_intent ON refunds(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_refunds_created ON refunds(created);
CREATE INDEX IF NOT EXISTS idx_refunds_account_id ON refunds(account_id);
`;

// Delete order matters for foreign-key cascades: refunds → charges → PIs.
const STRIPE_TABLES = [
  "refunds",
  "events",
  "balance_transactions",
  "charges",
  "payment_intents",
];

/**
 * Ensure the Stripe domain tables exist. Idempotent. Call once per fresh DB
 * (test helpers, AGENT-A's `db.ts` migration, etc.).
 */
export function ensureStripeTables(db: TwinStripeDatabase) {
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(STRIPE_TABLES_SQL);
}

/** Drop-and-recreate Stripe-domain tables. Used by `/admin/reset`. */
export function resetStripeTables(db: TwinStripeDatabase) {
  for (const table of STRIPE_TABLES) {
    db.exec(`DELETE FROM ${table};`);
  }
}
