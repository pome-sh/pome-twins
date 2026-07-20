// SPDX-License-Identifier: Apache-2.0
import { openTwinDatabase } from "@pome-sh/sdk";
import type { GmailTwinDatabase } from "./types.js";

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS gmail_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mailboxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mailbox_counters (
  mailbox_id INTEGER PRIMARY KEY,
  message_counter INTEGER NOT NULL DEFAULT 0,
  thread_counter INTEGER NOT NULL DEFAULT 0,
  draft_counter INTEGER NOT NULL DEFAULT 0,
  label_counter INTEGER NOT NULL DEFAULT 0,
  attachment_counter INTEGER NOT NULL DEFAULT 0,
  history_counter INTEGER NOT NULL DEFAULT 0,
  filter_counter INTEGER NOT NULL DEFAULT 0,
  logical_clock INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS threads (
  mailbox_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, id),
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  mailbox_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  rfc_message_id TEXT NOT NULL,
  internal_date INTEGER NOT NULL,
  sent_at TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL,
  bcc_json TEXT NOT NULL,
  delivered_to TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  normalized_subject TEXT NOT NULL,
  snippet TEXT NOT NULL,
  text_body TEXT NOT NULL,
  html_body TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  size_estimate INTEGER NOT NULL,
  PRIMARY KEY (mailbox_id, id),
  UNIQUE (mailbox_id, rfc_message_id, id),
  FOREIGN KEY (mailbox_id, thread_id) REFERENCES threads(mailbox_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_blobs (
  mailbox_id INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  raw BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (mailbox_id, message_id),
  FOREIGN KEY (mailbox_id, message_id) REFERENCES messages(mailbox_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS drafts (
  mailbox_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, id),
  UNIQUE (mailbox_id, message_id),
  FOREIGN KEY (mailbox_id, message_id) REFERENCES messages(mailbox_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS labels (
  mailbox_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  type TEXT NOT NULL CHECK (type IN ('system', 'user')),
  text_color TEXT,
  background_color TEXT,
  PRIMARY KEY (mailbox_id, id),
  UNIQUE (mailbox_id, name),
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_labels (
  mailbox_id INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, message_id, label_id),
  FOREIGN KEY (mailbox_id, message_id) REFERENCES messages(mailbox_id, id) ON DELETE CASCADE,
  FOREIGN KEY (mailbox_id, label_id) REFERENCES labels(mailbox_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS attachments (
  mailbox_id INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  id TEXT NOT NULL,
  part_index INTEGER NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  disposition TEXT NOT NULL,
  content_id TEXT,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (mailbox_id, message_id, id),
  UNIQUE (mailbox_id, message_id, part_index),
  FOREIGN KEY (mailbox_id, message_id) REFERENCES messages(mailbox_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS history (
  mailbox_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  message_id TEXT,
  thread_id TEXT,
  event_type TEXT NOT NULL,
  label_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, id),
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS filters (
  mailbox_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  criteria_json TEXT NOT NULL,
  action_json TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, id),
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS forwarding_addresses (
  mailbox_id INTEGER NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  verification_status TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, email),
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS send_as (
  mailbox_id INTEGER NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  reply_to_address TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  verification_status TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, email),
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_mailbox_date
  ON messages(mailbox_id, internal_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox_thread_date
  ON messages(mailbox_id, thread_id, internal_date, id);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox_subject
  ON messages(mailbox_id, normalized_subject, internal_date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox_rfc
  ON messages(mailbox_id, rfc_message_id);
CREATE INDEX IF NOT EXISTS idx_message_labels_label_message
  ON message_labels(mailbox_id, label_id, message_id);
CREATE INDEX IF NOT EXISTS idx_drafts_mailbox_updated
  ON drafts(mailbox_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_history_mailbox_id
  ON history(mailbox_id, id, event_type);
CREATE INDEX IF NOT EXISTS idx_attachments_lookup
  ON attachments(mailbox_id, message_id, id);
CREATE INDEX IF NOT EXISTS idx_filters_mailbox
  ON filters(mailbox_id, id);
`;

const RESET_SQL = `
DELETE FROM gmail_config;
DELETE FROM send_as;
DELETE FROM forwarding_addresses;
DELETE FROM filters;
DELETE FROM history;
DELETE FROM attachments;
DELETE FROM message_labels;
DELETE FROM labels;
DELETE FROM drafts;
DELETE FROM message_blobs;
DELETE FROM messages;
DELETE FROM threads;
DELETE FROM mailbox_counters;
DELETE FROM mailboxes;
`;

export function openGmailTwinDatabase(path = process.env.GMAIL_TWIN_DB ?? ":memory:"): GmailTwinDatabase {
  return openTwinDatabase(path, { migrate });
}

export function migrate(db: GmailTwinDatabase): void {
  db.exec(MIGRATION_SQL);
}

export function resetDatabase(db: GmailTwinDatabase): void {
  db.exec(RESET_SQL);
}
