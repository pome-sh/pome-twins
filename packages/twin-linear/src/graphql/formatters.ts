// SPDX-License-Identifier: Apache-2.0
import type { ActorContext, LinearDomain } from "../domain/index.js";
import { connectionFromArray, type ConnectionArgs } from "../pagination.js";
import { commentGraphqlScalars, issueGraphqlScalars } from "../serializers/index.js";
import type {
  LinearAgentActivity,
  LinearAgentSession,
  LinearComment,
  LinearCycle,
  LinearIssue,
  LinearIssueLabel,
  LinearProject,
  LinearTeam,
  LinearUser,
  LinearWebhook,
  LinearWorkflowState,
} from "../types.js";

type ConnectFn = <T, U>(
  items: T[],
  args: ConnectionArgs,
  map: (item: T) => U,
  binding: string
) => {
  nodes: U[];
  edges: Array<{ cursor: string; node: U }>;
  pageInfo: ReturnType<typeof connectionFromArray>["pageInfo"];
};

// Explicit surface — inferred mutual closures exceed TS7056 serialization limits.
export type GraphQLFormatters = {
  connect: ConnectFn;
  formatUser: (user: LinearUser) => Record<string, unknown>;
  formatState: (state: LinearWorkflowState) => Record<string, unknown>;
  formatTeam: (team: LinearTeam) => Record<string, unknown>;
  formatLabel: (label: LinearIssueLabel) => Record<string, unknown>;
  formatProject: (project: LinearProject) => Record<string, unknown>;
  formatCycle: (cycle: LinearCycle) => Record<string, unknown>;
  formatComment: (comment: LinearComment) => Record<string, unknown>;
  formatWebhook: (webhook: LinearWebhook) => Record<string, unknown>;
  formatAgentSession: (session: LinearAgentSession) => Record<string, unknown>;
  formatAgentActivity: (activity: LinearAgentActivity) => Record<string, unknown>;
  formatIssue: (issue: LinearIssue) => Record<string, unknown>;
};

