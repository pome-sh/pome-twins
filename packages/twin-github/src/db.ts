// SPDX-License-Identifier: Apache-2.0
//
// GitHub twin schema — DDL + reset only (domain). The sqlite driver and the
// pome pragma set live in the engine (`openTwinDatabase`, F-681); twins
// never import a sqlite driver directly.
import { openTwinDatabase } from "@pome-sh/sdk";
import type { GitHubCloneDatabase } from "./types.js";

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS users (
  login TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'User',
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  private INTEGER NOT NULL DEFAULT 0,
  default_branch TEXT NOT NULL DEFAULT 'main',
  fork INTEGER NOT NULL DEFAULT 0,
  parent_full_name TEXT,
  entity_counter INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collaborators (
  repo_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'push',
  PRIMARY KEY (repo_id, login),
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  head_sha TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, name),
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS commits (
  sha TEXT PRIMARY KEY,
  repo_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  author_login TEXT NOT NULL,
  committer_login TEXT NOT NULL,
  parent_sha TEXT,
  tree_sha TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS files (
  repo_id INTEGER NOT NULL,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  sha TEXT NOT NULL,
  size INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, branch, path),
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS file_versions (
  commit_sha TEXT NOT NULL,
  repo_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  sha TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (commit_sha, path),
  FOREIGN KEY (commit_sha) REFERENCES commits(sha) ON DELETE CASCADE,
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS labels (
  repo_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (repo_id, name),
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS milestones (
  repo_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  description TEXT NOT NULL DEFAULT '',
  due_on TEXT,
  creator_login TEXT NOT NULL DEFAULT 'pome-agent',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  closed_at TEXT,
  PRIMARY KEY (repo_id, number),
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
  repo_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, name),
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  tag_name TEXT NOT NULL,
  target_commitish TEXT NOT NULL DEFAULT 'main',
  name TEXT,
  body TEXT NOT NULL DEFAULT '',
  draft INTEGER NOT NULL DEFAULT 0,
  prerelease INTEGER NOT NULL DEFAULT 0,
  author_login TEXT NOT NULL DEFAULT 'pome-agent',
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (repo_id, tag_name),
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS check_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  conclusion TEXT,
  details_url TEXT NOT NULL DEFAULT '',
  external_id TEXT NOT NULL DEFAULT '',
  output_title TEXT,
  output_summary TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issues (
  repo_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open',
  user_login TEXT NOT NULL DEFAULT 'pome-agent',
  assignee_login TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (repo_id, number),
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issue_assignees (
  repo_id INTEGER NOT NULL,
  issue_number INTEGER NOT NULL,
  login TEXT NOT NULL,
  PRIMARY KEY (repo_id, issue_number, login),
  FOREIGN KEY (repo_id, issue_number) REFERENCES issues(repo_id, number) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issue_labels (
  repo_id INTEGER NOT NULL,
  issue_number INTEGER NOT NULL,
  label_name TEXT NOT NULL,
  PRIMARY KEY (repo_id, issue_number, label_name),
  FOREIGN KEY (repo_id, issue_number) REFERENCES issues(repo_id, number) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (repo_id, label_name) REFERENCES labels(repo_id, name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issue_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  issue_number INTEGER NOT NULL,
  body TEXT NOT NULL,
  user_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (repo_id, issue_number) REFERENCES issues(repo_id, number) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pull_requests (
  repo_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open',
  user_login TEXT NOT NULL DEFAULT 'pome-agent',
  head_repo_id INTEGER NOT NULL,
  head_ref TEXT NOT NULL,
  head_sha TEXT,
  base_repo_id INTEGER NOT NULL,
  base_ref TEXT NOT NULL,
  base_sha TEXT,
  merged INTEGER NOT NULL DEFAULT 0,
  merge_commit_sha TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  merged_at TEXT,
  PRIMARY KEY (repo_id, number),
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (head_repo_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (base_repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pull_request_files (
  repo_id INTEGER NOT NULL,
  pull_number INTEGER NOT NULL,
  filename TEXT NOT NULL,
  status TEXT NOT NULL,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  changes INTEGER NOT NULL DEFAULT 0,
  blob_url TEXT NOT NULL DEFAULT '',
  raw_url TEXT NOT NULL DEFAULT '',
  contents_url TEXT NOT NULL DEFAULT '',
  patch TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (repo_id, pull_number, filename),
  FOREIGN KEY (repo_id, pull_number) REFERENCES pull_requests(repo_id, number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pull_request_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  pull_number INTEGER NOT NULL,
  user_login TEXT NOT NULL,
  state TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  commit_sha TEXT,
  submitted_at TEXT NOT NULL,
  FOREIGN KEY (repo_id, pull_number) REFERENCES pull_requests(repo_id, number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pull_request_review_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  pull_number INTEGER NOT NULL,
  path TEXT NOT NULL,
  body TEXT NOT NULL,
  user_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (repo_id, pull_number) REFERENCES pull_requests(repo_id, number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS commit_statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  sha TEXT NOT NULL,
  state TEXT NOT NULL,
  context TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  target_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  action TEXT NOT NULL,
  repo_full_name TEXT,
  payload_json TEXT NOT NULL
);
`;

const RESET_SQL = `
DELETE FROM audit_log;
DELETE FROM check_runs;
DELETE FROM commit_statuses;
DELETE FROM pull_request_review_comments;
DELETE FROM pull_request_reviews;
DELETE FROM pull_request_files;
DELETE FROM pull_requests;
DELETE FROM releases;
DELETE FROM tags;
DELETE FROM issue_comments;
DELETE FROM issue_labels;
DELETE FROM issue_assignees;
DELETE FROM issues;
DELETE FROM milestones;
DELETE FROM labels;
DELETE FROM file_versions;
DELETE FROM files;
DELETE FROM commits;
DELETE FROM branches;
DELETE FROM collaborators;
DELETE FROM repositories;
DELETE FROM users;
`;

export function openGitHubCloneDatabase(path = process.env.GITHUB_CLONE_DB ?? ":memory:"): GitHubCloneDatabase {
  return openTwinDatabase(path, { migrate });
}

export function migrate(db: GitHubCloneDatabase) {
  db.exec(MIGRATION_SQL);
  ensureColumn(db, "repositories", "entity_counter", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "pull_requests", "head_sha", "TEXT");
  ensureColumn(db, "pull_requests", "base_sha", "TEXT");
  ensureColumn(db, "milestones", "description", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "milestones", "due_on", "TEXT");
  ensureColumn(db, "milestones", "creator_login", "TEXT NOT NULL DEFAULT 'pome-agent'");
  ensureColumn(db, "milestones", "created_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "milestones", "updated_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "milestones", "closed_at", "TEXT");
  ensureColumn(db, "pull_request_review_comments", "line", "INTEGER");
  ensureColumn(db, "pull_request_review_comments", "side", "TEXT");
  ensureColumn(db, "pull_request_review_comments", "commit_sha", "TEXT");
  ensureColumn(db, "pull_request_review_comments", "in_reply_to_id", "INTEGER");
  ensureColumn(db, "collaborators", "invitation_state", "TEXT NOT NULL DEFAULT 'accepted'");
  ensureIssueNumberCascade(db);
  hydrateDerivedColumns(db);
}

export function resetDatabase(db: GitHubCloneDatabase) {
  db.exec(RESET_SQL);
}

function ensureColumn(db: GitHubCloneDatabase, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureIssueNumberCascade(db: GitHubCloneDatabase) {
  const tables = ["issue_assignees", "issue_labels", "issue_comments"];
  const needsRebuild = tables.some((table) => {
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string; on_update: string }>;
    return foreignKeys.some((key) => key.table === "issues" && key.on_update !== "CASCADE");
  });
  if (!needsRebuild) return;

  db.pragma("foreign_keys = OFF");
  db.exec(`
ALTER TABLE issue_assignees RENAME TO issue_assignees_old;
CREATE TABLE issue_assignees (
  repo_id INTEGER NOT NULL,
  issue_number INTEGER NOT NULL,
  login TEXT NOT NULL,
  PRIMARY KEY (repo_id, issue_number, login),
  FOREIGN KEY (repo_id, issue_number) REFERENCES issues(repo_id, number) ON UPDATE CASCADE ON DELETE CASCADE
);
INSERT INTO issue_assignees (repo_id, issue_number, login)
  SELECT repo_id, issue_number, login FROM issue_assignees_old;
DROP TABLE issue_assignees_old;

ALTER TABLE issue_labels RENAME TO issue_labels_old;
CREATE TABLE issue_labels (
  repo_id INTEGER NOT NULL,
  issue_number INTEGER NOT NULL,
  label_name TEXT NOT NULL,
  PRIMARY KEY (repo_id, issue_number, label_name),
  FOREIGN KEY (repo_id, issue_number) REFERENCES issues(repo_id, number) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (repo_id, label_name) REFERENCES labels(repo_id, name) ON DELETE CASCADE
);
INSERT INTO issue_labels (repo_id, issue_number, label_name)
  SELECT repo_id, issue_number, label_name FROM issue_labels_old;
DROP TABLE issue_labels_old;

ALTER TABLE issue_comments RENAME TO issue_comments_old;
CREATE TABLE issue_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  issue_number INTEGER NOT NULL,
  body TEXT NOT NULL,
  user_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (repo_id, issue_number) REFERENCES issues(repo_id, number) ON UPDATE CASCADE ON DELETE CASCADE
);
INSERT INTO issue_comments (id, repo_id, issue_number, body, user_login, created_at, updated_at)
  SELECT id, repo_id, issue_number, body, user_login, created_at, updated_at FROM issue_comments_old;
DROP TABLE issue_comments_old;
`);
  db.pragma("foreign_keys = ON");
}

function hydrateDerivedColumns(db: GitHubCloneDatabase) {
  db.exec(`
UPDATE repositories
SET entity_counter = MAX(
  entity_counter,
  COALESCE((SELECT MAX(number) FROM issues WHERE issues.repo_id = repositories.id), 0),
  COALESCE((SELECT MAX(number) FROM pull_requests WHERE pull_requests.repo_id = repositories.id), 0)
);

UPDATE pull_requests
SET
  head_sha = COALESCE(head_sha, (SELECT head_sha FROM branches WHERE branches.repo_id = pull_requests.head_repo_id AND branches.name = pull_requests.head_ref)),
  base_sha = COALESCE(base_sha, (SELECT head_sha FROM branches WHERE branches.repo_id = pull_requests.base_repo_id AND branches.name = pull_requests.base_ref));
`);
}
