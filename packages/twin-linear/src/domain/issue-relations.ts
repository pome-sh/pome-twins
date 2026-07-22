// SPDX-License-Identifier: Apache-2.0
import { badUserInput } from "../errors.js";
import type { LinearIssueRelations } from "../types.js";
import type { LinearDomain } from "./linear-domain.js";

export type IssueRelationAppendInput = {
  blocks?: string[] | null;
  blockedBy?: string[] | null;
  relatedTo?: string[] | null;
};

/** Read append-only relation sets for an issue (identifiers preferred for agents). */
export function listIssueRelations(domain: LinearDomain, issueId: string): LinearIssueRelations {
  const rows = domain.db
    .prepare(
      `SELECT r.type AS type, i.identifier AS identifier
         FROM issue_relations r
         JOIN issues i ON i.id = r.related_issue_id
        WHERE r.issue_id = ?
        ORDER BY r.type, i.identifier`
    )
    .all(issueId) as Array<{ type: string; identifier: string }>;
  const out: LinearIssueRelations = { blocks: [], blockedBy: [], relatedTo: [] };
  for (const row of rows) {
    if (row.type === "blocks") out.blocks.push(row.identifier);
    else if (row.type === "blocked_by") out.blockedBy.push(row.identifier);
    else if (row.type === "related") out.relatedTo.push(row.identifier);
  }
  return out;
}

/** Append-only: existing relations are never removed (Linear MCP save_issue semantics). */
export function appendIssueRelations(
  domain: LinearDomain,
  issueId: string,
  input: IssueRelationAppendInput
): boolean {
  let changed = false;
  const insert = domain.db.prepare(
    `INSERT OR IGNORE INTO issue_relations(issue_id, related_issue_id, type) VALUES (?,?,?)`
  );
  const append = (refs: string[] | null | undefined, type: "blocks" | "blocked_by" | "related") => {
    if (!refs?.length) return;
    for (const ref of refs) {
      const related = domain.requireIssue(ref);
      if (related.id === issueId) continue;
      const result = insert.run(issueId, related.id, type);
      if (result.changes > 0) changed = true;
    }
  };
  append(input.blocks, "blocks");
  append(input.blockedBy, "blocked_by");
  append(input.relatedTo, "related");
  return changed;
}

/** Reject ancestry cycles when setting issue.parentId (A→B→A). */
export function assertNoParentCycle(domain: LinearDomain, issueId: string, parentId: string): void {
  if (parentId === issueId) badUserInput("Issue cannot be its own parent");
  let cursor: string | null = parentId;
  const seen = new Set<string>([issueId]);
  while (cursor) {
    if (seen.has(cursor)) badUserInput("Issue parent would create a cycle");
    seen.add(cursor);
    const row = domain.db
      .prepare("SELECT parent_id AS parentId FROM issues WHERE id = ?")
      .get(cursor) as { parentId: string | null } | undefined;
    cursor = row?.parentId ?? null;
  }
}
