// SPDX-License-Identifier: Apache-2.0
import type { LinearDomain, ActorContext } from "../domain/index.js";
import type { ConnectionArgs } from "../pagination.js";
import { createFormatters } from "./formatters.js";
import { filterIssues, filterUsers } from "./issue-filter.js";
import {
  parseAgentActivityCreateInput,
  parseAgentSessionOnCommentInput,
  parseAgentSessionOnIssueInput,
  parseAgentSessionUpdateInput,
  parseCommentCreateInput,
  parseCommentUpdateInput,
  parseIssueCreateInput,
  parseIssueLabelCreateInput,
  parseIssueLabelUpdateInput,
  parseIssueUpdateInput,
  parseWebhookCreateInput,
} from "./mutation-inputs.js";

export type GraphQLRuntimeContext = {
  commands: LinearDomain;
  actor: ActorContext;
};

export function createRootValue(ctx: GraphQLRuntimeContext): Record<string, unknown> {
  const { commands, actor } = ctx;
  const {
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
  } = createFormatters(commands, actor);

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

    issueCreate: async ({ input }: { input: unknown }) => {
      const issue = await commands.createIssue(parseIssueCreateInput(input), actor);
      return payload({ issue: formatIssue(issue) });
    },
    issueUpdate: async ({ id, input }: { id?: string; input: unknown }) => {
      const parsed = parseIssueUpdateInput(input);
      const issue = await commands.updateIssue(String(id ?? parsed.id), parsed.patch, actor);
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
    commentCreate: async ({ input }: { input: unknown }) => {
      const comment = await commands.createComment(parseCommentCreateInput(input), actor);
      return payload({ comment: formatComment(comment) });
    },
    commentUpdate: async ({ id, input }: { id?: string; input: unknown }) => {
      const parsed = parseCommentUpdateInput(input);
      const comment = await commands.updateComment(String(id ?? parsed.id), parsed.body, actor);
      return payload({ comment: formatComment(comment) });
    },
    commentDelete: async ({ id }: { id: string }) => {
      const entityId = await commands.deleteComment(id, actor);
      return payload({ entityId });
    },
    issueLabelCreate: async ({ input }: { input: unknown }) => {
      const label = await commands.createLabel(parseIssueLabelCreateInput(input), actor);
      return payload({ issueLabel: formatLabel(label) });
    },
    issueLabelUpdate: async ({ id, input }: { id?: string; input: unknown }) => {
      const parsed = parseIssueLabelUpdateInput(input);
      const label = await commands.updateLabel(
        String(id ?? parsed.id),
        {
          name: parsed.name,
          color: parsed.color,
          description: parsed.description,
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
    webhookCreate: ({ input }: { input: unknown }) => {
      const webhook = commands.createWebhook(parseWebhookCreateInput(input), actor);
      return payload({ webhook: formatWebhook(webhook) });
    },
    webhookDelete: ({ id }: { id: string }) =>
      payload({ entityId: commands.deleteWebhook(id, actor) }),
    agentSessionCreateOnIssue: async ({ input }: { input: unknown }) => {
      const session = await commands.createAgentSessionOnIssue(parseAgentSessionOnIssueInput(input), actor);
      return payload({ agentSession: formatAgentSession(session) });
    },
    agentSessionCreateOnComment: async ({ input }: { input: unknown }) => {
      const session = await commands.createAgentSessionOnComment(
        parseAgentSessionOnCommentInput(input),
        actor
      );
      return payload({ agentSession: formatAgentSession(session) });
    },
    agentSessionUpdate: ({ id, input }: { id?: string; input: unknown }) => {
      const parsed = parseAgentSessionUpdateInput(input);
      const session = commands.updateAgentSession(
        String(id ?? parsed.id),
        {
          state: parsed.state,
          plan: parsed.plan,
          externalUrl: parsed.externalUrl,
        },
        actor
      );
      return payload({ agentSession: formatAgentSession(session) });
    },
    agentActivityCreate: async ({ input }: { input: unknown }) => {
      const activity = await commands.createAgentActivity(parseAgentActivityCreateInput(input), actor);
      return payload({ agentActivity: formatAgentActivity(activity) });
    },
  };
}
