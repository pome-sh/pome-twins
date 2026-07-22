// SPDX-License-Identifier: Apache-2.0
import type { LinearCycle, LinearProject, LinearProjectState } from "../types.js";
import type { ActorContext, LinearDomain } from "./linear-domain.js";
import { mapCycle, mapProject, type CycleRow, type ProjectRow } from "./rows.js";

export function listProjects(domain: LinearDomain, teamRef?: string): LinearProject[] {
  const rows = (domain.db.prepare("SELECT * FROM projects ORDER BY created_at, id").all() as ProjectRow[]).map(
    mapProject
  );
  if (!teamRef) return rows;
  const team = domain.getTeam(teamRef);
  if (!team) return [];
  return rows.filter((p) => p.teamId === team.id || p.teamId === null);
}

export function getProject(domain: LinearDomain, ref: string): LinearProject | null {
  return domain.listProjects().find((p) => p.id === ref || p.name === ref) ?? null;
}

export function createProject(
  domain: LinearDomain,
  input: {
    name: string;
    teamId?: string | null;
    description?: string | null;
    state?: LinearProjectState;
  },
  actor: ActorContext = {}
): LinearProject {
  domain.requireScopes(actor, ["write"]);
  const team = input.teamId ? domain.requireTeam(input.teamId) : null;
  const now = domain.tick();
  const id = domain.nextId("project");
  domain.db
    .prepare(
      `INSERT INTO projects(id, team_id, name, description, state, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`
    )
    .run(id, team?.id ?? null, input.name, input.description ?? null, input.state ?? "planned", now, now);
  return domain.requireProject(id);
}

export function updateProject(
  domain: LinearDomain,
  id: string,
  input: { name?: string; description?: string | null; state?: LinearProjectState },
  actor: ActorContext = {}
): LinearProject {
  domain.requireScopes(actor, ["write"]);
  const project = domain.requireProject(id);
  const now = domain.tick();
  domain.db
    .prepare(
      `UPDATE projects SET
          name = COALESCE(?, name),
          description = CASE WHEN ? THEN ? ELSE description END,
          state = COALESCE(?, state),
          updated_at = ?
         WHERE id = ?`
    )
    .run(
      input.name ?? null,
      "description" in input ? 1 : 0,
      input.description ?? null,
      input.state ?? null,
      now,
      project.id
    );
  return domain.requireProject(project.id);
}

export function listCycles(domain: LinearDomain, teamRef: string): LinearCycle[] {
  const team = domain.requireTeam(teamRef);
  return (
    domain.db
      .prepare("SELECT * FROM cycles WHERE team_id = ? ORDER BY number, created_at")
      .all(team.id) as CycleRow[]
  ).map(mapCycle);
}

export function getCycle(domain: LinearDomain, ref: string, teamRef?: string): LinearCycle | null {
  const cycles = teamRef
    ? domain.listCycles(teamRef)
    : (domain.db.prepare("SELECT * FROM cycles").all() as CycleRow[]).map(mapCycle);
  return cycles.find((c) => c.id === ref || c.name === ref || String(c.number) === ref) ?? null;
}
