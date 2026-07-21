// SPDX-License-Identifier: Apache-2.0
import type { TwinDatabase } from "@pome-sh/sdk";

export type LinearTwinDatabase = TwinDatabase;

export type LinearWorkflowStateType =
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

export type LinearTokenType = "personal" | "oauth_access" | "oauth_refresh" | "client_credentials";
export type LinearTokenActorType = "user" | "app";
export type LinearIssuePriority = 0 | 1 | 2 | 3 | 4;
export type LinearAgentActivityType =
  | "thought"
  | "elicitation"
  | "action"
  | "response"
  | "error"
  | "prompt";
export type LinearAgentSessionState = "pending" | "active" | "completed" | "failed" | "canceled";
export type LinearProjectState = "planned" | "started" | "completed" | "canceled";

export type LinearOrganization = {
  id: string;
  name: string;
  urlKey: string;
  url: string;
  createdAt: string;
  updatedAt: string;
};

export type LinearUser = {
  id: string;
  email: string;
  name: string;
  displayName: string;
  avatarUrl: string | null;
  active: boolean;
  admin: boolean;
  app: boolean;
  createdAt: string;
  updatedAt: string;
};

export type LinearTeam = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  private: boolean;
  url: string;
  issueSequence: number;
  createdAt: string;
  updatedAt: string;
};

export type LinearWorkflowState = {
  id: string;
  teamId: string;
  name: string;
  type: LinearWorkflowStateType;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type LinearIssueLabel = {
  id: string;
  teamId: string | null;
  name: string;
  color: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LinearProject = {
  id: string;
  teamId: string | null;
  name: string;
  description: string | null;
  state: LinearProjectState;
  createdAt: string;
  updatedAt: string;
};

export type LinearCycle = {
  id: string;
  teamId: string;
  name: string;
  number: number;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LinearIssue = {
  id: string;
  identifier: string;
  number: number;
  teamId: string;
  title: string;
  description: string | null;
  priority: LinearIssuePriority;
  stateId: string;
  assigneeId: string | null;
  creatorId: string | null;
  delegateId: string | null;
  projectId: string | null;
  cycleId: string | null;
  labelIds: string[];
  url: string;
  archivedAt: string | null;
  canceledAt: string | null;
  completedAt: string | null;
  startedAt: string | null;
  dueDate: string | null;
  createAsUser: string | null;
  displayIconUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LinearComment = {
  id: string;
  issueId: string;
  userId: string | null;
  body: string;
  createAsUser: string | null;
  displayIconUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LinearOAuthApp = {
  id: string;
  clientId: string;
  clientSecret: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
  actor: LinearTokenActorType;
  assignable: boolean;
  mentionable: boolean;
  appUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LinearToken = {
  token: string;
  type: LinearTokenType;
  actorType: LinearTokenActorType;
  userId: string | null;
  appId: string | null;
  scopes: string[];
  expiresAt: string | null;
  revoked: boolean;
  refreshToken: string | null;
  sid: string;
  createdAt: string;
  updatedAt: string;
};

export type LinearWebhook = {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
  resourceTypes: string[];
  teamId: string | null;
  allPublicTeams: boolean;
  secret: string | null;
  creatorId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LinearWebhookDelivery = {
  id: string;
  webhookId: string;
  event: string;
  action: string;
  url: string;
  status: number | null;
  error: string | null;
  payload: unknown;
  headers: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

export type LinearAgentSession = {
  id: string;
  issueId: string | null;
  commentId: string | null;
  agentUserId: string;
  state: LinearAgentSessionState;
  plan: string | null;
  externalUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LinearAgentActivity = {
  id: string;
  sessionId: string;
  userId: string | null;
  type: LinearAgentActivityType;
  body: string;
  ephemeral: boolean;
  createdAt: string;
  updatedAt: string;
};

export type LinearStateSeed = {
  clock?: string;
  defaultSid?: string;
  baseUrl?: string;
  strictScopes?: boolean;
  organization?: {
    id?: string;
    name?: string;
    urlKey?: string;
  };
  users?: Array<{
    id?: string;
    email: string;
    name?: string;
    displayName?: string;
    avatarUrl?: string | null;
    active?: boolean;
    admin?: boolean;
    app?: boolean;
  }>;
  teams?: Array<{
    id?: string;
    key: string;
    name: string;
    description?: string | null;
    private?: boolean;
    states?: Array<{
      id?: string;
      name: string;
      type?: LinearWorkflowStateType;
      position?: number;
    }>;
  }>;
  labels?: Array<{
    id?: string;
    name: string;
    color?: string;
    description?: string | null;
    team?: string;
  }>;
  projects?: Array<{
    id?: string;
    name: string;
    description?: string | null;
    state?: LinearProjectState;
    team?: string;
  }>;
  cycles?: Array<{
    id?: string;
    team: string;
    name: string;
    number?: number;
    startsAt?: string | null;
    endsAt?: string | null;
  }>;
  issues?: Array<{
    id?: string;
    team: string;
    title: string;
    description?: string | null;
    priority?: LinearIssuePriority;
    state?: string;
    assignee?: string;
    creator?: string;
    delegate?: string;
    project?: string;
    cycle?: string;
    labels?: string[];
    dueDate?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }>;
  comments?: Array<{
    id?: string;
    issue: string;
    body: string;
    user?: string;
    createdAt?: string;
  }>;
  oauthApps?: Array<{
    id?: string;
    clientId: string;
    clientSecret: string;
    name: string;
    redirectUris: string[];
    scopes?: string[] | string;
    actor?: LinearTokenActorType;
    assignable?: boolean;
    mentionable?: boolean;
    appUserId?: string | null;
  }>;
  tokens?: Array<{
    token: string;
    type?: Exclude<LinearTokenType, "oauth_refresh">;
    user?: string;
    app?: string;
    scopes?: string[] | string;
    actor?: LinearTokenActorType;
    sid?: string;
    expiresAt?: string | null;
  }>;
  webhooks?: Array<{
    id?: string;
    label?: string;
    url: string;
    resourceTypes?: string[] | string;
    team?: string;
    allPublicTeams?: boolean;
    secret?: string | null;
    enabled?: boolean;
  }>;
};

export const DEFAULT_LINEAR_CLOCK = "2026-07-21T00:00:00.000Z";
export const DEFAULT_LINEAR_EMAIL = "admin@pome-twin.test";
export const DEFAULT_LINEAR_TOKEN = "lin_test_admin";
export const LINEAR_PROVIDER_TOKEN_PREFIX = "lin_pome_";
export const DEFAULT_LINEAR_SID = "standalone";
export const DEFAULT_LINEAR_PORT = 3337;
export const DEFAULT_SCOPES = ["read", "write", "issues:create", "comments:create", "admin"] as const;

export const TITLE_MAX_BYTES = 512;
export const BODY_MAX_BYTES = 65_536;
export const GRAPHQL_QUERY_MAX_BYTES = 100_000;
export const GRAPHQL_SELECTION_DEPTH_MAX = 20;
export const MCP_PAGE_DEFAULT = 50;
export const MCP_PAGE_MAX = 250;
export const RELAY_PAGE_DEFAULT = 50;
export const RELAY_PAGE_MAX = 250;
export const STATE_EXPORT_CAP = 2000;
export const OAUTH_CODE_TTL_SECONDS = 600;
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
