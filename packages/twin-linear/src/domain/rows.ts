// SPDX-License-Identifier: Apache-2.0
import type {
  LinearAgentActivity,
  LinearAgentSession,
  LinearComment,
  LinearCycle,
  LinearDocument,
  LinearIssue,
  LinearIssueLabel,
  LinearIssuePriority,
  LinearOAuthApp,
  LinearOrganization,
  LinearProject,
  LinearProjectState,
  LinearTeam,
  LinearToken,
  LinearTokenActorType,
  LinearTokenType,
  LinearTwinDatabase,
  LinearUser,
  LinearWebhook,
  LinearWorkflowState,
  LinearWorkflowStateType,
  LinearAgentSessionState,
} from "../types.js";

export type OrgRow = {
  id: string;
  name: string;
  url_key: string;
  url: string;
  created_at: string;
  updated_at: string;
};
export type UserRow = {
  id: string;
  email: string;
  name: string;
  display_name: string;
  avatar_url: string | null;
  active: number;
  admin: number;
  app: number;
  created_at: string;
  updated_at: string;
};
export type TeamRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  private: number;
  url: string;
  issue_sequence: number;
  created_at: string;
  updated_at: string;
};
export type StateRow = {
  id: string;
  team_id: string;
  name: string;
  type: string;
  position: number;
  created_at: string;
  updated_at: string;
};
export type LabelRow = {
  id: string;
  team_id: string | null;
  name: string;
  color: string;
  description: string | null;
  created_at: string;
  updated_at: string;
};
export type ProjectRow = {
  id: string;
  team_id: string | null;
  name: string;
  description: string | null;
  state: string;
  created_at: string;
  updated_at: string;
};
export type CycleRow = {
  id: string;
  team_id: string;
  name: string;
  number: number;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
};
export type IssueRow = {
  id: string;
  identifier: string;
  number: number;
  team_id: string;
  title: string;
  description: string | null;
  priority: number;
  estimate: number | null;
  state_id: string;
  assignee_id: string | null;
  creator_id: string | null;
  delegate_id: string | null;
  project_id: string | null;
  cycle_id: string | null;
  parent_id: string | null;
  url: string;
  archived_at: string | null;
  canceled_at: string | null;
  completed_at: string | null;
  started_at: string | null;
  due_date: string | null;
  create_as_user: string | null;
  display_icon_url: string | null;
  created_at: string;
  updated_at: string;
};
export type CommentRow = {
  id: string;
  issue_id: string;
  parent_id: string | null;
  user_id: string | null;
  body: string;
  create_as_user: string | null;
  display_icon_url: string | null;
  created_at: string;
  updated_at: string;
};
export type DocumentRow = {
  id: string;
  title: string;
  content: string | null;
  slug: string;
  project_id: string | null;
  team_id: string | null;
  issue_id: string | null;
  cycle_id: string | null;
  icon: string | null;
  color: string | null;
  creator_id: string | null;
  created_at: string;
  updated_at: string;
};
export type OAuthAppRow = {
  id: string;
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris_json: string;
  scopes_json: string;
  actor: string;
  assignable: number;
  mentionable: number;
  app_user_id: string | null;
  created_at: string;
  updated_at: string;
};
export type TokenRow = {
  token: string;
  type: string;
  actor_type: string;
  user_id: string | null;
  app_id: string | null;
  scopes_json: string;
  expires_at: string | null;
  revoked: number;
  refresh_token: string | null;
  sid: string;
  created_at: string;
  updated_at: string;
};
export type WebhookRow = {
  id: string;
  label: string;
  url: string;
  enabled: number;
  resource_types_json: string;
  team_id: string | null;
  all_public_teams: number;
  secret: string | null;
  creator_id: string | null;
  created_at: string;
  updated_at: string;
};
export type AgentSessionRow = {
  id: string;
  issue_id: string | null;
  comment_id: string | null;
  agent_user_id: string;
  state: string;
  plan: string | null;
  external_url: string | null;
  created_at: string;
  updated_at: string;
};
export type AgentActivityRow = {
  id: string;
  session_id: string;
  user_id: string | null;
  type: string;
  body: string;
  ephemeral: number;
  created_at: string;
  updated_at: string;
};
export type PendingCodeRow = {
  code: string;
  app_id: string | null;
  client_id: string;
  redirect_uri: string;
  scopes_json: string;
  user_id: string | null;
  actor: string;
  code_challenge: string | null;
  code_challenge_method: string | null;
  created_at: string;
};

