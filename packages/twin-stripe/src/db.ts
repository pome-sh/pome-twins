// SPDX-License-Identifier: Apache-2.0
//
// Stripe twin schema — DDL + reset only (domain). The sqlite driver and the
// pome pragma set live in the engine (`openTwinDatabase`, F-681); twins
// never import a sqlite driver directly.
//
// All tables are created up front so domain modules do not need to migrate.
// v1 ships with payment_intents, charges, balance_transactions, and events.
// The remaining tables (customers, payment_methods, refunds, products,
// prices, checkout_sessions, SPT, webhook_endpoints) are deferred to v2.
import { openTwinDatabase } from "@pome-sh/sdk";
import type { TwinStripeDatabase } from "./types.js";
import { ensureMigratedColumns, ensureStripeTables } from "./domain/schema.js";

const MIGRATION_SQL = `
-- ----- chassis tables -------------------------------------------------------

CREATE TABLE IF NOT EXISTS api_keys (
  key TEXT PRIMARY KEY,
  sid TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_sid ON api_keys(sid);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT NOT NULL,
  account_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, account_id, method, path)
);

-- ----- v1 Stripe domain tables ---------------------------------------------

CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  payment_method_types_json TEXT NOT NULL DEFAULT '[]',
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
  captured_at INTEGER,
  payment_method_id TEXT,
  customer_id TEXT,
  last_payment_error_json TEXT
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
  created INTEGER NOT NULL,
  currency TEXT NOT NULL,
  payment_method_id TEXT,
  payment_method_details_json TEXT,
  failure_code TEXT,
  failure_decline_code TEXT,
  failure_message TEXT,
  customer_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_charges_payment_intent ON charges(payment_intent_id);
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
  created INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_balance_transactions_created ON balance_transactions(created);
CREATE INDEX IF NOT EXISTS idx_balance_transactions_source ON balance_transactions(source_id);
CREATE INDEX IF NOT EXISTS idx_balance_transactions_account_id ON balance_transactions(account_id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  request_idempotency_key TEXT,
  livemode INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  api_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created);
CREATE INDEX IF NOT EXISTS idx_events_account_id ON events(account_id);

-- ----- audit log (writes through admin/seed/reset) ------------------------

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
`;

const RESET_SQL = `
DELETE FROM audit_log;
DELETE FROM refunds;
DELETE FROM events;
DELETE FROM balance_transactions;
DELETE FROM charges;
DELETE FROM payment_intents;
DELETE FROM payment_methods;
DELETE FROM customers;
DELETE FROM subscriptions;
DELETE FROM prices;
DELETE FROM products;
DELETE FROM idempotency_keys;
DELETE FROM api_keys;
`;

export function openTwinStripeDatabase(
  path = process.env.STRIPE_CLONE_DB ?? ":memory:"
): TwinStripeDatabase {
  return openTwinDatabase(path, { migrate });
}

export function migrate(db: TwinStripeDatabase) {
  db.exec(MIGRATION_SQL);
  // CREATE IF NOT EXISTS can't add columns to an older DB file; patch
  // them in place so external migrate() callers get the full schema.
  ensureMigratedColumns(db);
}

export function resetDatabase(db: TwinStripeDatabase) {
  // MIGRATION_SQL doesn't create every Stripe domain table (refunds,
  // customers, payment_methods, and the F-734 billing tables come from
  // ensureStripeTables via domain constructors / applySeed) — ensure them
  // so reset is safe on a db that hasn't constructed a domain yet.
  ensureStripeTables(db);
  db.exec(RESET_SQL);
}
