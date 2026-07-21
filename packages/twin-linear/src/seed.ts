// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  DEFAULT_LINEAR_CLOCK,
  DEFAULT_LINEAR_EMAIL,
  DEFAULT_LINEAR_SID,
  DEFAULT_LINEAR_TOKEN,
  DEFAULT_SCOPES,
  type LinearStateSeed,
} from "./types.js";

const datetime = z.string().datetime({ offset: true });
const email = z.string().trim().email().transform((v) => v.toLowerCase());
const id = z.string().min(1).max(128);

const scopesField = z
  .union([z.array(z.string().min(1).max(64)).max(50), z.string().max(500)])
  .optional();

const stateType = z.enum(["backlog", "unstarted", "started", "completed", "canceled"]);

export const linearSeedSchema = z
  .object({
    clock: datetime.default(DEFAULT_LINEAR_CLOCK),
    defaultSid: z.string().min(1).max(128).default(DEFAULT_LINEAR_SID),
    baseUrl: z.string().url().default("http://127.0.0.1:3337"),
    strictScopes: z.boolean().default(false),
    organization: z
      .object({
        id: id.optional(),
        name: z.string().min(1).max(200).optional(),
        urlKey: z.string().min(1).max(100).optional(),
      })
      .strict()
      .optional(),
    users: z
      .array(
        z
          .object({
            id: id.optional(),
            email,
            name: z.string().min(1).max(200).optional(),
            displayName: z.string().min(1).max(200).optional(),
            avatarUrl: z.string().url().nullable().optional(),
            active: z.boolean().default(true),
            admin: z.boolean().default(false),
            app: z.boolean().default(false),
          })
          .strict()
      )
      .max(500)
      .default([]),
    teams: z
      .array(
        z
          .object({
            id: id.optional(),
            key: z.string().min(1).max(20).regex(/^[A-Z][A-Z0-9]*$/),
            name: z.string().min(1).max(200),
            description: z.string().max(2000).nullable().optional(),
            private: z.boolean().default(false),
            states: z
              .array(
                z
                  .object({
                    id: id.optional(),
                    name: z.string().min(1).max(100),
                    type: stateType.optional(),
                    position: z.number().int().nonnegative().optional(),
                  })
                  .strict()
              )
              .max(50)
              .optional(),
          })
          .strict()
      )
      .max(50)
      .default([]),
    labels: z
      .array(
        z
          .object({
            id: id.optional(),
            name: z.string().min(1).max(100),
            color: z.string().max(32).optional(),
            description: z.string().max(2000).nullable().optional(),
            team: z.string().min(1).max(128).optional(),
          })
          .strict()
      )
      .max(500)
      .default([]),
    projects: z
      .array(
        z
          .object({
            id: id.optional(),
            name: z.string().min(1).max(200),
            description: z.string().max(10_000).nullable().optional(),
            state: z.enum(["planned", "started", "completed", "canceled"]).default("planned"),
            team: z.string().min(1).max(128).optional(),
          })
          .strict()
      )
      .max(200)
      .default([]),
    cycles: z
      .array(
        z
          .object({
            id: id.optional(),
            team: z.string().min(1).max(128),
            name: z.string().min(1).max(200),
            number: z.number().int().positive().optional(),
            startsAt: datetime.nullable().optional(),
            endsAt: datetime.nullable().optional(),
          })
          .strict()
      )
      .max(200)
      .default([]),
    issues: z
      .array(
        z
          .object({
            id: id.optional(),
            team: z.string().min(1).max(128),
            title: z.string().min(1).max(512),
            description: z.string().max(65_536).nullable().optional(),
            priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(0),
            state: z.string().min(1).max(128).optional(),
            assignee: z.string().min(1).max(200).optional(),
            creator: z.string().min(1).max(200).optional(),
            delegate: z.string().min(1).max(200).optional(),
            project: z.string().min(1).max(200).optional(),
            cycle: z.string().min(1).max(200).optional(),
            labels: z.array(z.string().min(1).max(100)).max(50).default([]),
            dueDate: z.string().max(32).nullable().optional(),
            createdAt: datetime.optional(),
            updatedAt: datetime.optional(),
          })
          .strict()
      )
      .max(5000)
      .default([]),
    comments: z
      .array(
        z
          .object({
            id: id.optional(),
            issue: z.string().min(1).max(128),
            body: z.string().min(1).max(65_536),
            user: z.string().min(1).max(200).optional(),
            createdAt: datetime.optional(),
          })
          .strict()
      )
      .max(20_000)
      .default([]),
    oauthApps: z
      .array(
        z
          .object({
            id: id.optional(),
            clientId: z.string().min(1).max(200),
            clientSecret: z.string().min(1).max(500),
            name: z.string().min(1).max(200),
            redirectUris: z.array(z.string().url()).min(1).max(20),
            scopes: scopesField,
            actor: z.enum(["user", "app"]).default("user"),
            assignable: z.boolean().default(false),
            mentionable: z.boolean().default(false),
            appUserId: z.string().min(1).max(128).nullable().optional(),
          })
          .strict()
      )
      .max(20)
      .default([]),
    tokens: z
      .array(
        z
          .object({
            token: z.string().min(1).max(500),
            type: z.enum(["personal", "oauth_access", "client_credentials"]).default("personal"),
            user: z.string().min(1).max(200).optional(),
            app: z.string().min(1).max(200).optional(),
            scopes: scopesField,
            actor: z.enum(["user", "app"]).optional(),
            sid: z.string().min(1).max(128).optional(),
            expiresAt: datetime.nullable().optional(),
          })
          .strict()
      )
      .max(50)
      .default([]),
    webhooks: z
      .array(
        z
          .object({
            id: id.optional(),
            label: z.string().min(1).max(200).optional(),
            url: z.string().url(),
            resourceTypes: scopesField,
            team: z.string().min(1).max(128).optional(),
            allPublicTeams: z.boolean().optional(),
            secret: z.string().max(500).nullable().optional(),
            enabled: z.boolean().default(true),
          })
          .strict()
      )
      .max(50)
      .default([]),
  })
  .strict()
  .superRefine((seed, ctx) => {
    const teamKeys = new Set(seed.teams.map((t) => t.key));
    const teamIds = new Set(seed.teams.map((t) => t.id).filter(Boolean) as string[]);
    const userEmails = new Set(seed.users.map((u) => u.email));
    const userIds = new Set(seed.users.map((u) => u.id).filter(Boolean) as string[]);
    const labelNames = new Set(seed.labels.map((l) => l.name));
    const projectNames = new Set(seed.projects.map((p) => p.name));
    const cycleNames = new Set(seed.cycles.map((c) => c.name));
    const issueTitlesByTeam = new Map<string, Set<string>>();

    const resolveTeam = (ref: string) => teamKeys.has(ref) || teamIds.has(ref);
    const resolveUser = (ref: string) =>
      userEmails.has(ref.toLowerCase()) || userIds.has(ref) || seed.users.some((u) => u.name === ref || u.displayName === ref);

    for (const team of seed.teams) {
      const stateNames = new Set<string>();
      for (const state of team.states ?? []) {
        if (stateNames.has(state.name)) {
          ctx.addIssue({ code: "custom", message: `Duplicate workflow state ${state.name} on team ${team.key}` });
        }
        stateNames.add(state.name);
      }
    }

    for (const label of seed.labels) {
      if (label.team && !resolveTeam(label.team)) {
        ctx.addIssue({ code: "custom", message: `Label team not found: ${label.team}` });
      }
    }

    for (const project of seed.projects) {
      if (project.team && !resolveTeam(project.team)) {
        ctx.addIssue({ code: "custom", message: `Project team not found: ${project.team}` });
      }
    }

    for (const cycle of seed.cycles) {
      if (!resolveTeam(cycle.team)) {
        ctx.addIssue({ code: "custom", message: `Cycle team not found: ${cycle.team}` });
      }
    }

    for (const issue of seed.issues) {
      if (!resolveTeam(issue.team)) {
        ctx.addIssue({ code: "custom", message: `Issue team not found: ${issue.team}` });
      }
      if (issue.assignee && !resolveUser(issue.assignee)) {
        ctx.addIssue({ code: "custom", message: `Issue assignee not found: ${issue.assignee}` });
      }
      if (issue.creator && !resolveUser(issue.creator)) {
        ctx.addIssue({ code: "custom", message: `Issue creator not found: ${issue.creator}` });
      }
      if (issue.delegate && !resolveUser(issue.delegate)) {
        ctx.addIssue({ code: "custom", message: `Issue delegate not found: ${issue.delegate}` });
      }
      if (issue.project && !projectNames.has(issue.project) && !seed.projects.some((p) => p.id === issue.project)) {
        ctx.addIssue({ code: "custom", message: `Issue project not found: ${issue.project}` });
      }
      if (issue.cycle && !cycleNames.has(issue.cycle) && !seed.cycles.some((c) => c.id === issue.cycle || String(c.number) === issue.cycle)) {
        ctx.addIssue({ code: "custom", message: `Issue cycle not found: ${issue.cycle}` });
      }
      for (const label of issue.labels) {
        if (!labelNames.has(label) && !seed.labels.some((l) => l.id === label)) {
          ctx.addIssue({ code: "custom", message: `Issue label not found: ${label}` });
        }
      }
      if (issue.state) {
        const team = seed.teams.find((t) => t.key === issue.team || t.id === issue.team);
        const states = team?.states ?? [];
        const defaultNames = ["Backlog", "Todo", "In Progress", "Done", "Canceled"];
        const ok =
          states.some((s) => s.name === issue.state || s.id === issue.state) ||
          defaultNames.includes(issue.state);
        if (!ok && states.length > 0) {
          ctx.addIssue({ code: "custom", message: `Issue state not found: ${issue.state}` });
        }
      }
      const titles = issueTitlesByTeam.get(issue.team) ?? new Set();
      if (titles.has(issue.title)) {
        ctx.addIssue({ code: "custom", message: `Duplicate issue title on team ${issue.team}: ${issue.title}` });
      }
      titles.add(issue.title);
      issueTitlesByTeam.set(issue.team, titles);
    }

    for (const comment of seed.comments) {
      const issueOk =
        seed.issues.some((i) => i.id === comment.issue || i.title === comment.issue) ||
        /^[A-Z]+-\d+$/.test(comment.issue);
      if (!issueOk) {
        ctx.addIssue({ code: "custom", message: `Comment issue not found: ${comment.issue}` });
      }
      if (comment.user && !resolveUser(comment.user)) {
        ctx.addIssue({ code: "custom", message: `Comment user not found: ${comment.user}` });
      }
    }

    for (const app of seed.oauthApps) {
      for (const uri of app.redirectUris) {
        try {
          new URL(uri);
        } catch {
          ctx.addIssue({ code: "custom", message: `Invalid OAuth redirect URI: ${uri}` });
        }
      }
      if (app.appUserId && !resolveUser(app.appUserId)) {
        ctx.addIssue({ code: "custom", message: `OAuth app user not found: ${app.appUserId}` });
      }
    }

    for (const token of seed.tokens) {
      if (token.user && !resolveUser(token.user)) {
        ctx.addIssue({ code: "custom", message: `Token user not found: ${token.user}` });
      }
      if (token.app && !seed.oauthApps.some((a) => a.clientId === token.app || a.id === token.app)) {
        ctx.addIssue({ code: "custom", message: `Token app not found: ${token.app}` });
      }
    }

    for (const webhook of seed.webhooks) {
      try {
        new URL(webhook.url);
      } catch {
        ctx.addIssue({ code: "custom", message: `Invalid webhook URL: ${webhook.url}` });
      }
      if (webhook.team && !resolveTeam(webhook.team)) {
        ctx.addIssue({ code: "custom", message: `Webhook team not found: ${webhook.team}` });
      }
    }
  });