export function mapOrg(row: OrgRow): LinearOrganization {
  return {
    id: row.id,
    name: row.name,
    urlKey: row.url_key,
    url: row.url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function mapUser(row: UserRow): LinearUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    active: !!row.active,
    admin: !!row.admin,
    app: !!row.app,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function mapTeam(row: TeamRow): LinearTeam {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    private: !!row.private,
    url: row.url,
    issueSequence: row.issue_sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function mapState(row: StateRow): LinearWorkflowState {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    type: row.type as LinearWorkflowStateType,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function mapLabel(row: LabelRow): LinearIssueLabel {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    color: row.color,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function mapProject(row: ProjectRow): LinearProject {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    description: row.description,
    state: row.state as LinearProjectState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function mapCycle(row: CycleRow): LinearCycle {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    number: row.number,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function mapComment(row: CommentRow): LinearComment {
  return {
    id: row.id,
    issueId: row.issue_id,
    parentId: row.parent_id,
    userId: row.user_id,
    body: row.body,
    createAsUser: row.create_as_user,
    displayIconUrl: row.display_icon_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function mapDocument(row: DocumentRow): LinearDocument {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    slug: row.slug,
    projectId: row.project_id,
    teamId: row.team_id,
    issueId: row.issue_id,
    cycleId: row.cycle_id,
    icon: row.icon,
    color: row.color,
    creatorId: row.creator_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function mapOAuthApp(row: OAuthAppRow): LinearOAuthApp {
  return {
    id: row.id,
    clientId: row.client_id,
    clientSecret: row.client_secret,
    name: row.name,
    redirectUris: JSON.parse(row.redirect_uris_json) as string[],
    scopes: JSON.parse(row.scopes_json) as string[],
    actor: row.actor as LinearTokenActorType,
    assignable: !!row.assignable,
    mentionable: !!row.mentionable,
    appUserId: row.app_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function mapToken(row: TokenRow): LinearToken {
  return {
    token: row.token,
    type: row.type as LinearTokenType,
    actorType: row.actor_type as LinearTokenActorType,
    userId: row.user_id,
    appId: row.app_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    revoked: !!row.revoked,
    refreshToken: row.refresh_token,
    sid: row.sid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function mapWebhook(row: WebhookRow): LinearWebhook {
  return {
    id: row.id,
    label: row.label,
    url: row.url,
    enabled: !!row.enabled,
    resourceTypes: JSON.parse(row.resource_types_json) as string[],
    teamId: row.team_id,
    allPublicTeams: !!row.all_public_teams,
    secret: row.secret,
    creatorId: row.creator_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function mapAgentSession(row: AgentSessionRow): LinearAgentSession {
  return {
    id: row.id,
    issueId: row.issue_id,
    commentId: row.comment_id,
    agentUserId: row.agent_user_id,
    state: row.state as LinearAgentSessionState,
    plan: row.plan,
    externalUrl: row.external_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function mapAgentActivity(row: AgentActivityRow): LinearAgentActivity {
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    type: row.type as LinearAgentActivity["type"],
    body: row.body,
    ephemeral: !!row.ephemeral,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapIssue(db: LinearTwinDatabase, row: IssueRow): LinearIssue {
  const labelIds = (
    db.prepare("SELECT label_id FROM issue_label_links WHERE issue_id = ?").all(row.id) as Array<{
      label_id: string;
    }>
  ).map((r) => r.label_id);
  return {
    id: row.id,
    identifier: row.identifier,
    number: row.number,
    teamId: row.team_id,
    title: row.title,
    description: row.description,
    priority: row.priority as LinearIssuePriority,
    estimate: row.estimate,
    stateId: row.state_id,
    assigneeId: row.assignee_id,
    creatorId: row.creator_id,
    delegateId: row.delegate_id,
    projectId: row.project_id,
    cycleId: row.cycle_id,
    parentId: row.parent_id,
    labelIds,
    url: row.url,
    archivedAt: row.archived_at,
    canceledAt: row.canceled_at,
    completedAt: row.completed_at,
    startedAt: row.started_at,
    dueDate: row.due_date,
    createAsUser: row.create_as_user,
    displayIconUrl: row.display_icon_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
