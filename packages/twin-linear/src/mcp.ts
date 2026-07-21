// SPDX-License-Identifier: Apache-2.0
import type { ToolCallContext, ToolSpec } from "@pome-sh/sdk";
import { z } from "zod";
import canonicalListing from "../fixtures/mcp-tools-list.canonical.json" with { type: "json" };
import type { LinearCommands } from "./commands/index.js";
import { mcpPage } from "./pagination.js";
import { linearStateDelta } from "./state.js";
import {
  DEFAULT_LINEAR_EMAIL,
  MCP_PAGE_DEFAULT,
  MCP_PAGE_MAX,
  type LinearIssue,
  type LinearProjectState,
} from "./types.js";

type CanonicalTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const canonicalTools = canonicalListing.result.tools as CanonicalTool[];

const limitSchema = z.number().int().positive().max(MCP_PAGE_MAX).optional();

function actorFrom(ctx: ToolCallContext) {
  return {
    userId: typeof ctx.session?.linear_user_id === "string" ? ctx.session.linear_user_id : undefined,
    email:
      typeof ctx.session?.linear_email === "string"
        ? ctx.session.linear_email
        : DEFAULT_LINEAR_EMAIL,
    scopes: Array.isArray(ctx.session?.scopes) ? (ctx.session.scopes as string[]) : undefined,
  };
}

function mutate<T>(commands: LinearCommands, ctx: ToolCallContext, op: () => T | Promise<T>): Promise<T> | T {
  const before = commands.exportState();
  const result = op();
  if (result instanceof Promise) {
    return result.then((value) => {
      ctx.reportDelta(linearStateDelta(before, commands.exportState()));
      return value;
    });
  }
  ctx.reportDelta(linearStateDelta(before, commands.exportState()));
  return result;
}