export type ParsedLinearStateSeed = z.output<typeof linearSeedSchema>;

export function parseSeed(input: unknown): ParsedLinearStateSeed {
  return linearSeedSchema.parse(input);
}

export function loadSeedFromEnv(env: NodeJS.ProcessEnv = process.env): ParsedLinearStateSeed {
  const raw = env.POME_SEED_JSON;
  if (!raw) return parseSeed(defaultSeedState());
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`POME_SEED_JSON is not valid JSON: ${(error as Error).message}`);
  }
  return parseSeed(parsed);
}

/** Multi-issue agent world: ENG team, admin+dev, triage/progress/done issues. */
export function defaultSeedState(): LinearStateSeed {
  return {
    clock: DEFAULT_LINEAR_CLOCK,
    defaultSid: DEFAULT_LINEAR_SID,
    baseUrl: "http://127.0.0.1:3337",
    strictScopes: false,
    organization: {
      id: "org_pome",
      name: "Pome Twin",
      urlKey: "pome-twin",
    },
    users: [
      {
        id: "user_admin",
        email: DEFAULT_LINEAR_EMAIL,
        name: "Admin User",
        displayName: "Admin",
        admin: true,
        active: true,
      },
      {
        id: "user_dev",
        email: "dev@pome-twin.test",
        name: "Developer",
        displayName: "Dev",
        admin: false,
        active: true,
      },
      {
        id: "user_agent",
        email: "agent@pome-twin.test",
        name: "Pome Agent",
        displayName: "Pome Agent",
        admin: false,
        active: true,
        app: true,
      },
    ],
    teams: [
      {
        id: "team_eng",
        key: "ENG",
        name: "Engineering",
        description: "Default engineering team",
        private: false,
        states: [
          { id: "state_backlog", name: "Backlog", type: "backlog", position: 0 },
          { id: "state_todo", name: "Todo", type: "unstarted", position: 1 },
          { id: "state_progress", name: "In Progress", type: "started", position: 2 },
          { id: "state_done", name: "Done", type: "completed", position: 3 },
          { id: "state_canceled", name: "Canceled", type: "canceled", position: 4 },
        ],
      },
    ],
    labels: [
      { id: "label_bug", name: "Bug", color: "#d92d20", team: "ENG", description: "Defect" },
      { id: "label_feature", name: "Feature", color: "#2563eb", team: "ENG", description: "New work" },
      { id: "label_agent", name: "Agent", color: "#0f766e", team: "ENG", description: "Agent triage" },
    ],
    projects: [
      {
        id: "project_local",
        name: "Local Twin",
        description: "Agent evaluation workspace",
        state: "started",
        team: "ENG",
      },
    ],
    cycles: [
      {
        id: "cycle_1",
        team: "ENG",
        name: "Cycle 1",
        number: 1,
        startsAt: "2026-07-14T00:00:00.000Z",
        endsAt: "2026-07-28T00:00:00.000Z",
      },
    ],
    issues: [
      {
        id: "issue_backlog",
        team: "ENG",
        title: "Triage inbox for agent eval",
        description: "Backlog item waiting for triage.",
        priority: 2,
        state: "Backlog",
        assignee: "dev@pome-twin.test",
        creator: DEFAULT_LINEAR_EMAIL,
        project: "Local Twin",
        cycle: "Cycle 1",
        labels: ["Agent"],
        createdAt: "2026-07-20T10:00:00.000Z",
        updatedAt: "2026-07-20T10:00:00.000Z",
      },
      {
        id: "issue_todo",
        team: "ENG",
        title: "Ship Linear twin GraphQL surface",
        description: "Implement issue CRUD + comments for agent testing.",
        priority: 3,
        state: "Todo",
        assignee: "dev@pome-twin.test",
        creator: DEFAULT_LINEAR_EMAIL,
        project: "Local Twin",
        cycle: "Cycle 1",
        labels: ["Feature"],
        createdAt: "2026-07-20T12:00:00.000Z",
        updatedAt: "2026-07-20T14:00:00.000Z",
      },
      {
        id: "issue_progress",
        team: "ENG",
        title: "Wire MCP tools to commands",
        description: "Keep GraphQL and MCP on the same LinearCommands layer.",
        priority: 2,
        state: "In Progress",
        assignee: DEFAULT_LINEAR_EMAIL,
        creator: DEFAULT_LINEAR_EMAIL,
        project: "Local Twin",
        cycle: "Cycle 1",
        labels: ["Feature", "Agent"],
        createdAt: "2026-07-20T16:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
      },
      {
        id: "issue_done",
        team: "ENG",
        title: "Seed multi-issue agent world",
        description: "Default seed covers backlog/todo/progress/done.",
        priority: 1,
        state: "Done",
        assignee: "dev@pome-twin.test",
        creator: DEFAULT_LINEAR_EMAIL,
        project: "Local Twin",
        labels: ["Bug"],
        createdAt: "2026-07-19T09:00:00.000Z",
        updatedAt: "2026-07-20T18:00:00.000Z",
      },
    ],
    comments: [
      {
        id: "comment_1",
        issue: "Ship Linear twin GraphQL surface",
        body: "Starting with viewer + issues queries.",
        user: DEFAULT_LINEAR_EMAIL,
        createdAt: "2026-07-20T13:00:00.000Z",
      },
      {
        id: "comment_2",
        issue: "Wire MCP tools to commands",
        body: "MCP list_issues should match GraphQL issues.",
        user: "dev@pome-twin.test",
        createdAt: "2026-07-20T17:00:00.000Z",
      },
      {
        id: "comment_3",
        issue: "Triage inbox for agent eval",
        body: "@Pome Agent please prioritize this.",
        user: DEFAULT_LINEAR_EMAIL,
        createdAt: "2026-07-20T11:00:00.000Z",
      },
    ],
    oauthApps: [
      {
        id: "oauth_app_1",
        clientId: "lin_example_client_id",
        clientSecret: "example_client_secret",
        name: "Pome Linear App",
        redirectUris: ["http://localhost:3000/api/auth/callback/linear"],
        scopes: [...DEFAULT_SCOPES],
        actor: "user",
        assignable: true,
        mentionable: true,
        appUserId: "user_agent",
      },
    ],
    tokens: [
      {
        token: DEFAULT_LINEAR_TOKEN,
        type: "personal",
        user: DEFAULT_LINEAR_EMAIL,
        scopes: [...DEFAULT_SCOPES],
        actor: "user",
        sid: DEFAULT_LINEAR_SID,
      },
    ],
    webhooks: [
      {
        id: "webhook_1",
        label: "Sample webhook",
        url: "http://127.0.0.1:9999/linear-hooks",
        resourceTypes: ["Issue", "Comment"],
        team: "ENG",
        allPublicTeams: false,
        secret: "whsec_test_linear",
        enabled: true,
      },
    ],
  };
}
