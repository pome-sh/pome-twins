// SPDX-License-Identifier: Apache-2.0
import type { GitHubTwinDatabase } from "../types.js";

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS labels (
  repo_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (repo_id, name),
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS collaborators (
  repo_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  PRIMARY KEY (repo_id, login),
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issues (
  repo_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  assignee_login TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, number),
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (repo_id, assignee_login) REFERENCES collaborators(repo_id, login)
);

CREATE TABLE IF NOT EXISTS issue_labels (
  repo_id INTEGER NOT NULL,
  issue_number INTEGER NOT NULL,
  label_name TEXT NOT NULL,
  PRIMARY KEY (repo_id, issue_number, label_name),
  FOREIGN KEY (repo_id, issue_number) REFERENCES issues(repo_id, number) ON DELETE CASCADE,
  FOREIGN KEY (repo_id, label_name) REFERENCES labels(repo_id, name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  issue_number INTEGER NOT NULL,
  body TEXT NOT NULL,
  user_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (repo_id, issue_number) REFERENCES issues(repo_id, number) ON DELETE CASCADE
);
`;

export function migrate(db: GitHubTwinDatabase) {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(MIGRATION_SQL);
}
