// SPDX-License-Identifier: Apache-2.0
import type { LinearDomain } from "../domain/index.js";
import type { LinearIssue, LinearIssueLabel, LinearUser } from "../types.js";

export function filterUsers(users: LinearUser[], filter?: Record<string, unknown>): LinearUser[] {
  if (!filter) return users;
  return users.filter((user) => {
    if (typeof filter.active === "boolean" && user.active !== filter.active) return false;
    if (typeof filter.admin === "boolean" && user.admin !== filter.admin) return false;
    if (!matchStringComparator(user.id, filter.id)) return false;
    if (!matchStringComparator(user.email, filter.email)) return false;
    if (!matchStringComparator(user.name, filter.name)) return false;
    return true;
  });
}

export function filterIssues(commands: LinearDomain, filter?: Record<string, unknown>): LinearIssue[] {
  // Match team.issues and Linear's default: archived issues are hidden unless asked for.
  const issues = commands.listIssues({ includeArchived: false });
  if (!filter) return issues;
  return issues.filter((issue) => issueMatches(commands, issue, filter));
}

function issueMatches(
  commands: LinearDomain,
  issue: LinearIssue,
  filter: Record<string, unknown>
): boolean {
  // `or` groups AND with any sibling fields and recurse, matching Linear semantics.
  if (Array.isArray(filter.or)) {
    const matched = (filter.or as Record<string, unknown>[]).some((part) =>
      issueMatches(commands, issue, part)
    );
    if (!matched) return false;
  }
  if (!matchStringComparator(issue.id, filter.id)) return false;
  if (!matchStringComparator(issue.identifier, filter.identifier)) return false;
  if (!matchStringComparator(issue.title, filter.title)) return false;
  if (filter.team) {
    const team = commands.getTeam(issue.teamId);
    if (!matchStringComparator(team?.key ?? "", filter.team) && !matchStringComparator(issue.teamId, filter.team)) {
      return false;
    }
  }
  if (filter.state) {
    const state = commands.getWorkflowState(issue.stateId);
    if (!matchStringComparator(state?.name ?? "", filter.state) && !matchStringComparator(issue.stateId, filter.state)) {
      return false;
    }
  }
  if (filter.assignee) {
    const user = issue.assigneeId ? commands.getUser(issue.assigneeId) : null;
    if (
      !matchStringComparator(user?.email ?? "", filter.assignee) &&
      !matchStringComparator(issue.assigneeId ?? "", filter.assignee)
    ) {
      return false;
    }
  }
  if (filter.creator) {
    const user = issue.creatorId ? commands.getUser(issue.creatorId) : null;
    if (
      !matchStringComparator(user?.email ?? "", filter.creator) &&
      !matchStringComparator(issue.creatorId ?? "", filter.creator)
    ) {
      return false;
    }
  }
  if (filter.project) {
    const project = issue.projectId ? commands.getProject(issue.projectId) : null;
    if (
      !matchStringComparator(project?.name ?? "", filter.project) &&
      !matchStringComparator(issue.projectId ?? "", filter.project)
    ) {
      return false;
    }
  }
  if (filter.cycle) {
    const cycle = issue.cycleId ? commands.getCycle(issue.cycleId) : null;
    if (
      !matchStringComparator(cycle?.name ?? "", filter.cycle) &&
      !matchStringComparator(cycle ? String(cycle.number) : "", filter.cycle) &&
      !matchStringComparator(issue.cycleId ?? "", filter.cycle)
    ) {
      return false;
    }
  }
  if (filter.labels) {
    // Match when any label on the issue satisfies the comparator (by name or id).
    const labels = issue.labelIds
      .map((id) => commands.getLabel(id))
      .filter(Boolean) as LinearIssueLabel[];
    const anyMatch = labels.some(
      (label) =>
        matchStringComparator(label.name, filter.labels) || matchStringComparator(label.id, filter.labels)
    );
    if (!anyMatch) return false;
  }
  return true;
}

export function matchStringComparator(value: string, comparator: unknown): boolean {
  if (comparator == null) return true;
  if (typeof comparator === "string") return value === comparator;
  if (typeof comparator !== "object") return true;
  const c = comparator as Record<string, unknown>;
  if ("eq" in c && c.eq !== undefined && value !== c.eq) return false;
  if ("neq" in c && c.neq !== undefined && value === c.neq) return false;
  if ("contains" in c && typeof c.contains === "string" && !value.includes(c.contains)) return false;
  if ("startsWith" in c && typeof c.startsWith === "string" && !value.startsWith(c.startsWith)) return false;
  if ("endsWith" in c && typeof c.endsWith === "string" && !value.endsWith(c.endsWith)) return false;
  if ("eqIgnoreCase" in c && typeof c.eqIgnoreCase === "string" && value.toLowerCase() !== c.eqIgnoreCase.toLowerCase()) {
    return false;
  }
  if ("in" in c && Array.isArray(c.in) && !c.in.includes(value)) return false;
  if ("nin" in c && Array.isArray(c.nin) && c.nin.includes(value)) return false;
  if ("null" in c && typeof c.null === "boolean") {
    const isNull = value == null || value === "";
    if (c.null !== isNull) return false;
  }
  return true;
}