export function createFormatters(commands: LinearDomain, actor: ActorContext): GraphQLFormatters {
  const connect: ConnectFn = (items, args, map, binding) => {
    const page = connectionFromArray(items, args, binding);
    const nodes = page.nodes.map(map);
    return {
      nodes,
      edges: page.edges.map((edge, i) => ({ cursor: edge.cursor, node: nodes[i]! })),
      pageInfo: page.pageInfo,
    };
  };

  const formatUser = (user: LinearUser) => ({
    id: user.id,
    name: user.name,
    displayName: user.displayName,
    email: user.email,
    description: null,
    avatarUrl: user.avatarUrl,
    createdIssueCount: () => commands.countIssues({ creator: user.id, includeArchived: true }),
    avatarBackgroundColor: null,
    statusUntilAt: null,
    statusEmoji: null,
    initials: initials(user.displayName || user.name),
    lastSeen: user.active ? user.updatedAt : null,
    timezone: "UTC",
    disableReason: null,
    statusLabel: null,
    archivedAt: null,
    gitHubUserId: null,
    title: null,
    url: `https://linear.app/user/${encodeURIComponent(user.email)}`,
    active: user.active,
    isAssignable: user.active,
    guest: false,
    admin: user.admin,
    owner: user.admin,
    app: user.app,
    isMentionable: user.active,
    isMe: () => commands.resolveViewer(actor).id === user.id,
    supportsAgentSessions: user.app,
    canAccessAnyPublicTeam: true,
    calendarHash: null,
    inviteHash: null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    assignedIssues: (args: ConnectionArgs) =>
      connect(
        commands.listIssues({ assignee: user.id, includeArchived: true }),
        args,
        formatIssue,
        `user:${user.id}:assigned`
      ),
    createdIssues: (args: ConnectionArgs) =>
      connect(
        commands.listIssues({ creator: user.id, includeArchived: true }),
        args,
        formatIssue,
        `user:${user.id}:created`
      ),
  });

  const formatState = (state: LinearWorkflowState) => ({
    id: state.id,
    name: state.name,
    type: state.type,
    position: state.position,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    team: () => formatTeam(commands.requireTeam(state.teamId)),
    issues: (args: ConnectionArgs) =>
      connect(
        commands.listIssues({ state: state.id, includeArchived: true }),
        args,
        formatIssue,
        `state:${state.id}:issues`
      ),
  });

  const formatTeam = (team: LinearTeam) => {
    const states = () => commands.listWorkflowStates(team.id);
    const byType = (type: string) => states().find((s) => s.type === type);
    return {
      id: team.id,
      key: team.key,
      name: team.name,
      description: team.description,
      private: team.private,
      url: team.url,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
      cycleIssueAutoAssignCompleted: false,
      cycleLockToActive: false,
      cycleIssueAutoAssignStarted: false,
      cycleCalenderUrl: null,
      upcomingCycleCount: 0,
      autoArchivePeriod: null,
      autoClosePeriod: null,
      securitySettings: null,
      integrationsSettings: null,
      activeCycle: () => {
        const cycle = commands.listCycles(team.id)[0];
        return cycle ? formatCycle(cycle) : null;
      },
      triageResponsibility: null,
      scimGroupName: null,
      autoCloseStateId: null,
      cycleCooldownTime: 0,
      cycleStartDay: 1,
      defaultTemplateForMembers: null,
      defaultTemplateForNonMembers: null,
      defaultProjectTemplate: null,
      defaultIssueState: () => {
        const state = byType("unstarted") ?? states()[0];
        return state ? formatState(state) : null;
      },
      cycleDuration: 2,
      icon: null,
      defaultTemplateForMembersId: null,
      defaultTemplateForNonMembersId: null,
      issueEstimationType: "notUsed",
      displayName: team.name,
      color: "#5e6ad2",
      parent: null,
      archivedAt: null,
      retiredAt: null,
      timezone: "UTC",
      issueCount: () => commands.countIssues({ team: team.id, includeArchived: true }),
      visibility: team.private ? "private" : "public",
      mergeWorkflowState: () => optionalState(byType("completed")),
      draftWorkflowState: () => optionalState(byType("backlog")),
      startWorkflowState: () => optionalState(byType("started")),
      mergeableWorkflowState: () => optionalState(byType("started")),
      reviewWorkflowState: () => optionalState(byType("started")),
      markedAsDuplicateWorkflowState: () => optionalState(byType("canceled")),
      triageIssueState: () => optionalState(byType("unstarted") ?? states()[0]),
      defaultIssueEstimate: null,
      setIssueSortOrderOnStateChange: false,
      allMembersCanJoin: !team.private,
      requirePriorityToLeaveTriage: false,
      autoCloseChildIssues: false,
      autoCloseParentIssues: false,
      scimManaged: false,
      inheritIssueEstimation: false,
      inheritWorkflowStatuses: false,
      cyclesEnabled: true,
      issueEstimationExtended: false,
      issueEstimationAllowZero: true,
      aiDiscussionSummariesEnabled: false,
      aiThreadSummariesEnabled: false,
      groupIssueHistory: false,
      slackIssueComments: false,
      slackNewIssue: false,
      slackIssueStatuses: false,
      triageEnabled: false,
      inviteHash: null,
      issueOrderingNoPriorityFirst: false,
      issueSortOrderDefaultToBottom: false,
      states: (args: ConnectionArgs) => connect(states(), args, formatState, `team:${team.id}:states`),
      issues: (args: ConnectionArgs) =>
        connect(commands.listIssues({ team: team.id }), args, formatIssue, `team:${team.id}:issues`),
      labels: (args: ConnectionArgs) =>
        connect(commands.listLabels(team.id), args, formatLabel, `team:${team.id}:labels`),
      projects: (args: ConnectionArgs) =>
        connect(commands.listProjects(team.id), args, formatProject, `team:${team.id}:projects`),
      cycles: (args: ConnectionArgs) =>
        connect(commands.listCycles(team.id), args, formatCycle, `team:${team.id}:cycles`),
      webhooks: (args: ConnectionArgs) =>
        connect(
          commands.listWebhooks().filter((w) => w.teamId === team.id || w.allPublicTeams),
          args,
          formatWebhook,
          `team:${team.id}:webhooks`
        ),
    };

    function optionalState(state: LinearWorkflowState | undefined) {
      return state ? formatState(state) : null;
    }
  };

  const formatLabel = (label: LinearIssueLabel) => ({
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
    createdAt: label.createdAt,
    updatedAt: label.updatedAt,
    team: () => (label.teamId ? formatTeam(commands.requireTeam(label.teamId)) : null),
    issues: (args: ConnectionArgs) =>
      connect(
        commands.listIssues({ label: label.id, includeArchived: true }),
        args,
        formatIssue,
        `label:${label.id}:issues`
      ),
  });

  const formatProject = (project: LinearProject) => ({
    id: project.id,
    name: project.name,
    description: project.description,
    state: project.state,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    team: () => (project.teamId ? formatTeam(commands.requireTeam(project.teamId)) : null),
    issues: (args: ConnectionArgs) =>
      connect(
        commands.listIssues({ project: project.id, includeArchived: true }),
        args,
        formatIssue,
        `project:${project.id}:issues`
      ),
  });

  const formatCycle = (cycle: LinearCycle) => ({
    id: cycle.id,
    name: cycle.name,
    number: cycle.number,
    startsAt: cycle.startsAt,
    endsAt: cycle.endsAt,
    createdAt: cycle.createdAt,
    updatedAt: cycle.updatedAt,
    team: () => formatTeam(commands.requireTeam(cycle.teamId)),
    issues: (args: ConnectionArgs) =>
      connect(
        commands.listIssues({ cycle: cycle.id, includeArchived: true }),
        args,
        formatIssue,
        `cycle:${cycle.id}:issues`
      ),
  });

  const formatComment = (comment: LinearComment) => ({
    ...commentGraphqlScalars(comment),
    issue: () => formatIssue(commands.requireIssue(comment.issueId)),
    parent: () => (comment.parentId ? formatComment(commands.requireComment(comment.parentId)) : null),
    user: () => (comment.userId ? formatUser(commands.requireUser(comment.userId)) : null),
  });

  const formatWebhook = (webhook: LinearWebhook) => ({
    id: webhook.id,
    label: webhook.label,
    url: webhook.url,
    enabled: webhook.enabled,
    resourceTypes: webhook.resourceTypes,
    allPublicTeams: webhook.allPublicTeams,
    // Real Linear returns the signing secret only in the create response, never
    // on subsequent reads. Do not leak seeded/stored secrets via queries.
    secret: null,
    createdAt: webhook.createdAt,
    updatedAt: webhook.updatedAt,
    team: () => (webhook.teamId ? formatTeam(commands.requireTeam(webhook.teamId)) : null),
  });

  const formatAgentSession = (session: LinearAgentSession) => ({
    id: session.id,
    state: session.state,
    plan: session.plan,
    externalUrl: session.externalUrl,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    issue: () => (session.issueId ? formatIssue(commands.requireIssue(session.issueId)) : null),
    comment: () => (session.commentId ? formatComment(commands.requireComment(session.commentId)) : null),
    agentUser: () => formatUser(commands.requireUser(session.agentUserId)),
    activities: (args: ConnectionArgs) =>
      connect(
        commands.listAgentActivities(session.id),
        args,
        formatAgentActivity,
        `agentSession:${session.id}:activities`
      ),
  });

  const formatAgentActivity = (activity: LinearAgentActivity) => ({
    id: activity.id,
    type: activity.type,
    body: activity.body,
    ephemeral: activity.ephemeral,
    createdAt: activity.createdAt,
    updatedAt: activity.updatedAt,
    session: () => formatAgentSession(commands.requireAgentSession(activity.sessionId)),
    user: () => (activity.userId ? formatUser(commands.requireUser(activity.userId)) : null),
  });

  function formatIssue(issue: LinearIssue) {
    return {
      ...issueGraphqlScalars(issue),
      team: () => formatTeam(commands.requireTeam(issue.teamId)),
      state: () => formatState(commands.requireState(issue.stateId)),
      assignee: () => (issue.assigneeId ? formatUser(commands.requireUser(issue.assigneeId)) : null),
      creator: () => (issue.creatorId ? formatUser(commands.requireUser(issue.creatorId)) : null),
      delegate: () => (issue.delegateId ? formatUser(commands.requireUser(issue.delegateId)) : null),
      labels: (args: ConnectionArgs) =>
        connect(
          issue.labelIds.map((id) => commands.requireLabel(id)),
          args,
          formatLabel,
          `issue:${issue.id}:labels`
        ),
      comments: (args: ConnectionArgs) =>
        connect(commands.listComments(issue.id), args, formatComment, `issue:${issue.id}:comments`),
      parent: () => (issue.parentId ? formatIssue(commands.requireIssue(issue.parentId)) : null),
      project: () => (issue.projectId ? formatProject(commands.requireProject(issue.projectId)) : null),
      cycle: () => (issue.cycleId ? formatCycle(commands.requireCycle(issue.cycleId)) : null),
    };
  }

  return {
    connect,
    formatUser,
    formatState,
    formatTeam,
    formatLabel,
    formatProject,
    formatCycle,
    formatComment,
    formatWebhook,
    formatAgentSession,
    formatAgentActivity,
    formatIssue,
  };
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}
