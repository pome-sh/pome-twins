// SPDX-License-Identifier: Apache-2.0
//
// Slack twin schema — DDL + reset only (domain). The sqlite driver and the
// pome pragma set live in the engine (`openTwinDatabase`, F-681); twins
// never import a sqlite driver directly.
import { openTwinDatabase } from "@pome-sh/sdk";
import type { SlackTwinDatabase } from "./types.js";

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  url TEXT NOT NULL,
  enterprise_id TEXT,
  created_at TEXT NOT NULL,
  entity_counter INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  real_name TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  email TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  tz TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  profile_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx
  ON users(team_id, email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  is_channel INTEGER NOT NULL DEFAULT 1,
  is_group INTEGER NOT NULL DEFAULT 0,
  is_im INTEGER NOT NULL DEFAULT 0,
  is_mpim INTEGER NOT NULL DEFAULT 0,
  is_private INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  topic TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  creator TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ts_counter INTEGER NOT NULL DEFAULT 0,
  dm_signature TEXT,
  FOREIGN KEY (team_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS channels_name_idx
  ON channels(team_id, name) WHERE name <> '';

-- Deterministic DM / MPIM dedup: dm_signature is the sorted member-id list
-- joined with a pipe character. NULL on public channels and private groups.
CREATE UNIQUE INDEX IF NOT EXISTS channels_dm_signature_idx
  ON channels(team_id, dm_signature) WHERE dm_signature IS NOT NULL;

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  last_read TEXT NOT NULL DEFAULT '0000000000.000000',
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  channel_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  subtype TEXT,
  thread_ts TEXT,
  reply_count INTEGER NOT NULL DEFAULT 0,
  reply_users_count INTEGER NOT NULL DEFAULT 0,
  latest_reply TEXT,
  edited_user_id TEXT,
  edited_ts TEXT,
  blocks_json TEXT NOT NULL DEFAULT '[]',
  attachments_json TEXT NOT NULL DEFAULT '[]',
  bot_id TEXT,
  app_id TEXT,
  username TEXT,
  icon_url TEXT,
  icon_emoji TEXT,
  PRIMARY KEY (channel_id, ts),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS messages_history_idx ON messages(channel_id, ts DESC);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages(channel_id, thread_ts, ts);

CREATE TABLE IF NOT EXISTS reactions (
  channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, message_ts, name, user_id),
  FOREIGN KEY (channel_id, message_ts) REFERENCES messages(channel_id, ts) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS reactions_by_msg_idx ON reactions(channel_id, message_ts);

CREATE TABLE IF NOT EXISTS pins (
  channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  pinned_by TEXT NOT NULL,
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, message_ts),
  FOREIGN KEY (channel_id, message_ts) REFERENCES messages(channel_id, ts) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  mimetype TEXT NOT NULL DEFAULT 'text/plain',
  filetype TEXT NOT NULL DEFAULT 'text',
  size INTEGER NOT NULL DEFAULT 0,
  url_private TEXT NOT NULL DEFAULT '',
  channels_json TEXT NOT NULL DEFAULT '[]',
  deleted INTEGER NOT NULL DEFAULT 0,
  content TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  emoji TEXT,
  type TEXT NOT NULL DEFAULT 'link',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  thread_ts TEXT,
  post_at INTEGER NOT NULL,
  date_created INTEGER NOT NULL,
  blocks_json TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS canvases (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  markdown TEXT NOT NULL DEFAULT '',
  channel_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS emoji (
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (team_id, name),
  FOREIGN KEY (team_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS messages_text_idx ON messages(text);
`;

const RESET_SQL = `
DELETE FROM emoji;
DELETE FROM canvases;
DELETE FROM scheduled_messages;
DELETE FROM bookmarks;
DELETE FROM files;
DELETE FROM pins;
DELETE FROM reactions;
DELETE FROM messages;
DELETE FROM channel_members;
DELETE FROM channels;
DELETE FROM users;
DELETE FROM workspaces;
`;

export function openSlackTwinDatabase(path = process.env.SLACK_CLONE_DB ?? ":memory:"): SlackTwinDatabase {
  return openTwinDatabase(path, { migrate });
}

export function migrate(db: SlackTwinDatabase) {
  db.exec(MIGRATION_SQL);
  // Append-only column additions for forward-compat (e.g. future fields).
  ensureColumn(db, "workspaces", "entity_counter", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "workspaces", "ts_counter", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "channels", "ts_counter", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "channels", "dm_signature", "TEXT");
  // Backfill workspace.ts_counter from per-channel max so any in-flight
  // snapshot stays monotonic after the per-workspace switch.
  db.exec(
    `UPDATE workspaces SET ts_counter = COALESCE(
       (SELECT MAX(ts_counter) FROM channels WHERE team_id = workspaces.id),
       ts_counter
     ) WHERE ts_counter = 0`
  );
  ensureColumn(db, "messages", "bot_id", "TEXT");
  ensureColumn(db, "messages", "app_id", "TEXT");
  ensureColumn(db, "messages", "username", "TEXT");
  ensureColumn(db, "messages", "icon_url", "TEXT");
  ensureColumn(db, "messages", "icon_emoji", "TEXT");
}

export function resetDatabase(db: SlackTwinDatabase) {
  db.exec(RESET_SQL);
}

function ensureColumn(db: SlackTwinDatabase, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