function projectIssue(issue: LinearIssue, commands: LinearCommands) {
  const state = commands.getWorkflowState(issue.stateId);
  const assignee = issue.assigneeId ? commands.getUser(issue.assigneeId) : null;
  const team = commands.getTeam(issue.teamId);
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    url: issue.url,
    team: team ? { id: team.id, key: team.key, name: team.name } : null,
    state: state ? { id: state.id, name: state.name, type: state.type } : null,
    assignee: assignee ? { id: assignee.id, name: assignee.name, email: assignee.email } : null,
    labelIds: issue.labelIds,
    projectId: issue.projectId,
    cycleId: issue.cycleId,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function resolveAssignee(commands: LinearCommands, ref: string | undefined, ctx: ToolCallContext): string | undefined {
  if (!ref) return undefined;
  if (ref === "me") {
    return actorFrom(ctx).email ?? DEFAULT_LINEAR_EMAIL;
  }
  return ref;
}

const implementations: Record<
  string,
  {
    schema: z.ZodType;
    mutation: boolean;
    handler: (commands: LinearCommands, args: Record<string, unknown>, ctx: ToolCallContext) => unknown;
  }
> = {
  list_issues: {
    schema: z
      .object({
        team: z.string().optional(),
        assignee: z.string().optional(),
        state: z.string().optional(),
        limit: limitSchema,
        cursor: z.string().optional(),
        query: z.string().optional(),
      })
      .strict(),
    mutation: false,
    handler: (commands, args, ctx) => {
      const assignee = resolveAssignee(commands, args.assignee as string | undefined, ctx);
      const issues = commands.listIssues({
        team: args.team as string | undefined,
        assignee,
        state: args.state as string | undefined,
        query: args.query as string | undefined,
      });
      const page = mcpPage(
        issues.map((issue) => projectIssue(issue, commands)),
        (args.limit as number | undefined) ?? MCP_PAGE_DEFAULT,
        args.cursor as string | undefined,
        `list_issues:${args.team ?? ""}:${assignee ?? ""}:${args.state ?? ""}:${args.query ?? ""}`
      );
      return { issues: page.items, ...(page.cursor ? { cursor: page.cursor } : {}) };
    },
  },
  get_issue: {
    schema: z.object({ id: z.string().min(1) }).strict(),
    mutation: false,
    handler: (commands, args) => {
      const issue = commands.getIssue(String(args.id));
      if (!issue) throw new Error(`Issue not found: ${args.id}`);
      return projectIssue(issue, commands);
    },
  },
  save_issue: {
    schema: z
      .object({
        id: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
        team: z.string().min(1).optional(),
        description: z.string().optional(),
        assignee: z.string().optional(),
        state: z.string().optional(),
        priority: z.number().optional(),
        labels: z.array(z.string()).optional(),
        project: z.string().optional(),
        cycle: z.string().optional(),
      })
      .strict(),
    mutation: true,
    handler: (commands, args, ctx) =>
      mutate(commands, ctx, async () => {
        if (args.id) {
          const issue = await commands.updateIssue(
            String(args.id),
            {
              title: args.title as string | undefined,
              description: "description" in args ? ((args.description as string | null) ?? null) : undefined,
              assigneeId:
                "assignee" in args
                  ? (resolveAssignee(commands, args.assignee as string | undefined, ctx) ?? null)
                  : undefined,
              stateId: "state" in args ? ((args.state as string | null) ?? null) : undefined,
              priority: args.priority as number | undefined,
              labelIds: "labels" in args ? ((args.labels as string[]) ?? []) : undefined,
              projectId: "project" in args ? ((args.project as string | null) ?? null) : undefined,
              cycleId: "cycle" in args ? ((args.cycle as string | null) ?? null) : undefined,
            },
            actorFrom(ctx)
          );
          return projectIssue(issue, commands);
        }
        if (!args.title || !args.team) {
          throw new Error("title and team are required when creating an issue (omit id)");
        }
        const team = commands.getTeam(String(args.team));
        if (!team) throw new Error(`Team not found: ${args.team}`);
        const issue = await commands.createIssue(
          {
            teamId: team.id,
            title: String(args.title),
            description: (args.description as string | undefined) ?? null,
            assigneeId: resolveAssignee(commands, args.assignee as string | undefined, ctx) ?? null,
            stateId: (args.state as string | undefined) ?? null,
            priority: args.priority as number | undefined,
            labelIds: (args.labels as string[] | undefined) ?? null,
            projectId: (args.project as string | undefined) ?? null,
            cycleId: (args.cycle as string | undefined) ?? null,
          },
          actorFrom(ctx)
        );
        return projectIssue(issue, commands);
      }),
  },
  list_comments: {
    schema: z
      .object({
        issueId: z.string().min(1),
        limit: limitSchema,
        cursor: z.string().optional(),
      })
      .strict(),
    mutation: false,
    handler: (commands, args) => {
      const comments = commands.listComments(String(args.issueId)).map((comment) => ({
        id: comment.id,
        body: comment.body,
        issueId: comment.issueId,
        userId: comment.userId,
        createdAt: comment.createdAt,
      }));
      const page = mcpPage(
        comments,
        (args.limit as number | undefined) ?? MCP_PAGE_DEFAULT,
        args.cursor as string | undefined,
        `list_comments:${args.issueId}`
      );
      return { comments: page.items, ...(page.cursor ? { cursor: page.cursor } : {}) };
    },
  },
  save_comment: {
    schema: z
      .object({
        id: z.string().min(1).optional(),
        issueId: z.string().min(1).optional(),
        body: z.string().min(1),
      })
      .strict(),
    mutation: true,
    handler: (commands, args, ctx) =>
      mutate(commands, ctx, async () => {
        if (args.id) {
          const comment = await commands.updateComment(
            String(args.id),
            String(args.body),
            actorFrom(ctx)
          );
          return {
            id: comment.id,
            body: comment.body,
            issueId: comment.issueId,
            userId: comment.userId,
            createdAt: comment.createdAt,
          };
        }
        if (!args.issueId) throw new Error("issueId is required when creating a comment");
        const comment = await commands.createComment(
          { issueId: String(args.issueId), body: String(args.body) },
          actorFrom(ctx)
        );
        return {
          id: comment.id,
          body: comment.body,
          issueId: comment.issueId,
          userId: comment.userId,
          createdAt: comment.createdAt,
        };
      }),
  },
  list_teams: {
    schema: z.object({ limit: limitSchema, cursor: z.string().optional() }).strict(),
    mutation: false,
    handler: (commands, args) => {
      const teams = commands.listTeams().map((team) => ({
        id: team.id,
        key: team.key,
        name: team.name,
        description: team.description,
      }));
      const page = mcpPage(
        teams,
        (args.limit as number | undefined) ?? MCP_PAGE_DEFAULT,
        args.cursor as string | undefined,
        "list_teams"
      );
      return { teams: page.items, ...(page.cursor ? { cursor: page.cursor } : {}) };
    },
  },
  get_team: {
    schema: z.object({ query: z.string().min(1) }).strict(),
    mutation: false,
    handler: (commands, args) => {
      const team = commands.getTeam(String(args.query));
      if (!team) throw new Error(`Team not found: ${args.query}`);
      return { id: team.id, key: team.key, name: team.name, description: team.description, url: team.url };
    },
  },
  list_users: {
    schema: z.object({ limit: limitSchema, cursor: z.string().optional() }).strict(),
    mutation: false,
    handler: (commands, args) => {
      const users = commands.listUsers().map((user) => ({
        id: user.id,
        name: user.name,
        displayName: user.displayName,
        email: user.email,
        admin: user.admin,
        app: user.app,
      }));
      const page = mcpPage(
        users,
        (args.limit as number | undefined) ?? MCP_PAGE_DEFAULT,
        args.cursor as string | undefined,
        "list_users"
      );
      return { users: page.items, ...(page.cursor ? { cursor: page.cursor } : {}) };
    },
  },
  get_user: {
    schema: z.object({ query: z.string().min(1) }).strict(),
    mutation: false,
    handler: (commands, args) => {
      const user = commands.getUser(String(args.query));
      if (!user) throw new Error(`User not found: ${args.query}`);
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
    schema: z.object({ team: z.string().min(1) }).strict(),
    mutation: false,
    handler: (commands, args) => ({
      statuses: commands.listWorkflowStates(String(args.team)).map((state) => ({
        id: state.id,
        name: state.name,
        type: state.type,
        position: state.position,
      })),
    }),
  },
  get_issue_status: {
    schema: z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
        team: z.string().optional(),
      })
      .strict(),
    mutation: false,
    handler: (commands, args) => {
      const ref = (args.id as string | undefined) ?? (args.name as string | undefined);
      if (!ref) throw new Error("id or name is required");
      const state = commands.getWorkflowState(ref, args.team as string | undefined);
      if (!state) throw new Error(`Issue status not found: ${ref}`);
      return { id: state.id, name: state.name, type: state.type, position: state.position, teamId: state.teamId };
    },
  },
  list_issue_labels: {
    schema: z
      .object({
        team: z.string().optional(),
        limit: limitSchema,
        cursor: z.string().optional(),
      })
      .strict(),
    mutation: false,
    handler: (commands, args) => {
      const labels = commands.listLabels(args.team as string | undefined).map((label) => ({
        id: label.id,
        name: label.name,
        color: label.color,
        description: label.description,
        teamId: label.teamId,
      }));
      const page = mcpPage(
        labels,
        (args.limit as number | undefined) ?? MCP_PAGE_DEFAULT,
        args.cursor as string | undefined,
        `list_issue_labels:${args.team ?? ""}`
      );
      return { labels: page.items, ...(page.cursor ? { cursor: page.cursor } : {}) };
    },
  },
  create_issue_label: {
    schema: z
      .object({
        name: z.string().min(1),
        color: z.string().optional(),
        description: z.string().optional(),
        team: z.string().optional(),
      })
      .strict(),
    mutation: true,
    handler: (commands, args, ctx) =>
      mutate(commands, ctx, async () => {
        const label = await commands.createLabel(
          {
            name: String(args.name),
            color: args.color as string | undefined,
            description: (args.description as string | undefined) ?? null,
            teamId: (args.team as string | undefined) ?? null,
          },
          actorFrom(ctx)
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
    schema: z
      .object({
        team: z.string().optional(),
        limit: limitSchema,
        cursor: z.string().optional(),
      })
      .strict(),
    mutation: false,
    handler: (commands, args) => {
      const projects = commands.listProjects(args.team as string | undefined).map((project) => ({
        id: project.id,
        name: project.name,
        description: project.description,
        state: project.state,
        teamId: project.teamId,
      }));
      const page = mcpPage(
        projects,
        (args.limit as number | undefined) ?? MCP_PAGE_DEFAULT,
        args.cursor as string | undefined,
        `list_projects:${args.team ?? ""}`
      );
      return { projects: page.items, ...(page.cursor ? { cursor: page.cursor } : {}) };
    },
  },
  get_project: {
    schema: z.object({ query: z.string().min(1) }).strict(),
    mutation: false,
    handler: (commands, args) => {
      const project = commands.getProject(String(args.query));
      if (!project) throw new Error(`Project not found: ${args.query}`);
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
    schema: z
      .object({
        id: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
        team: z.string().optional(),
        description: z.string().optional(),
        state: z.string().optional(),
      })
      .strict(),
    mutation: true,
    handler: (commands, args, ctx) =>
      mutate(commands, ctx, () => {
        if (args.id) {
          const project = commands.updateProject(String(args.id), {
            name: args.name as string | undefined,
            description: "description" in args ? ((args.description as string | null) ?? null) : undefined,
            state: args.state as LinearProjectState | undefined,
          });
          return {
            id: project.id,
            name: project.name,
            description: project.description,
            state: project.state,
            teamId: project.teamId,
          };
        }
        if (!args.name) throw new Error("name is required when creating a project (omit id)");
        const project = commands.createProject({
          name: String(args.name),
          teamId: (args.team as string | undefined) ?? null,
          description: (args.description as string | undefined) ?? null,
          state: (args.state as LinearProjectState | undefined) ?? "planned",
        });
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
    schema: z
      .object({
        teamId: z.string().min(1),
        limit: limitSchema,
        cursor: z.string().optional(),
      })
      .strict(),
    mutation: false,
    handler: (commands, args) => {
      const cycles = commands.listCycles(String(args.teamId)).map((cycle) => ({
        id: cycle.id,
        name: cycle.name,
        number: cycle.number,
        startsAt: cycle.startsAt,
        endsAt: cycle.endsAt,
        teamId: cycle.teamId,
      }));
      const page = mcpPage(
        cycles,
        (args.limit as number | undefined) ?? MCP_PAGE_DEFAULT,
        args.cursor as string | undefined,
        `list_cycles:${args.teamId}`
      );
      return { cycles: page.items, ...(page.cursor ? { cursor: page.cursor } : {}) };
    },
  },
  search_documentation: {
    schema: z.object({ query: z.string().min(1) }).strict(),
    mutation: false,
    handler: (_commands, args) => ({
      query: String(args.query),
      results: [] as Array<{ title: string; url: string; snippet: string }>,
      note: "Linear twin documentation search returns an empty static result set.",
    }),
  },
};

const genericOutputSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export const linearTools: ToolSpec<LinearCommands>[] = canonicalTools.map((tool) => {
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
    handler: (commands, args, ctx) =>
      impl.handler(commands, (args ?? {}) as Record<string, unknown>, ctx),
  };
});

export const LINEAR_MCP_TOOL_COUNT = linearTools.length;
