// file-size: Linear MCP tool surface — one registry of tool defs + handlers pending further split.
// SPDX-License-Identifier: Apache-2.0
// file-size: MCP launch tool table co-located with canonical fixture mapping.
import type { ToolCallContext, ToolSpec } from "@pome-sh/sdk";
import type { z } from "zod";
import canonicalListing from "../fixtures/mcp-tools-list.canonical.json" with { type: "json" };
import type { LinearDomain } from "./domain/index.js";
import { badUserInput, notFound } from "./errors.js";
import { actorFromToolContext } from "./identity.js";
import {
  createIssueLabelSchema,
  deleteCommentSchema,
  getDocumentSchema,
  getIssueSchema,
  getIssueStatusSchema,
  getProjectSchema,
  getTeamSchema,
  getUserSchema,
  listCommentsSchema,
  listCyclesSchema,
  listDocumentsSchema,
  listIssueLabelsSchema,
  listIssueStatusesSchema,
  listIssuesSchema,
  listProjectsSchema,
  listTeamsSchema,
  listUsersSchema,
  saveCommentSchema,
  saveDocumentSchema,
  saveIssueSchema,
  saveProjectSchema,
  searchDocumentationSchema,
} from "./mcp-schemas.js";
import { mcpPage } from "./pagination.js";
import { serializeCommentMcp, serializeDocumentMcp, serializeIssueMcp } from "./serializers/index.js";
import { linearStateDelta } from "./state.js";
import {
  DEFAULT_LINEAR_EMAIL,
  MCP_PAGE_DEFAULT,
  type LinearProjectState,
} from "./types.js";

type CanonicalTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const canonicalTools = canonicalListing.result.tools as CanonicalTool[];

function mutate<T>(domain: LinearDomain, ctx: ToolCallContext, op: () => T | Promise<T>): Promise<T> | T {
  const before = domain.exportState();
  const result = op();
  if (result instanceof Promise) {
    return result.then((value) => {
      ctx.reportDelta(linearStateDelta(before, domain.exportState()));
      return value;
    });
  }
  ctx.reportDelta(linearStateDelta(before, domain.exportState()));
  return result;
}

function resolveAssignee(domain: LinearDomain, ref: string | undefined, ctx: ToolCallContext): string | undefined {
  if (!ref) return undefined;
  if (ref === "me") {
    return actorFromToolContext(ctx).email ?? DEFAULT_LINEAR_EMAIL;
  }
  return ref;
}

function pagedList<T>(
  items: T[],
  args: { limit?: unknown; cursor?: unknown },
  key: string
): { items: T[]; cursor?: string } {
  const page = mcpPage(
    items,
    (args.limit as number | undefined) ?? MCP_PAGE_DEFAULT,
    args.cursor as string | undefined,
    key
  );
  return { items: page.items as T[], ...(page.cursor ? { cursor: page.cursor } : {}) };
}

type ToolImpl = {
  schema: z.ZodType;
  mutation: boolean;
  handler: (domain: LinearDomain, args: Record<string, unknown>, ctx: ToolCallContext) => unknown;
};

