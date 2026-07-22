// file-size: GraphQL root resolvers mirror Linear's nested connection shape; splitting would duplicate formatters.
// SPDX-License-Identifier: Apache-2.0
import type { LinearCommands, ActorContext } from "../commands/index.js";
import { connectionFromArray, type ConnectionArgs } from "../pagination.js";
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

export type GraphQLRuntimeContext = {
  commands: LinearCommands;
  actor: ActorContext;
};

export function createRootValue(ctx: GraphQLRuntimeContext): Record<string, unknown> {
  const { commands, actor } = ctx;
  const connect = <T, U>(items: T[], args: ConnectionArgs, map: (item: T) => U, binding: string) => {
    const page = connectionFromArray(items, args, binding);
    // Map each node once; edges share the mapped node (page.nodes and page.edges
    // are the same slice in the same order).
    const nodes = page.nodes.map(map);
    return {
      nodes,
      edges: page.edges.map((edge, i) => ({ cursor: edge.cursor, node: nodes[i] })),
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
    // Deferred: a full issues scan only runs when the field is actually selected.
    createdIssueCount: () =>
      commands.listIssues({ includeArchived: true }).filter((i) => i.creatorId === user.id).length,
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
        commands.listIssues({ includeArchived: true }).filter((i) => i.assigneeId === user.id),
        args,
        formatIssue,
        `user:${user.id}:assigned`
      ),
    createdIssues: (args: ConnectionArgs) =>
      connect(
        commands.listIssues({ includeArchived: true }).filter((i) => i.creatorId === user.id),
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
    team: () => formatTeam(commands.getTeam(state.teamId)!),
    issues: (args: ConnectionArgs) =>
      connect(
        commands.listIssues({ includeArchived: true }).filter((i) => i.stateId === state.id),
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
      issueCount: () => commands.listIssues({ team: team.id, includeArchived: true }).length,
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
    team: () => (label.teamId ? formatTeam(commands.getTeam(label.teamId)!) : null),
    issues: (args: ConnectionArgs) =>
      connect(
        commands.listIssues({ includeArchived: true }).filter((i) => i.labelIds.includes(label.id)),
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
    team: () => (project.teamId ? formatTeam(commands.getTeam(project.teamId)!) : null),
    issues: (args: ConnectionArgs) =>
      connect(
        commands.listIssues({ includeArchived: true }).filter((i) => i.projectId === project.id),
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
    team: () => formatTeam(commands.getTeam(cycle.teamId)!),
    issues: (args: ConnectionArgs) =>
      connect(
        commands.listIssues({ includeArchived: true }).filter((i) => i.cycleId === cycle.id),
        args,
        formatIssue,
        `cycle:${cycle.id}:issues`
      ),
  });

  const formatComment = (comment: LinearComment) => ({
    id: comment.id,
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    createAsUser: comment.createAsUser,
    displayIconUrl: comment.displayIconUrl,
    issue: () => formatIssue(commands.getIssue(comment.issueId)!),
    user: () => (comment.userId ? formatUser(commands.getUser(comment.userId)!) : null),
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
    team: () => (webhook.teamId ? formatTeam(commands.getTeam(webhook.teamId)!) : null),
  });

  const formatAgentSession = (session: LinearAgentSession) => ({
    id: session.id,
    state: session.state,
    plan: session.plan,
    externalUrl: session.externalUrl,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    issue: () => (session.issueId ? formatIssue(commands.getIssue(session.issueId)!) : null),
    comment: () => (session.commentId ? formatComment(commands.getComment(session.commentId)!) : null),
    agentUser: () => formatUser(commands.getUser(session.agentUserId)!),
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
    session: () => formatAgentSession(commands.getAgentSession(activity.sessionId)!),
    user: () => (activity.userId ? formatUser(commands.getUser(activity.userId)!) : null),
  });

  function formatIssue(issue: LinearIssue) {
    return {
      id: issue.id,
      identifier: issue.identifier,
      number: issue.number,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      url: issue.url,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      archivedAt: issue.archivedAt,
      canceledAt: issue.canceledAt,
      completedAt: issue.completedAt,
      startedAt: issue.startedAt,
      dueDate: issue.dueDate,
      trashed: false,
      createAsUser: issue.createAsUser,
      displayIconUrl: issue.displayIconUrl,
      team: () => formatTeam(commands.getTeam(issue.teamId)!),
      state: () => formatState(commands.getWorkflowState(issue.stateId)!),
      assignee: () => (issue.assigneeId ? formatUser(commands.getUser(issue.assigneeId)!) : null),
      creator: () => (issue.creatorId ? formatUser(commands.getUser(issue.creatorId)!) : null),
      delegate: () => (issue.delegateId ? formatUser(commands.getUser(issue.delegateId)!) : null),
      labels: (args: ConnectionArgs) =>
        connect(
          issue.labelIds.map((id) => commands.getLabel(id)!).filter(Boolean),
          args,
          formatLabel,
          `issue:${issue.id}:labels`
        ),
      comments: (args: ConnectionArgs) =>
        connect(commands.listComments(issue.id), args, formatComment, `issue:${issue.id}:comments`),
      project: () => (issue.projectId ? formatProject(commands.getProject(issue.projectId)!) : null),
      cycle: () => (issue.cycleId ? formatCycle(commands.getCycle(issue.cycleId)!) : null),
    };
  }

  const payload = <T extends Record<string, unknown>>(value: T) => ({
    success: true,
    lastSyncId: Date.parse(commands.now()),
    ...value,
  });

  return {
    viewer: () => formatUser(commands.resolveViewer(actor)),
    organization: () => {
      const org = commands.getOrganization();
      if (!org) throw new Error("Linear organization has not been seeded");
      return {
        id: org.id,
        name: org.name,
        urlKey: org.urlKey,
        url: org.url,
        createdAt: org.createdAt,
        updatedAt: org.updatedAt,
        users: (args: ConnectionArgs) => connect(commands.listUsers(), args, formatUser, "org:users"),
        teams: (args: ConnectionArgs) => connect(commands.listTeams(), args, formatTeam, "org:teams"),
      };
    },
    users: (args: ConnectionArgs & { filter?: Record<string, unknown> }) =>
      connect(filterUsers(commands.listUsers(), args.filter), args, formatUser, "users"),
    user: ({ id }: { id: string }) => {
      const user = commands.getUser(id);
      return user ? formatUser(user) : null;
    },
    teams: (args: ConnectionArgs) => connect(commands.listTeams(), args, formatTeam, "teams"),
    team: ({ id }: { id: string }) => {
      const team = commands.getTeam(id);
      return team ? formatTeam(team) : null;
    },
    workflowStates: (args: ConnectionArgs) =>
      connect(commands.listWorkflowStates(), args, formatState, "workflowStates"),
    workflowState: ({ id }: { id: string }) => {
      const state = commands.getWorkflowState(id);
      return state ? formatState(state) : null;
    },
    issues: (args: ConnectionArgs & { filter?: Record<string, unknown> }) =>
      connect(filterIssues(commands, args.filter), args, formatIssue, "issues"),
    issue: ({ id }: { id: string }) => {
      const issue = commands.getIssue(id);
      return issue ? formatIssue(issue) : null;
    },
    comments: (args: ConnectionArgs) => connect(commands.listComments(), args, formatComment, "comments"),
    comment: ({ id }: { id: string }) => {
      const comment = commands.getComment(id);
      return comment ? formatComment(comment) : null;
    },
    issueLabels: (args: ConnectionArgs) => connect(commands.listLabels(), args, formatLabel, "issueLabels"),
    issueLabel: ({ id }: { id: string }) => {
      const label = commands.getLabel(id);
      return label ? formatLabel(label) : null;
    },
    projects: (args: ConnectionArgs) => connect(commands.listProjects(), args, formatProject, "projects"),
    project: ({ id }: { id: string }) => {
      const project = commands.getProject(id);
      return project ? formatProject(project) : null;
    },
    cycles: (args: ConnectionArgs) => {
      const all = commands.listTeams().flatMap((team) => commands.listCycles(team.id));
      return connect(all, args, formatCycle, "cycles");
    },
    cycle: ({ id }: { id: string }) => {
      const cycle = commands.getCycle(id);
      return cycle ? formatCycle(cycle) : null;
    },
    webhooks: (args: ConnectionArgs) => connect(commands.listWebhooks(), args, formatWebhook, "webhooks"),
    webhook: ({ id }: { id: string }) => {
      const webhook = commands.getWebhook(id);
      return webhook ? formatWebhook(webhook) : null;
    },
    agentSessions: (args: ConnectionArgs) =>
      connect(commands.listAgentSessions(), args, formatAgentSession, "agentSessions"),
    agentSession: ({ id }: { id: string }) => {
      const session = commands.getAgentSession(id);
      return session ? formatAgentSession(session) : null;
    },

    issueCreate: async ({ input }: { input: Record<string, unknown> }) => {
      const issue = await commands.createIssue(
        {
          teamId: String(input.teamId),
          title: String(input.title),
          description: (input.description as string | null | undefined) ?? null,
          priority: input.priority as number | undefined,
          stateId: (input.stateId as string | undefined) ?? null,
          assigneeId: (input.assigneeId as string | undefined) ?? null,
          delegateId: (input.delegateId as string | undefined) ?? null,
          labelIds: (input.labelIds as string[] | undefined) ?? null,
          projectId: (input.projectId as string | undefined) ?? null,
          cycleId: (input.cycleId as string | undefined) ?? null,
          createAsUser: (input.createAsUser as string | undefined) ?? null,
          displayIconUrl: (input.displayIconUrl as string | undefined) ?? null,
          dueDate: (input.dueDate as string | undefined) ?? null,
        },
        actor
      );
      return payload({ issue: formatIssue(issue) });
    },
    issueUpdate: async ({ id, input }: { id?: string; input: Record<string, unknown> }) => {
      const issue = await commands.updateIssue(String(id ?? input.id), {
        title: input.title as string | undefined,
        description: "description" in input ? ((input.description as string | null) ?? null) : undefined,
        priority: input.priority as number | undefined,
        stateId: "stateId" in input ? ((input.stateId as string | null) ?? null) : undefined,
        assigneeId: "assigneeId" in input ? ((input.assigneeId as string | null) ?? null) : undefined,
        delegateId: "delegateId" in input ? ((input.delegateId as string | null) ?? null) : undefined,
        labelIds: "labelIds" in input ? ((input.labelIds as string[]) ?? []) : undefined,
        projectId: "projectId" in input ? ((input.projectId as string | null) ?? null) : undefined,
        cycleId: "cycleId" in input ? ((input.cycleId as string | null) ?? null) : undefined,
        archivedAt: "archivedAt" in input ? ((input.archivedAt as string | null) ?? null) : undefined,
        dueDate: "dueDate" in input ? ((input.dueDate as string | null) ?? null) : undefined,
      }, actor);
      return payload({ issue: formatIssue(issue) });
    },
    issueDelete: async ({ id }: { id: string }) => {
      const issue = await commands.deleteIssue(id, actor);
      return payload({ entity: formatIssue(issue) });
    },
    issueArchive: async ({ id }: { id: string }) => {
      const issue = await commands.archiveIssue(id, actor);
      return payload({ entity: formatIssue(issue) });
    },
    issueUnarchive: async ({ id }: { id: string }) => {
      const issue = await commands.unarchiveIssue(id, actor);
      return payload({ entity: formatIssue(issue) });
    },
    commentCreate: async ({ input }: { input: Record<string, unknown> }) => {
      const comment = await commands.createComment(
        {
          issueId: String(input.issueId),
          body: String(input.body),
          createAsUser: (input.createAsUser as string | undefined) ?? null,
          displayIconUrl: (input.displayIconUrl as string | undefined) ?? null,
        },
        actor
      );
      return payload({ comment: formatComment(comment) });
    },
    commentUpdate: async ({ id, input }: { id?: string; input: Record<string, unknown> }) => {
      const comment = await commands.updateComment(String(id ?? input.id), String(input.body), actor);
      return payload({ comment: formatComment(comment) });
    },
    commentDelete: async ({ id }: { id: string }) => {
      const entityId = await commands.deleteComment(id, actor);
      return payload({ entityId });
    },
    issueLabelCreate: async ({ input }: { input: Record<string, unknown> }) => {
      const label = await commands.createLabel(
        {
          name: String(input.name),
          color: input.color as string | undefined,
          description: (input.description as string | undefined) ?? null,
          teamId: (input.teamId as string | undefined) ?? null,
        },
        actor
      );
      return payload({ issueLabel: formatLabel(label) });
    },
    issueLabelUpdate: async ({ id, input }: { id?: string; input: Record<string, unknown> }) => {
      const label = await commands.updateLabel(
        String(id ?? input.id),
        {
          name: input.name as string | undefined,
          color: input.color as string | undefined,
          description: "description" in input ? ((input.description as string | null) ?? null) : undefined,
        },
        actor
      );
      return payload({ issueLabel: formatLabel(label) });
    },
    issueLabelDelete: async ({ id }: { id: string }) => {
      const entityId = await commands.deleteLabel(id, actor);
      return payload({ entityId });
    },
    issueAddLabel: async ({ id, labelId }: { id: string; labelId: string }) => {
      const issue = await commands.addIssueLabel(id, labelId, actor);
      return payload({ issue: formatIssue(issue) });
    },
    issueRemoveLabel: async ({ id, labelId }: { id: string; labelId: string }) => {
      const issue = await commands.removeIssueLabel(id, labelId, actor);
      return payload({ issue: formatIssue(issue) });
    },
    webhookCreate: ({ input }: { input: Record<string, unknown> }) => {
      const webhook = commands.createWebhook(
        {
          url: String(input.url),
          label: input.label as string | undefined,
          resourceTypes: input.resourceTypes as string[] | undefined,
          teamId: (input.teamId as string | undefined) ?? null,
          allPublicTeams: input.allPublicTeams as boolean | undefined,
          secret: (input.secret as string | undefined) ?? null,
          enabled: input.enabled as boolean | undefined,
        },
        actor
      );
      return payload({ webhook: formatWebhook(webhook) });
    },
    webhookDelete: ({ id }: { id: string }) =>
      payload({ entityId: commands.deleteWebhook(id, actor) }),
    agentSessionCreateOnIssue: async ({ input }: { input: Record<string, unknown> }) => {
      const session = await commands.createAgentSessionOnIssue(
        {
          issueId: String(input.issueId),
          agentUserId: input.agentUserId as string | undefined,
          plan: (input.plan as string | undefined) ?? null,
          externalUrl: (input.externalUrl as string | undefined) ?? null,
        },
        actor
      );
      return payload({ agentSession: formatAgentSession(session) });
    },
    agentSessionCreateOnComment: async ({ input }: { input: Record<string, unknown> }) => {
      const session = await commands.createAgentSessionOnComment(
        {
          commentId: String(input.commentId),
          agentUserId: input.agentUserId as string | undefined,
          plan: (input.plan as string | undefined) ?? null,
          externalUrl: (input.externalUrl as string | undefined) ?? null,
        },
        actor
      );
      return payload({ agentSession: formatAgentSession(session) });
    },
    agentSessionUpdate: ({ id, input }: { id?: string; input: Record<string, unknown> }) => {
      const session = commands.updateAgentSession(
        String(id ?? input.id),
        {
          state: input.state as string | undefined,
          plan: "plan" in input ? ((input.plan as string | null) ?? null) : undefined,
          externalUrl: "externalUrl" in input ? ((input.externalUrl as string | null) ?? null) : undefined,
        },
        actor
      );
      return payload({ agentSession: formatAgentSession(session) });
    },
    agentActivityCreate: async ({ input }: { input: Record<string, unknown> }) => {
      const activity = await commands.createAgentActivity(
        {
          sessionId: String(input.sessionId),
          type: String(input.type),
          body: String(input.body),
          ephemeral: input.ephemeral as boolean | undefined,
        },
        actor
      );
      return payload({ agentActivity: formatAgentActivity(activity) });
    },
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

function filterUsers(users: LinearUser[], filter?: Record<string, unknown>): LinearUser[] {
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

function filterIssues(commands: LinearCommands, filter?: Record<string, unknown>): LinearIssue[] {
  // Match team.issues and Linear's default: archived issues are hidden unless asked for.
  const issues = commands.listIssues({ includeArchived: false });
  if (!filter) return issues;
  return issues.filter((issue) => issueMatches(commands, issue, filter));
}

function issueMatches(
  commands: LinearCommands,
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

function matchStringComparator(value: string, comparator: unknown): boolean {
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
