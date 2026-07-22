// SPDX-License-Identifier: Apache-2.0
import { badUserInput } from "../errors.js";
import { slugify } from "../ids.js";
import type { LinearDocument } from "../types.js";
import { assertBody, assertTitle } from "./normalize.js";
import type { ActorContext, LinearDomain } from "./linear-domain.js";
import { mapDocument, type DocumentRow } from "./rows.js";

export type DocumentCreateInput = {
  title: string;
  content?: string | null;
  project?: string | null;
  team?: string | null;
  issue?: string | null;
  cycle?: string | null;
  icon?: string | null;
  color?: string | null;
};

export type DocumentUpdateInput = {
  title?: string;
  content?: string | null;
  project?: string | null;
  team?: string | null;
  issue?: string | null;
  cycle?: string | null;
  icon?: string | null;
  color?: string | null;
};

export type DocumentListFilter = {
  projectId?: string;
  teamId?: string;
  query?: string;
};

export function listDocuments(domain: LinearDomain, filter: DocumentListFilter = {}): LinearDocument[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.projectId) {
    const project = domain.getProject(filter.projectId);
    if (!project) return [];
    where.push("project_id = ?");
    params.push(project.id);
  }
  if (filter.teamId) {
    const team = domain.getTeam(filter.teamId);
    if (!team) return [];
    where.push("team_id = ?");
    params.push(team.id);
  }
  if (filter.query) {
    const q = `%${filter.query.toLowerCase()}%`;
    where.push("(LOWER(title) LIKE ? OR LOWER(COALESCE(content, '')) LIKE ?)");
    params.push(q, q);
  }
  const sql =
    where.length === 0
      ? "SELECT * FROM documents ORDER BY created_at, id"
      : `SELECT * FROM documents WHERE ${where.join(" AND ")} ORDER BY created_at, id`;
  return (domain.db.prepare(sql).all(...params) as DocumentRow[]).map(mapDocument);
}

export function getDocument(domain: LinearDomain, ref: string): LinearDocument | null {
  const row = domain.db
    .prepare("SELECT * FROM documents WHERE id = ? OR slug = ? LIMIT 1")
    .get(ref, ref) as DocumentRow | undefined;
  return row ? mapDocument(row) : null;
}

export function createDocument(
  domain: LinearDomain,
  input: DocumentCreateInput,
  actor: ActorContext = {}
): LinearDocument {
  domain.requireScopes(actor, ["write"]);
  assertTitle(input.title);
  if (input.content != null) assertBody(input.content);
  const parents = resolveParents(domain, input);
  if (parents.count !== 1) {
    badUserInput("Exactly one parent (project, team, issue, or cycle) is required when creating a document");
  }
  const viewer = domain.resolveViewer(actor);
  const now = domain.tick();
  const id = domain.nextId("document");
  const slug = uniqueSlug(domain, input.title, id);
  domain.db
    .prepare(
      `INSERT INTO documents(
          id, title, content, slug, project_id, team_id, issue_id, cycle_id,
          icon, color, creator_id, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      input.title,
      input.content ?? null,
      slug,
      parents.projectId,
      parents.teamId,
      parents.issueId,
      parents.cycleId,
      input.icon ?? null,
      input.color ?? null,
      viewer.id,
      now,
      now
    );
  return domain.requireDocument(id);
}

export function updateDocument(
  domain: LinearDomain,
  id: string,
  input: DocumentUpdateInput,
  actor: ActorContext = {}
): LinearDocument {
  domain.requireScopes(actor, ["write"]);
  const doc = domain.requireDocument(id);
  if ("title" in input && input.title !== undefined) assertTitle(input.title);
  if ("content" in input && input.content != null) assertBody(input.content);
  const parents =
    "project" in input || "team" in input || "issue" in input || "cycle" in input
      ? resolveParents(domain, {
          project: "project" in input ? input.project : undefined,
          team: "team" in input ? input.team : undefined,
          issue: "issue" in input ? input.issue : undefined,
          cycle: "cycle" in input ? input.cycle : undefined,
        })
      : null;
  if (parents && parents.count !== 1) {
    badUserInput("When reparenting, exactly one parent (project, team, issue, or cycle) is required");
  }
  const now = domain.tick();
  domain.db
    .prepare(
      `UPDATE documents SET
          title = COALESCE(?, title),
          content = CASE WHEN ? THEN ? ELSE content END,
          project_id = CASE WHEN ? THEN ? ELSE project_id END,
          team_id = CASE WHEN ? THEN ? ELSE team_id END,
          issue_id = CASE WHEN ? THEN ? ELSE issue_id END,
          cycle_id = CASE WHEN ? THEN ? ELSE cycle_id END,
          icon = CASE WHEN ? THEN ? ELSE icon END,
          color = CASE WHEN ? THEN ? ELSE color END,
          updated_at = ?
         WHERE id = ?`
    )
    .run(
      input.title ?? null,
      "content" in input ? 1 : 0,
      input.content ?? null,
      parents ? 1 : 0,
      parents?.projectId ?? null,
      parents ? 1 : 0,
      parents?.teamId ?? null,
      parents ? 1 : 0,
      parents?.issueId ?? null,
      parents ? 1 : 0,
      parents?.cycleId ?? null,
      "icon" in input ? 1 : 0,
      input.icon ?? null,
      "color" in input ? 1 : 0,
      input.color ?? null,
      now,
      doc.id
    );
  return domain.requireDocument(doc.id);
}

function resolveParents(
  domain: LinearDomain,
  input: {
    project?: string | null;
    team?: string | null;
    issue?: string | null;
    cycle?: string | null;
  }
): {
  count: number;
  projectId: string | null;
  teamId: string | null;
  issueId: string | null;
  cycleId: string | null;
} {
  const projectId = input.project ? domain.requireProject(input.project).id : null;
  const teamId = input.team ? domain.requireTeam(input.team).id : null;
  const issueId = input.issue ? domain.requireIssue(input.issue).id : null;
  let cycleId: string | null = null;
  if (input.cycle) {
    cycleId = domain.requireCycle(input.cycle, input.team ?? undefined).id;
  }
  const count = [projectId, teamId, issueId, cycleId].filter(Boolean).length;
  return { count, projectId, teamId, issueId, cycleId };
}

function uniqueSlug(domain: LinearDomain, title: string, id: string): string {
  const base = slugify(title) || "document";
  const candidate = `${base}-${id.slice(-6)}`;
  const existing = domain.db.prepare("SELECT 1 FROM documents WHERE slug = ?").get(candidate);
  if (!existing) return candidate;
  return `${base}-${id}`;
}
