// SPDX-License-Identifier: Apache-2.0
import type { GitHubTwinDatabase, SeedState } from "../types.js";

export type RepoRow = {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string;
  created_at: string;
  updated_at: string;
};

export type IssueRow = {
  repo_id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  assignee_login: string | null;
  created_at: string;
  updated_at: string;
};

export type LabelRow = {
  repo_id: number;
  name: string;
  color: string;
  description: string;
};

export type CommentRow = {
  id: number;
  repo_id: number;
  issue_number: number;
  body: string;
  user_login: string;
  created_at: string;
};

export function seedDatabase(db: GitHubTwinDatabase, seed: SeedState) {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.exec("DELETE FROM comments; DELETE FROM issue_labels; DELETE FROM issues; DELETE FROM collaborators; DELETE FROM labels; DELETE FROM repositories;");

    for (const repo of seed.repositories) {
      const fullName = `${repo.owner}/${repo.name}`;
      db.prepare(
        "INSERT INTO repositories (owner, name, full_name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(repo.owner, repo.name, fullName, repo.description ?? "", now, now);

      const repoRow = getRepo(db, repo.owner, repo.name);
      if (!repoRow) continue;

      for (const label of repo.labels ?? []) {
        createLabel(db, repoRow.id, label.name, label.color ?? "ededed", label.description ?? "");
      }

      for (const login of repo.collaborators ?? []) {
        db.prepare("INSERT OR IGNORE INTO collaborators (repo_id, login) VALUES (?, ?)").run(repoRow.id, login);
      }

      for (const issue of repo.issues ?? []) {
        db.prepare(
          "INSERT INTO issues (repo_id, number, title, body, state, assignee_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          repoRow.id,
          issue.number,
          issue.title,
          issue.body ?? "",
          issue.state ?? "open",
          issue.assignee ?? null,
          now,
          now
        );

        for (const labelName of issue.labels ?? []) {
          db.prepare("INSERT OR IGNORE INTO issue_labels (repo_id, issue_number, label_name) VALUES (?, ?, ?)").run(
            repoRow.id,
            issue.number,
            labelName
          );
        }
      }
    }
  });

  tx();
}

export function getRepo(db: GitHubTwinDatabase, owner: string, name: string): RepoRow | undefined {
  return db.prepare("SELECT * FROM repositories WHERE owner = ? AND name = ?").get(owner, name) as RepoRow | undefined;
}

export function listIssues(db: GitHubTwinDatabase, repoId: number): IssueRow[] {
  return db.prepare("SELECT * FROM issues WHERE repo_id = ? ORDER BY number ASC").all(repoId) as IssueRow[];
}

export function getIssue(db: GitHubTwinDatabase, repoId: number, number: number): IssueRow | undefined {
  return db.prepare("SELECT * FROM issues WHERE repo_id = ? AND number = ?").get(repoId, number) as IssueRow | undefined;
}

export function listLabels(db: GitHubTwinDatabase, repoId: number): LabelRow[] {
  return db.prepare("SELECT * FROM labels WHERE repo_id = ? ORDER BY name ASC").all(repoId) as LabelRow[];
}

export function getLabel(db: GitHubTwinDatabase, repoId: number, name: string): LabelRow | undefined {
  return db.prepare("SELECT * FROM labels WHERE repo_id = ? AND name = ?").get(repoId, name) as LabelRow | undefined;
}

export function createLabel(db: GitHubTwinDatabase, repoId: number, name: string, color: string, description: string) {
  db.prepare("INSERT INTO labels (repo_id, name, color, description) VALUES (?, ?, ?, ?)").run(
    repoId,
    name,
    color,
    description
  );
  return getLabel(db, repoId, name);
}

export function listIssueLabels(db: GitHubTwinDatabase, repoId: number, issueNumber: number): LabelRow[] {
  return db
    .prepare(
      "SELECT labels.* FROM labels INNER JOIN issue_labels ON labels.repo_id = issue_labels.repo_id AND labels.name = issue_labels.label_name WHERE issue_labels.repo_id = ? AND issue_labels.issue_number = ? ORDER BY labels.name ASC"
    )
    .all(repoId, issueNumber) as LabelRow[];
}

export function addIssueLabel(db: GitHubTwinDatabase, repoId: number, issueNumber: number, labelName: string) {
  db.prepare("INSERT OR IGNORE INTO issue_labels (repo_id, issue_number, label_name) VALUES (?, ?, ?)").run(
    repoId,
    issueNumber,
    labelName
  );
}

export function deleteIssueLabel(db: GitHubTwinDatabase, repoId: number, issueNumber: number, labelName: string) {
  return db
    .prepare("DELETE FROM issue_labels WHERE repo_id = ? AND issue_number = ? AND label_name = ?")
    .run(repoId, issueNumber, labelName).changes;
}

export function listCollaborators(db: GitHubTwinDatabase, repoId: number): string[] {
  const rows = db.prepare("SELECT login FROM collaborators WHERE repo_id = ? ORDER BY login ASC").all(repoId) as Array<{
    login: string;
  }>;
  return rows.map((row) => row.login);
}

export function hasCollaborator(db: GitHubTwinDatabase, repoId: number, login: string) {
  return Boolean(db.prepare("SELECT 1 FROM collaborators WHERE repo_id = ? AND login = ?").get(repoId, login));
}

export function updateIssue(
  db: GitHubTwinDatabase,
  repoId: number,
  issueNumber: number,
  patch: { title?: string; body?: string; state?: "open" | "closed"; assignee_login?: string | null }
) {
  const current = getIssue(db, repoId, issueNumber);
  if (!current) return undefined;

  db.prepare(
    "UPDATE issues SET title = ?, body = ?, state = ?, assignee_login = ?, updated_at = ? WHERE repo_id = ? AND number = ?"
  ).run(
    patch.title ?? current.title,
    patch.body ?? current.body,
    patch.state ?? current.state,
    Object.prototype.hasOwnProperty.call(patch, "assignee_login") ? patch.assignee_login ?? null : current.assignee_login,
    new Date().toISOString(),
    repoId,
    issueNumber
  );

  return getIssue(db, repoId, issueNumber);
}

export function createComment(db: GitHubTwinDatabase, repoId: number, issueNumber: number, body: string) {
  const createdAt = new Date().toISOString();
  const result = db
    .prepare("INSERT INTO comments (repo_id, issue_number, body, user_login, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(repoId, issueNumber, body, "pome-agent", createdAt);
  return db.prepare("SELECT * FROM comments WHERE id = ?").get(result.lastInsertRowid) as CommentRow;
}

export function exportState(db: GitHubTwinDatabase) {
  const repos = db.prepare("SELECT * FROM repositories ORDER BY full_name ASC").all() as RepoRow[];
  return {
    repositories: repos.map((repo) => ({
      ...repo,
      labels: listLabels(db, repo.id),
      collaborators: listCollaborators(db, repo.id),
      issues: listIssues(db, repo.id).map((issue) => ({
        ...issue,
        labels: listIssueLabels(db, repo.id, issue.number)
      }))
    }))
  };
}
