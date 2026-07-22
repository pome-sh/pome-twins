// SPDX-License-Identifier: Apache-2.0
import type {
  LinearOrganization,
  LinearTeam,
  LinearUser,
  LinearWorkflowState,
} from "../types.js";
import type { LinearDomain } from "./linear-domain.js";
import {
  mapOrg,
  mapState,
  mapTeam,
  mapUser,
  type OrgRow,
  type StateRow,
  type TeamRow,
  type UserRow,
} from "./rows.js";

export function getOrganization(domain: LinearDomain): LinearOrganization | null {
  const row = domain.db.prepare("SELECT * FROM organizations LIMIT 1").get() as OrgRow | undefined;
  return row ? mapOrg(row) : null;
}

export function listUsers(domain: LinearDomain): LinearUser[] {
  return (domain.db.prepare("SELECT * FROM users ORDER BY created_at, id").all() as UserRow[]).map(mapUser);
}

export function getUser(domain: LinearDomain, ref: string): LinearUser | null {
  const row = domain.db
    .prepare(
      `SELECT * FROM users WHERE id = ? OR email = ? COLLATE NOCASE OR name = ? OR display_name = ? LIMIT 1`
    )
    .get(ref, ref, ref, ref) as UserRow | undefined;
  return row ? mapUser(row) : null;
}

export function listTeams(domain: LinearDomain): LinearTeam[] {
  return (domain.db.prepare("SELECT * FROM teams ORDER BY key").all() as TeamRow[]).map(mapTeam);
}

export function getTeam(domain: LinearDomain, ref: string): LinearTeam | null {
  const row = domain.db
    .prepare(`SELECT * FROM teams WHERE id = ? OR key = ? OR name = ? LIMIT 1`)
    .get(ref, ref, ref) as TeamRow | undefined;
  return row ? mapTeam(row) : null;
}

export function listWorkflowStates(domain: LinearDomain, teamRef?: string): LinearWorkflowState[] {
  if (!teamRef) {
    return (
      domain.db.prepare("SELECT * FROM workflow_states ORDER BY position, name").all() as StateRow[]
    ).map(mapState);
  }
  const team = domain.getTeam(teamRef);
  if (!team) return [];
  return (
    domain.db
      .prepare("SELECT * FROM workflow_states WHERE team_id = ? ORDER BY position, name")
      .all(team.id) as StateRow[]
  ).map(mapState);
}

export function getWorkflowState(
  domain: LinearDomain,
  ref: string,
  teamRef?: string
): LinearWorkflowState | null {
  // When a team is given, stay scoped to it — never fall back to another
  // team's states (that would let an issue adopt a foreign workflow state).
  const states = domain.listWorkflowStates(teamRef);
  return states.find((s) => s.id === ref || s.name === ref || s.type === ref) ?? null;
}
