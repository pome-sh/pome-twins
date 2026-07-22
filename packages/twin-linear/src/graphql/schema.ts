// file-size: Linear GraphQL schema SDL string — single source of truth for the twin schema surface.
// SPDX-License-Identifier: Apache-2.0
// file-size: GraphQL SDL floor; keep ops + input fields co-located for fidelity parity.
import { buildSchema, type GraphQLSchema } from "graphql";

/** Emulate Linear operation-floor schema (rewritten for twin-linear). */
export const linearGraphQLSchema: GraphQLSchema = buildSchema(`
  scalar TeamFilter
  scalar PaginationOrderBy

  type Query {
    viewer: User!
    organization: Organization!
    users(first: Int, after: String, last: Int, before: String, filter: UserFilter): UserConnection!
    user(id: String!): User
    teams(
      first: Int
      after: String
      last: Int
      before: String
      filter: TeamFilter
      includeArchived: Boolean
      orderBy: PaginationOrderBy
    ): TeamConnection!
    team(id: String!): Team
    workflowStates(first: Int, after: String, last: Int, before: String): WorkflowStateConnection!
    workflowState(id: String!): WorkflowState
    issues(first: Int, after: String, last: Int, before: String, filter: IssueFilter, orderBy: String): IssueConnection!
    issue(id: String!): Issue
    comments(first: Int, after: String, last: Int, before: String): CommentConnection!
    comment(id: String!): Comment
    issueLabels(first: Int, after: String, last: Int, before: String): IssueLabelConnection!
    issueLabel(id: String!): IssueLabel
    projects(first: Int, after: String, last: Int, before: String): ProjectConnection!
    project(id: String!): Project
    cycles(first: Int, after: String, last: Int, before: String): CycleConnection!
    cycle(id: String!): Cycle
    webhooks(first: Int, after: String, last: Int, before: String): WebhookConnection!
    webhook(id: String!): Webhook
    agentSessions(first: Int, after: String, last: Int, before: String): AgentSessionConnection!
    agentSession(id: String!): AgentSession
  }

  type Mutation {
    issueCreate(input: IssueCreateInput!): IssuePayload!
    issueUpdate(id: String, input: IssueUpdateInput!): IssuePayload!
    issueDelete(id: String!, permanentlyDelete: Boolean): IssueArchivePayload!
    issueArchive(id: String!, trash: Boolean): IssueArchivePayload!
    issueUnarchive(id: String!): IssueArchivePayload!
    commentCreate(input: CommentCreateInput!): CommentPayload!
    commentUpdate(id: String, input: CommentUpdateInput!, skipEditedAt: Boolean): CommentPayload!
    commentDelete(id: String!): DeletePayload!
    issueLabelCreate(input: IssueLabelCreateInput!, replaceTeamLabels: Boolean): IssueLabelPayload!
    issueLabelUpdate(id: String, input: IssueLabelUpdateInput!, replaceTeamLabels: Boolean): IssueLabelPayload!
    issueLabelDelete(id: String!): DeletePayload!
    issueAddLabel(id: String!, labelId: String!): IssuePayload!
    issueRemoveLabel(id: String!, labelId: String!): IssuePayload!
    webhookCreate(input: WebhookCreateInput!): WebhookPayload!
    webhookDelete(id: String!): DeletePayload!
    agentSessionCreateOnIssue(input: AgentSessionCreateOnIssue!): AgentSessionPayload!
    agentSessionCreateOnComment(input: AgentSessionCreateOnComment!): AgentSessionPayload!
    agentSessionUpdate(id: String, input: AgentSessionUpdateInput!): AgentSessionPayload!
    agentActivityCreate(input: AgentActivityCreateInput!): AgentActivityPayload!
  }

  type Organization {
    id: String!
    name: String!
    urlKey: String!
    url: String!
    createdAt: String!
    updatedAt: String!
    users(first: Int, after: String, last: Int, before: String): UserConnection!
    teams(
      first: Int
      after: String
      last: Int
      before: String
      filter: TeamFilter
      includeArchived: Boolean
      orderBy: PaginationOrderBy
    ): TeamConnection!
  }

  type User {
    id: String!
    name: String!
    displayName: String!
    email: String!
    description: String
    avatarUrl: String
    createdIssueCount: Int!
    avatarBackgroundColor: String
    statusUntilAt: String
    statusEmoji: String
    initials: String!
    lastSeen: String
    timezone: String
    disableReason: String
    statusLabel: String
    archivedAt: String
    gitHubUserId: String
    title: String
    url: String!
    active: Boolean!
    isAssignable: Boolean!
    guest: Boolean!
    admin: Boolean!
    owner: Boolean!
    app: Boolean!
    isMentionable: Boolean!
    isMe: Boolean!
    supportsAgentSessions: Boolean!
    canAccessAnyPublicTeam: Boolean!
    calendarHash: String
    inviteHash: String
    createdAt: String!
    updatedAt: String!
    assignedIssues(first: Int, after: String, last: Int, before: String): IssueConnection!
    createdIssues(first: Int, after: String, last: Int, before: String): IssueConnection!
  }

  type Team {
    id: String!
    key: String!
    name: String!
    description: String
    private: Boolean!
    url: String!
    createdAt: String!
    updatedAt: String!
    cycleIssueAutoAssignCompleted: Boolean
    cycleLockToActive: Boolean
    cycleIssueAutoAssignStarted: Boolean
    cycleCalenderUrl: String
    upcomingCycleCount: Int
    autoArchivePeriod: Int
    autoClosePeriod: Int
    securitySettings: String
    integrationsSettings: NodeRef
    activeCycle: Cycle
    triageResponsibility: NodeRef
    scimGroupName: String
    autoCloseStateId: String
    cycleCooldownTime: Int
    cycleStartDay: Int
    defaultTemplateForMembers: NodeRef
    defaultTemplateForNonMembers: NodeRef
    defaultProjectTemplate: NodeRef
    defaultIssueState: WorkflowState
    cycleDuration: Int
    icon: String
    defaultTemplateForMembersId: String
    defaultTemplateForNonMembersId: String
    issueEstimationType: String
    displayName: String
    color: String
    parent: Team
    archivedAt: String
    retiredAt: String
    timezone: String
    issueCount: Int
    visibility: String
    mergeWorkflowState: WorkflowState
    draftWorkflowState: WorkflowState
    startWorkflowState: WorkflowState
    mergeableWorkflowState: WorkflowState
    reviewWorkflowState: WorkflowState
    markedAsDuplicateWorkflowState: WorkflowState
    triageIssueState: WorkflowState
    defaultIssueEstimate: Int
    setIssueSortOrderOnStateChange: Boolean
    allMembersCanJoin: Boolean
    requirePriorityToLeaveTriage: Boolean
    autoCloseChildIssues: Boolean
    autoCloseParentIssues: Boolean
    scimManaged: Boolean
    inheritIssueEstimation: Boolean
    inheritWorkflowStatuses: Boolean
    cyclesEnabled: Boolean
    issueEstimationExtended: Boolean
    issueEstimationAllowZero: Boolean
    aiDiscussionSummariesEnabled: Boolean
    aiThreadSummariesEnabled: Boolean
    groupIssueHistory: Boolean
    slackIssueComments: Boolean
    slackNewIssue: Boolean
    slackIssueStatuses: Boolean
    triageEnabled: Boolean
    inviteHash: String
    issueOrderingNoPriorityFirst: Boolean
    issueSortOrderDefaultToBottom: Boolean
    states(first: Int, after: String, last: Int, before: String): WorkflowStateConnection!
    issues(first: Int, after: String, last: Int, before: String, filter: IssueFilter): IssueConnection!
    labels(first: Int, after: String, last: Int, before: String): IssueLabelConnection!
    projects(first: Int, after: String, last: Int, before: String): ProjectConnection!
    cycles(first: Int, after: String, last: Int, before: String): CycleConnection!
    webhooks(first: Int, after: String, last: Int, before: String): WebhookConnection!
  }

  type WorkflowState {
    id: String!
    name: String!
    type: String!
    position: Int!
    createdAt: String!
    updatedAt: String!
    team: Team!
    issues(first: Int, after: String, last: Int, before: String): IssueConnection!
  }

  type Issue {
    id: String!
    identifier: String!
    number: Int!
    title: String!
    description: String
    priority: Int!
    estimate: Int
    url: String!
    createdAt: String!
    updatedAt: String!
    archivedAt: String
    canceledAt: String
    completedAt: String
    startedAt: String
    dueDate: String
    trashed: Boolean
    createAsUser: String
    displayIconUrl: String
    team: Team!
    state: WorkflowState!
    assignee: User
    creator: User
    delegate: User
    parent: Issue
    labels(first: Int, after: String, last: Int, before: String): IssueLabelConnection!
    comments(first: Int, after: String, last: Int, before: String): CommentConnection!
    project: Project
    cycle: Cycle
  }

  type Comment {
    id: String!
    body: String!
    createdAt: String!
    updatedAt: String!
    createAsUser: String
    displayIconUrl: String
    issue: Issue!
    parent: Comment
    user: User
  }

  type IssueLabel {
    id: String!
    name: String!
    color: String!
    description: String
    createdAt: String!
    updatedAt: String!
    team: Team
    issues(first: Int, after: String, last: Int, before: String): IssueConnection!
  }

  type Project {
    id: String!
    name: String!
    description: String
    state: String!
    createdAt: String!
    updatedAt: String!
    team: Team
    issues(first: Int, after: String, last: Int, before: String): IssueConnection!
  }

  type Cycle {
    id: String!
    name: String!
    number: Int!
    startsAt: String
    endsAt: String
    createdAt: String!
    updatedAt: String!
    team: Team!
    issues(first: Int, after: String, last: Int, before: String): IssueConnection!
  }

  type Webhook {
    id: String!
    label: String!
    url: String!
    enabled: Boolean!
    resourceTypes: [String!]!
    allPublicTeams: Boolean!
    secret: String
    createdAt: String!
    updatedAt: String!
    team: Team
  }

  type AgentSession {
    id: String!
    state: String!
    plan: String
    externalUrl: String
    createdAt: String!
    updatedAt: String!
    issue: Issue
    comment: Comment
    agentUser: User!
    activities(first: Int, after: String, last: Int, before: String): AgentActivityConnection!
  }

  type AgentActivity {
    id: String!
    type: String!
    body: String!
    ephemeral: Boolean!
    createdAt: String!
    updatedAt: String!
    session: AgentSession!
    user: User
  }

  type NodeRef {
    id: String!
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  type UserEdge { node: User! cursor: String! }
  type TeamEdge { node: Team! cursor: String! }
  type WorkflowStateEdge { node: WorkflowState! cursor: String! }
  type IssueEdge { node: Issue! cursor: String! }
  type CommentEdge { node: Comment! cursor: String! }
  type IssueLabelEdge { node: IssueLabel! cursor: String! }
  type ProjectEdge { node: Project! cursor: String! }
  type CycleEdge { node: Cycle! cursor: String! }
  type WebhookEdge { node: Webhook! cursor: String! }
  type AgentSessionEdge { node: AgentSession! cursor: String! }
  type AgentActivityEdge { node: AgentActivity! cursor: String! }

  type UserConnection { nodes: [User!]! edges: [UserEdge!]! pageInfo: PageInfo! }
  type TeamConnection { nodes: [Team!]! edges: [TeamEdge!]! pageInfo: PageInfo! }
  type WorkflowStateConnection { nodes: [WorkflowState!]! edges: [WorkflowStateEdge!]! pageInfo: PageInfo! }
  type IssueConnection { nodes: [Issue!]! edges: [IssueEdge!]! pageInfo: PageInfo! }
  type CommentConnection { nodes: [Comment!]! edges: [CommentEdge!]! pageInfo: PageInfo! }
  type IssueLabelConnection { nodes: [IssueLabel!]! edges: [IssueLabelEdge!]! pageInfo: PageInfo! }
  type ProjectConnection { nodes: [Project!]! edges: [ProjectEdge!]! pageInfo: PageInfo! }
  type CycleConnection { nodes: [Cycle!]! edges: [CycleEdge!]! pageInfo: PageInfo! }
  type WebhookConnection { nodes: [Webhook!]! edges: [WebhookEdge!]! pageInfo: PageInfo! }
  type AgentSessionConnection { nodes: [AgentSession!]! edges: [AgentSessionEdge!]! pageInfo: PageInfo! }
  type AgentActivityConnection { nodes: [AgentActivity!]! edges: [AgentActivityEdge!]! pageInfo: PageInfo! }

  type IssuePayload { success: Boolean! lastSyncId: Float issue: Issue }
  type CommentPayload { success: Boolean! lastSyncId: Float comment: Comment }
  type IssueLabelPayload { success: Boolean! lastSyncId: Float issueLabel: IssueLabel }
  type WebhookPayload { success: Boolean! lastSyncId: Float webhook: Webhook }
  type AgentSessionPayload { success: Boolean! lastSyncId: Float agentSession: AgentSession }
  type AgentActivityPayload { success: Boolean! lastSyncId: Float agentActivity: AgentActivity }
  type IssueArchivePayload { success: Boolean! lastSyncId: Float entity: Issue }
  type DeletePayload { success: Boolean! lastSyncId: Float entityId: String }

  input StringComparator {
    eq: String
    neq: String
    in: [String!]
    nin: [String!]
    contains: String
    startsWith: String
    endsWith: String
    eqIgnoreCase: String
    neqIgnoreCase: String
    null: Boolean
  }

  input IssueFilter {
    id: StringComparator
    identifier: StringComparator
    title: StringComparator
    team: StringComparator
    state: StringComparator
    assignee: StringComparator
    creator: StringComparator
    project: StringComparator
    cycle: StringComparator
    labels: StringComparator
    or: [IssueFilter!]
  }

  input UserFilter {
    id: StringComparator
    email: StringComparator
    name: StringComparator
    active: Boolean
    admin: Boolean
  }

  input IssueCreateInput {
    teamId: String!
    title: String!
    description: String
    priority: Int
    estimate: Int
    stateId: String
    assigneeId: String
    delegateId: String
    labelIds: [String!]
    projectId: String
    cycleId: String
    parentId: String
    createAsUser: String
    displayIconUrl: String
    dueDate: String
  }

  input IssueUpdateInput {
    id: String
    title: String
    description: String
    priority: Int
    estimate: Int
    stateId: String
    assigneeId: String
    delegateId: String
    labelIds: [String!]
    projectId: String
    cycleId: String
    parentId: String
    archivedAt: String
    dueDate: String
  }

  input CommentCreateInput {
    issueId: String
    parentId: String
    body: String!
    createAsUser: String
    displayIconUrl: String
  }

  input CommentUpdateInput {
    id: String
    body: String!
  }

  input IssueLabelCreateInput {
    name: String!
    color: String
    description: String
    teamId: String
  }

  input IssueLabelUpdateInput {
    id: String
    name: String
    color: String
    description: String
  }

  input WebhookCreateInput {
    url: String!
    label: String
    resourceTypes: [String!]
    teamId: String
    allPublicTeams: Boolean
    secret: String
    enabled: Boolean
  }

  input AgentSessionCreateOnIssue {
    issueId: String!
    agentUserId: String
    plan: String
    externalUrl: String
  }

  input AgentSessionCreateOnComment {
    commentId: String!
    agentUserId: String
    plan: String
    externalUrl: String
  }

  input AgentSessionUpdateInput {
    id: String
    state: String
    plan: String
    externalUrl: String
  }

  input AgentActivityCreateInput {
    sessionId: String!
    type: String!
    body: String!
    ephemeral: Boolean
  }
`);
