// SPDX-License-Identifier: Apache-2.0
import { openTwinDatabase } from "@pome-sh/sdk";
import type { LinearTwinDatabase } from "./types.js";

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS linear_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url_key TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  admin INTEGER NOT NULL DEFAULT 0,
  app INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  url TEXT NOT NULL,
  issue_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_states (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issue_labels (
  id TEXT PRIMARY KEY,
  team_id TEXT,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  team_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS cycles (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  number INTEGER NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  number INTEGER NOT NULL,
  team_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  state_id TEXT NOT NULL,
  assignee_id TEXT,
  creator_id TEXT,
  delegate_id TEXT,
  project_id TEXT,
  cycle_id TEXT,
  url TEXT NOT NULL,
  archived_at TEXT,
  canceled_at TEXT,
  completed_at TEXT,
  started_at TEXT,
  due_date TEXT,
  create_as_user TEXT,
  display_icon_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (state_id) REFERENCES workflow_states(id),
  FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (delegate_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS issue_label_links (
  issue_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (issue_id, label_id),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (label_id) REFERENCES issue_labels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  user_id TEXT,
  body TEXT NOT NULL,
  create_as_user TEXT,
  display_icon_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS oauth_apps (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  client_secret TEXT NOT NULL,
  name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  assignable INTEGER NOT NULL DEFAULT 0,
  mentionable INTEGER NOT NULL DEFAULT 0,
  app_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (app_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  user_id TEXT,
  app_id TEXT,
  scopes_json TEXT NOT NULL,
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  refresh_token TEXT,
  sid TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (app_id) REFERENCES oauth_apps(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  resource_types_json TEXT NOT NULL,
  team_id TEXT,
  all_public_teams INTEGER NOT NULL DEFAULT 0,
  secret TEXT,
  creator_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL,
  FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  event TEXT NOT NULL,
  action TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER,
  error TEXT,
  payload_json TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  issue_id TEXT,
  comment_id TEXT,
  agent_user_id TEXT NOT NULL,
  state TEXT NOT NULL,
  plan TEXT,
  external_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_activities (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  ephemeral INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS oauth_pending_codes (
  code TEXT PRIMARY KEY,
  app_id TEXT,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  user_id TEXT,
  actor TEXT NOT NULL,
  code_challenge TEXT,
  code_challenge_method TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_key ON teams(key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_identifier ON issues(identifier);
CREATE INDEX IF NOT EXISTS idx_issues_team_number ON issues(team_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_token ON tokens(token);
CREATE INDEX IF NOT EXISTS idx_workflow_states_team_name ON workflow_states(team_id, name);
CREATE INDEX IF NOT EXISTS idx_comments_issue_id ON comments(issue_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created ON webhook_deliveries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_activities_created ON agent_activities(created_at DESC);
`;

const RESET_SQL = `
DELETE FROM oauth_pending_codes;
DELETE FROM agent_activities;
DELETE FROM agent_sessions;
DELETE FROM webhook_deliveries;
DELETE FROM webhooks;
DELETE FROM tokens;
DELETE FROM oauth_apps;
DELETE FROM comments;
DELETE FROM issue_label_links;
DELETE FROM issues;
DELETE FROM cycles;
DELETE FROM projects;
DELETE FROM issue_labels;
DELETE FROM workflow_states;
DELETE FROM teams;
DELETE FROM users;
DELETE FROM organizations;
DELETE FROM linear_config;
`;

export function openLinearTwinDatabase(
  path = process.env.LINEAR_TWIN_DB ?? ":memory:"
): LinearTwinDatabase {
  return openTwinDatabase(path, { migrate });
}

export function migrate(db: LinearTwinDatabase): void {
  db.exec(MIGRATION_SQL);
}

export function resetDatabase(db: LinearTwinDatabase): void {
  db.exec(RESET_SQL);
}
