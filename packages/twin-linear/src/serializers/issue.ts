// SPDX-License-Identifier: Apache-2.0
import type { LinearDomain } from "../domain/index.js";
import type { LinearIssue } from "../types.js";

/** Shared scalar core used by MCP / GraphQL / webhook projectors. */
export function issueCore(issue: LinearIssue) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    number: issue.number,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    estimate: issue.estimate,
    url: issue.url,
    teamId: issue.teamId,
    stateId: issue.stateId,
    assigneeId: issue.assigneeId,
    creatorId: issue.creatorId,
    delegateId: issue.delegateId,
    labelIds: issue.labelIds,
    projectId: issue.projectId,
    cycleId: issue.cycleId,
    parentId: issue.parentId,
    archivedAt: issue.archivedAt,
    canceledAt: issue.canceledAt,
    completedAt: issue.completedAt,
    startedAt: issue.startedAt,
    dueDate: issue.dueDate,
    createAsUser: issue.createAsUser,
    displayIconUrl: issue.displayIconUrl,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

/** Webhook `data` payload (subset Linear agents typically consume). */
export function serializeIssueWebhook(issue: LinearIssue): Record<string, unknown> {
  const core = issueCore(issue);
  return {
    id: core.id,
    identifier: core.identifier,
    number: core.number,
    title: core.title,
    description: core.description,
    priority: core.priority,
    url: core.url,
    teamId: core.teamId,
    stateId: core.stateId,
    assigneeId: core.assigneeId,
    labelIds: core.labelIds,
    archivedAt: core.archivedAt,
    createdAt: core.createdAt,
    updatedAt: core.updatedAt,
  };
}

/** MCP tool projection with nested team/state/assignee summaries. */
export function serializeIssueMcp(issue: LinearIssue, domain: LinearDomain) {
  const core = issueCore(issue);
  const state = domain.getWorkflowState(issue.stateId);
  const assignee = issue.assigneeId ? domain.getUser(issue.assigneeId) : null;
  const team = domain.getTeam(issue.teamId);
  return {
    id: core.id,
    identifier: core.identifier,
    title: core.title,
    description: core.description,
    priority: core.priority,
    estimate: core.estimate,
    url: core.url,
    team: team ? { id: team.id, key: team.key, name: team.name } : null,
    state: state ? { id: state.id, name: state.name, type: state.type } : null,
    assignee: assignee ? { id: assignee.id, name: assignee.name, email: assignee.email } : null,
    labelIds: core.labelIds,
    projectId: core.projectId,
    cycleId: core.cycleId,
    parentId: core.parentId,
    relations: domain.listIssueRelations(issue.id),
    createdAt: core.createdAt,
    updatedAt: core.updatedAt,
  };
}

/** GraphQL Issue scalar fields (relations attached by resolvers). */
export function issueGraphqlScalars(issue: LinearIssue) {
  const core = issueCore(issue);
  return {
    id: core.id,
    identifier: core.identifier,
    number: core.number,
    title: core.title,
    description: core.description,
    priority: core.priority,
    estimate: core.estimate,
    url: core.url,
    createdAt: core.createdAt,
    updatedAt: core.updatedAt,
    archivedAt: core.archivedAt,
    canceledAt: core.canceledAt,
    completedAt: core.completedAt,
    startedAt: core.startedAt,
    dueDate: core.dueDate,
    trashed: false,
    createAsUser: core.createAsUser,
    displayIconUrl: core.displayIconUrl,
  };
}