const implementations: Record<string, ToolImpl> = {
  list_issues: {
    schema: listIssuesSchema,
    mutation: false,
    handler: (domain, args, ctx) => {
      const assignee = resolveAssignee(domain, args.assignee as string | undefined, ctx);
      const issues = domain.listIssues({
        team: args.team as string | undefined,
        assignee,
        state: args.state as string | undefined,
        query: args.query as string | undefined,
      });
      const page = pagedList(
        issues.map((issue) => serializeIssueMcp(issue, domain)),
        args,
        `list_issues:${args.team ?? ""}:${assignee ?? ""}:${args.state ?? ""}:${args.query ?? ""}`
      );
      return { issues: page.items, ...(page.cursor ? { cursor: page.cursor } : {}) };
    },
  },
  get_issue: {
    schema: getIssueSchema,
    mutation: false,
    handler: (domain, args) => {
      const issue = domain.getIssue(String(args.id));
      if (!issue) notFound(`Issue not found: ${args.id}`);
      return serializeIssueMcp(issue, domain);
    },
  },
  save_issue: {
    schema: saveIssueSchema,
    mutation: true,
    handler: (domain, args, ctx) =>
      mutate(domain, ctx, async () => {
        if (args.id) {
          const issue = await domain.updateIssue(
            String(args.id),
            {
              title: args.title as string | undefined,
              description: "description" in args ? ((args.description as string | null) ?? null) : undefined,
              assigneeId:
                "assignee" in args
                  ? (resolveAssignee(domain, args.assignee as string | undefined, ctx) ?? null)
                  : undefined,
              stateId: "state" in args ? ((args.state as string | null) ?? null) : undefined,
              priority: args.priority as number | undefined,
              estimate: "estimate" in args ? ((args.estimate as number | null) ?? null) : undefined,
              labelIds: "labels" in args ? ((args.labels as string[]) ?? []) : undefined,
              projectId: "project" in args ? ((args.project as string | null) ?? null) : undefined,
              cycleId: "cycle" in args ? ((args.cycle as string | null) ?? null) : undefined,
              parentId: "parentId" in args ? ((args.parentId as string | null) ?? null) : undefined,
              blocks: args.blocks as string[] | undefined,
              blockedBy: args.blockedBy as string[] | undefined,
              relatedTo: args.relatedTo as string[] | undefined,
            },
            actorFromToolContext(ctx)
          );
          return serializeIssueMcp(issue, domain);
        }
        if (!args.title || !args.team) {
          badUserInput("title and team are required when creating an issue (omit id)");
        }
        const team = domain.getTeam(String(args.team));
        if (!team) notFound(`Team not found: ${args.team}`);
        const issue = await domain.createIssue(
          {
            teamId: team.id,
            title: String(args.title),
            description: (args.description as string | undefined) ?? null,
            assigneeId: resolveAssignee(domain, args.assignee as string | undefined, ctx) ?? null,
            stateId: (args.state as string | undefined) ?? null,
            priority: args.priority as number | undefined,
            estimate: "estimate" in args ? ((args.estimate as number | null) ?? null) : undefined,
            labelIds: (args.labels as string[] | undefined) ?? null,
            projectId: (args.project as string | undefined) ?? null,
            cycleId: (args.cycle as string | undefined) ?? null,
            parentId: (args.parentId as string | undefined) ?? null,
            blocks: args.blocks as string[] | undefined,
            blockedBy: args.blockedBy as string[] | undefined,
            relatedTo: args.relatedTo as string[] | undefined,
          },
          actorFromToolContext(ctx)
        );
        return serializeIssueMcp(issue, domain);
      }),
  },
  list_comments: {
    schema: listCommentsSchema,
    mutation: false,
    handler: (domain, args) => {
      const comments = domain.listComments(String(args.issueId)).map(serializeCommentMcp);
      const page = pagedList(comments, args, `list_comments:${args.issueId}`);
      return { comments: page.items, ...(page.cursor ? { cursor: page.cursor } : {}) };
    },
  },
  save_comment: {
    schema: saveCommentSchema,
    mutation: true,
    handler: (domain, args, ctx) =>
      mutate(domain, ctx, async () => {
        if (args.id) {
          const comment = await domain.updateComment(
            String(args.id),
            String(args.body),
            actorFromToolContext(ctx)
          );
          return serializeCommentMcp(comment);
        }
        if (!args.issueId && !args.parentId) {
          badUserInput("issueId or parentId is required when creating a comment");
        }
        const comment = await domain.createComment(
          {
            issueId: args.issueId ? String(args.issueId) : undefined,
            parentId: args.parentId ? String(args.parentId) : null,
            body: String(args.body),
          },
          actorFromToolContext(ctx)
        );
        return serializeCommentMcp(comment);
      }),
  },
  delete_comment: {
    schema: deleteCommentSchema,
    mutation: true,
    handler: (domain, args, ctx) =>
      mutate(domain, ctx, async () => {
        const id = await domain.deleteComment(String(args.id), actorFromToolContext(ctx));
        return { success: true, id };
      }),
  },
  list_teams: {
    schema: listTeamsSchema,
    mutation: false,
    handler: (domain, args) => {
      const teams = domain.listTeams().map((team) => ({
        id: team.id,
        key: team.key,
        name: team.name,
        description: team.description,
      }));
      const page = pagedList(teams, args, "list_teams");
      return { teams: page.items, ...(page.cursor ? { cursor: page.cursor } : {}) };
    },
  },
  get_team: {
    schema: getTeamSchema,
    mutation: false,
    handler: (domain, args) => {
      const team = domain.getTeam(String(args.query));
      if (!team) notFound(`Team not found: ${args.query}`);
      return { id: team.id, key: team.key, name: team.name, description: team.description, url: team.url };
    },
  },
  list_users: {
    schema: listUsersSchema,
    mutation: false,
    handler: (domain, args) => {
      const users = domain.listUsers().map((user) => ({
        id: user.id,
        name: user.name,
        displayName: user.displayName,
        email: user.email,
        admin: user.admin,
        app: user.app,
      }));
      const page = pagedList(users, args, "list_users");
      return { users: page.items, ...(page.cursor ? { cursor: page.cursor } : {}) };
    },
  },
  get_user: {
    schema: getUserSchema,
    mutation: false,
    handler: (domain, args) => {
      const user = domain.getUser(String(args.query));
      if (!user) notFound(`User not found: ${args.query}`);
      return {
        id: user.id,
        name: user.name,
        displayName: user.displayName,
        email: user.email,
        admin: user.admin,
        app: user.app,
      };
    },
  },
  list_issue_statuses: {
    schema: listIssueStatusesSchema,
    mutation: false,
    handler: (domain, args) => ({
      statuses: domain.listWorkflowStates(String(args.team)).map((state) => ({
        id: state.id,
        name: state.name,
        type: state.type,
        position: state.position,
      })),
    }),
  },
  get_issue_status: {
    schema: getIssueStatusSchema,
    mutation: false,
    handler: (domain, args) => {
      const ref = (args.id as string | undefined) ?? (args.name as string | undefined);
      if (!ref) badUserInput("id or name is required");
      const state = domain.getWorkflowState(ref, args.team as string | undefined);
      if (!state) notFound(`Issue status not found: ${ref}`);
      return { id: state.id, name: state.name, type: state.type, position: state.position, teamId: state.teamId };
    },
  },
  list_issue_labels: {
    schema: listIssueLabelsSchema,
    mutation: false,
    handler: (domain, args) => {
      const labels = domain.listLabels(args.team as string | undefined).map((label) => ({
        id: label.id,
        name: label.name,
        color: label.color,
        description: label.description,
        teamId: label.teamId,
      }));
      const page = pagedList(labels, args, `list_issue_labels:${args.team ?? ""}`);
      return { labels: page.items, ...(page.cursor ? { cursor: page.cursor } : {}) };
    },
  },
  create_issue_label: {
    schema: createIssueLabelSchema,
    mutation: true,
    handler: (domain, args, ctx) =>
      mutate(domain, ctx, async () => {
        const label = await domain.createLabel(
          {
            name: String(args.name),
            color: args.color as string | undefined,
            description: (args.description as string | undefined) ?? null,
            teamId: (args.team as string | undefined) ?? null,
          },
          actorFromToolContext(ctx)
        );
        return {
          id: label.id,
          name: label.name,
          color: label.color,
          description: label.description,
          teamId: label.teamId,
        };
      }),
  },
  list_projects: {
    schema: listProjectsSchema,
    mutation: false,
    handler: (domain, args) => {
      const projects = domain.listProjects(args.team as string | undefined).map((project) => ({
        id: project.id,
        name: project.name,
        description: project.description,
        state: project.state,
        teamId: project.teamId,
      }));
      const page = pagedList(projects, args, `list_projects:${args.team ?? ""}`);
      return { projects: page.items, ...(page.cursor ? { cursor: page.cursor } : {}) };
    },
  },
  get_project: {
    schema: getProjectSchema,
    mutation: false,
    handler: (domain, args) => {
      const project = domain.getProject(String(args.query));
      if (!project) notFound(`Project not found: ${args.query}`);
      return {
        id: project.id,
        name: project.name,
        description: project.description,
        state: project.state,
        teamId: project.teamId,
      };
    },
  },
  save_project: {
    schema: saveProjectSchema,
    mutation: true,
    handler: (domain, args, ctx) =>
      mutate(domain, ctx, () => {
        const actor = actorFromToolContext(ctx);
        if (args.id) {
          const project = domain.updateProject(
            String(args.id),
            {
              name: args.name as string | undefined,
              description: "description" in args ? ((args.description as string | null) ?? null) : undefined,
              state: args.state as LinearProjectState | undefined,
            },
            actor
          );
          return {
            id: project.id,
            name: project.name,
            description: project.description,
            state: project.state,
            teamId: project.teamId,
          };
        }
        if (!args.name) badUserInput("name is required when creating a project (omit id)");
        const project = domain.createProject(
          {
            name: String(args.name),
            teamId: (args.team as string | undefined) ?? null,
            description: (args.description as string | undefined) ?? null,
            state: (args.state as LinearProjectState | undefined) ?? "planned",
          },
          actor
        );
        return {
          id: project.id,
          name: project.name,
          description: project.description,
          state: project.state,
          teamId: project.teamId,
        };
      }),
  },
  list_cycles: {
    schema: listCyclesSchema,
    mutation: false,
    handler: (domain, args) => {
      const cycles = domain.listCycles(String(args.teamId)).map((cycle) => ({
        id: cycle.id,
        name: cycle.name,
        number: cycle.number,
        startsAt: cycle.startsAt,
        endsAt: cycle.endsAt,
        teamId: cycle.teamId,
      }));
      const page = pagedList(cycles, args, `list_cycles:${args.teamId}`);
      return { cycles: page.items, ...(page.cursor ? { cursor: page.cursor } : {}) };
    },
  },
  search_documentation: {
    schema: searchDocumentationSchema,
    mutation: false,
    handler: (_domain, args) => ({
      query: String(args.query),
      results: [] as Array<{ title: string; url: string; snippet: string }>,
      note: "Linear twin documentation search returns an empty static result set.",
    }),
  },
  list_documents: {
    schema: listDocumentsSchema,
    mutation: false,
    handler: (domain, args) => {
      const documents = domain
        .listDocuments({
          projectId: args.projectId as string | undefined,
          teamId: args.teamId as string | undefined,
          query: args.query as string | undefined,
        })
        .map(serializeDocumentMcp);
      const page = pagedList(
        documents,
        args,
        `list_documents:${args.projectId ?? ""}:${args.teamId ?? ""}:${args.query ?? ""}`
      );
      return { documents: page.items, ...(page.cursor ? { cursor: page.cursor } : {}) };
    },
  },
  get_document: {
    schema: getDocumentSchema,
    mutation: false,
    handler: (domain, args) => {
      const doc = domain.getDocument(String(args.id));
      if (!doc) notFound(`Document not found: ${args.id}`);
      return serializeDocumentMcp(doc);
    },
  },
  save_document: {
    schema: saveDocumentSchema,
    mutation: true,
    handler: (domain, args, ctx) =>
      mutate(domain, ctx, () => {
        const actor = actorFromToolContext(ctx);
        if (args.id) {
          return serializeDocumentMcp(
            domain.updateDocument(
              String(args.id),
              {
                title: args.title as string | undefined,
                content: "content" in args ? ((args.content as string | null) ?? null) : undefined,
                project: "project" in args ? ((args.project as string | null) ?? null) : undefined,
                team: "team" in args ? ((args.team as string | null) ?? null) : undefined,
                issue: "issue" in args ? ((args.issue as string | null) ?? null) : undefined,
                cycle: "cycle" in args ? ((args.cycle as string | null) ?? null) : undefined,
                icon: "icon" in args ? ((args.icon as string | null) ?? null) : undefined,
                color: "color" in args ? ((args.color as string | null) ?? null) : undefined,
              },
              actor
            )
          );
        }
        if (!args.title) badUserInput("title is required when creating a document (omit id)");
        return serializeDocumentMcp(
          domain.createDocument(
            {
              title: String(args.title),
              content: (args.content as string | undefined) ?? null,
              project: (args.project as string | undefined) ?? null,
              team: (args.team as string | undefined) ?? null,
              issue: (args.issue as string | undefined) ?? null,
              cycle: (args.cycle as string | undefined) ?? null,
              icon: (args.icon as string | undefined) ?? null,
              color: (args.color as string | undefined) ?? null,
            },
            actor
          )
        );
      }),
  },
};

const genericOutputSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export const linearTools: ToolSpec<LinearDomain>[] = canonicalTools.map((tool) => {
  const impl = implementations[tool.name];
  if (!impl) throw new Error(`Missing MCP implementation for ${tool.name}`);
  return {
    name: tool.name,
    description: tool.description,
    schema: impl.schema as unknown as z.ZodType<unknown>,
    mutation: impl.mutation,
    inputSchema: tool.inputSchema,
    outputSchema: genericOutputSchema,
    includeIsError: true,
    handler: (domain, args, ctx) =>
      impl.handler(domain, (args ?? {}) as Record<string, unknown>, ctx),
  };
});

export const LINEAR_MCP_TOOL_COUNT = linearTools.length;
