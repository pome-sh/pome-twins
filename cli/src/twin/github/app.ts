// SPDX-License-Identifier: Apache-2.0
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { createRequestId } from "../../recorder/recorder.js";
import { openGitHubTwinDatabase } from "./db/openDatabase.js";
import {
  addIssueLabel,
  createComment,
  createLabel,
  deleteIssueLabel,
  exportState,
  getIssue,
  getLabel,
  getRepo,
  hasCollaborator,
  listCollaborators,
  listIssueLabels,
  listIssues,
  listLabels,
  seedDatabase,
  updateIssue
} from "./db/queries.js";
import { defaultSeedState } from "./domain/seed.js";
import { collaboratorJson, commentJson, issueJson, labelJson, repoJson } from "./domain/serializers.js";
import type { GitHubTwinDatabase, Recorder, SeedState } from "./types.js";

type AppOptions = {
  db?: GitHubTwinDatabase;
  seed?: SeedState;
  recorder?: Recorder;
  runId?: string;
};

const issuePatchSchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  state: z.enum(["open", "closed"]).optional(),
  assignee: z.string().nullable().optional(),
  assignees: z.array(z.string().min(1)).optional()
});

const createCommentSchema = z.object({
  body: z.string().min(1)
});

const createLabelSchema = z.object({
  name: z.string().min(1),
  color: z.string().default("ededed"),
  description: z.string().default("")
});

const addLabelsSchema = z.object({
  labels: z.array(z.string().min(1)).min(1)
});

const addAssigneesSchema = z.object({
  assignees: z.array(z.string().min(1)).min(1)
});

export function createGitHubTwinApp(options: AppOptions = {}) {
  const db = options.db ?? openGitHubTwinDatabase();
  if (!options.db) {
    seedDatabase(db, options.seed ?? defaultSeedState());
  }

  const recorder = options.recorder;
  const runId = options.runId ?? "local";
  const app = new Hono();

  app.get("/_pome/health", (c) =>
    c.json({
      ok: true,
      twin: "github",
      fidelity: "semantic"
    })
  );

  app.get("/_pome/state", (c) => c.json(exportState(db)));
  app.get("/_pome/events", (c) => c.json(recorder?.events() ?? []));

  app.get("/repos/:owner/:repo", (c) => {
    const started = Date.now();
    const repo = getRepoForRequest(c, db);
    if (!repo) {
      return respond(c, recorder, runId, started, null, 404, githubError("Not Found", 404), false);
    }

    return respond(c, recorder, runId, started, null, 200, repoJson(repo), false);
  });

  app.get("/repos/:owner/:repo/issues", (c) => {
    const started = Date.now();
    const repo = getRepoForRequest(c, db);
    if (!repo) {
      return respond(c, recorder, runId, started, null, 404, githubError("Not Found", 404), false);
    }

    const issues = listIssues(db, repo.id).map((issue) => issueJson(issue, listIssueLabels(db, repo.id, issue.number), repo));
    return respond(c, recorder, runId, started, null, 200, issues, false);
  });

  app.get("/repos/:owner/:repo/issues/:number", (c) => {
    const started = Date.now();
    const found = getIssueForRequest(c, db);
    if (!found.repo) {
      return respond(c, recorder, runId, started, null, 404, githubError("Not Found", 404), false);
    }
    if (!found.issue) {
      return respond(c, recorder, runId, started, null, 404, githubError("Issue not found", 404), false);
    }

    const body = issueJson(found.issue, listIssueLabels(db, found.repo.id, found.issue.number), found.repo);
    return respond(c, recorder, runId, started, null, 200, body, false);
  });

  app.patch("/repos/:owner/:repo/issues/:number", async (c) => {
    const started = Date.now();
    const parsed = await parseBody(c, issuePatchSchema);
    if (!parsed.ok) {
      return respond(c, recorder, runId, started, parsed.raw, parsed.status, parsed.body, false);
    }

    const found = getIssueForRequest(c, db);
    if (!found.repo) {
      return respond(c, recorder, runId, started, parsed.raw, 404, githubError("Not Found", 404), false);
    }
    if (!found.issue) {
      return respond(c, recorder, runId, started, parsed.raw, 404, githubError("Issue not found", 404), false);
    }

    const requestedAssignee = parsed.data.assignee ?? parsed.data.assignees?.[0];
    if (requestedAssignee && !hasCollaborator(db, found.repo.id, requestedAssignee)) {
      return respond(c, recorder, runId, started, parsed.raw, 422, githubError("Validation Failed", 422, [
        { resource: "Issue", field: "assignees", code: "invalid" }
      ]), false);
    }

    const issue = updateIssue(db, found.repo.id, found.issue.number, {
      title: parsed.data.title,
      body: parsed.data.body,
      state: parsed.data.state,
      assignee_login: requestedAssignee
    });

    const body = issueJson(issue!, listIssueLabels(db, found.repo.id, found.issue.number), found.repo);
    return respond(c, recorder, runId, started, parsed.raw, 200, body, true);
  });

  app.post("/repos/:owner/:repo/issues/:number/comments", async (c) => {
    const started = Date.now();
    const parsed = await parseBody(c, createCommentSchema);
    if (!parsed.ok) {
      return respond(c, recorder, runId, started, parsed.raw, parsed.status, parsed.body, false);
    }

    const found = getIssueForRequest(c, db);
    if (!found.repo) {
      return respond(c, recorder, runId, started, parsed.raw, 404, githubError("Not Found", 404), false);
    }
    if (!found.issue) {
      return respond(c, recorder, runId, started, parsed.raw, 404, githubError("Issue not found", 404), false);
    }

    const comment = createComment(db, found.repo.id, found.issue.number, parsed.data.body);
    return respond(c, recorder, runId, started, parsed.raw, 201, commentJson(comment, found.repo, found.issue.number), true);
  });

  app.get("/repos/:owner/:repo/labels", (c) => {
    const started = Date.now();
    const repo = getRepoForRequest(c, db);
    if (!repo) {
      return respond(c, recorder, runId, started, null, 404, githubError("Not Found", 404), false);
    }

    return respond(c, recorder, runId, started, null, 200, listLabels(db, repo.id).map(labelJson), false);
  });

  app.post("/repos/:owner/:repo/labels", async (c) => {
    const started = Date.now();
    const parsed = await parseBody(c, createLabelSchema);
    if (!parsed.ok) {
      return respond(c, recorder, runId, started, parsed.raw, parsed.status, parsed.body, false);
    }

    const repo = getRepoForRequest(c, db);
    if (!repo) {
      return respond(c, recorder, runId, started, parsed.raw, 404, githubError("Not Found", 404), false);
    }
    if (getLabel(db, repo.id, parsed.data.name)) {
      return respond(c, recorder, runId, started, parsed.raw, 422, githubError("Validation Failed", 422, [
        { resource: "Label", field: "name", code: "already_exists" }
      ]), false);
    }

    const label = createLabel(db, repo.id, parsed.data.name, parsed.data.color, parsed.data.description)!;
    return respond(c, recorder, runId, started, parsed.raw, 201, labelJson(label), true);
  });

  app.get("/repos/:owner/:repo/issues/:number/labels", (c) => {
    const started = Date.now();
    const found = getIssueForRequest(c, db);
    if (!found.repo) {
      return respond(c, recorder, runId, started, null, 404, githubError("Not Found", 404), false);
    }
    if (!found.issue) {
      return respond(c, recorder, runId, started, null, 404, githubError("Issue not found", 404), false);
    }

    return respond(c, recorder, runId, started, null, 200, listIssueLabels(db, found.repo.id, found.issue.number).map(labelJson), false);
  });

  app.post("/repos/:owner/:repo/issues/:number/labels", async (c) => {
    const started = Date.now();
    const parsed = await parseBody(c, addLabelsSchema);
    if (!parsed.ok) {
      return respond(c, recorder, runId, started, parsed.raw, parsed.status, parsed.body, false);
    }

    const found = getIssueForRequest(c, db);
    if (!found.repo) {
      return respond(c, recorder, runId, started, parsed.raw, 404, githubError("Not Found", 404), false);
    }
    if (!found.issue) {
      return respond(c, recorder, runId, started, parsed.raw, 404, githubError("Issue not found", 404), false);
    }

    for (const labelName of parsed.data.labels) {
      if (!getLabel(db, found.repo.id, labelName)) {
        return respond(c, recorder, runId, started, parsed.raw, 422, githubError("Validation Failed", 422, [
          { resource: "Label", field: "name", code: "missing", value: labelName }
        ]), false);
      }
    }

    for (const labelName of parsed.data.labels) {
      addIssueLabel(db, found.repo.id, found.issue.number, labelName);
    }

    return respond(
      c,
      recorder,
      runId,
      started,
      parsed.raw,
      200,
      listIssueLabels(db, found.repo.id, found.issue.number).map(labelJson),
      true
    );
  });

  app.delete("/repos/:owner/:repo/issues/:number/labels/:name", (c) => {
    const started = Date.now();
    const found = getIssueForRequest(c, db);
    if (!found.repo) {
      return respond(c, recorder, runId, started, null, 404, githubError("Not Found", 404), false);
    }
    if (!found.issue) {
      return respond(c, recorder, runId, started, null, 404, githubError("Issue not found", 404), false);
    }

    const changes = deleteIssueLabel(db, found.repo.id, found.issue.number, c.req.param("name"));
    if (!changes) {
      return respond(c, recorder, runId, started, null, 404, githubError("Label not found", 404), false);
    }

    return respond(c, recorder, runId, started, null, 200, listIssueLabels(db, found.repo.id, found.issue.number).map(labelJson), true);
  });

  app.get("/repos/:owner/:repo/collaborators", (c) => {
    const started = Date.now();
    const repo = getRepoForRequest(c, db);
    if (!repo) {
      return respond(c, recorder, runId, started, null, 404, githubError("Not Found", 404), false);
    }

    return respond(c, recorder, runId, started, null, 200, listCollaborators(db, repo.id).map(collaboratorJson), false);
  });

  app.post("/repos/:owner/:repo/issues/:number/assignees", async (c) => {
    const started = Date.now();
    const parsed = await parseBody(c, addAssigneesSchema);
    if (!parsed.ok) {
      return respond(c, recorder, runId, started, parsed.raw, parsed.status, parsed.body, false);
    }

    const found = getIssueForRequest(c, db);
    if (!found.repo) {
      return respond(c, recorder, runId, started, parsed.raw, 404, githubError("Not Found", 404), false);
    }
    if (!found.issue) {
      return respond(c, recorder, runId, started, parsed.raw, 404, githubError("Issue not found", 404), false);
    }

    const assignee = parsed.data.assignees[0]!;
    if (!hasCollaborator(db, found.repo.id, assignee)) {
      return respond(c, recorder, runId, started, parsed.raw, 422, githubError("Validation Failed", 422, [
        { resource: "Issue", field: "assignees", code: "invalid", value: assignee }
      ]), false);
    }

    const issue = updateIssue(db, found.repo.id, found.issue.number, { assignee_login: assignee })!;
    return respond(c, recorder, runId, started, parsed.raw, 201, issueJson(issue, listIssueLabels(db, found.repo.id, issue.number), found.repo), true);
  });

  app.all("*", (c) => {
    const started = Date.now();
    return respond(
      c,
      recorder,
      runId,
      started,
      null,
      404,
      {
        message: "This endpoint is not supported by this twin.",
        fidelity: "unsupported",
        supported_endpoints: [
          "GET /repos/:owner/:repo",
          "GET /repos/:owner/:repo/issues",
          "GET /repos/:owner/:repo/issues/:number",
          "PATCH /repos/:owner/:repo/issues/:number",
          "POST /repos/:owner/:repo/issues/:number/comments",
          "GET /repos/:owner/:repo/labels",
          "POST /repos/:owner/:repo/labels",
          "GET /repos/:owner/:repo/issues/:number/labels",
          "POST /repos/:owner/:repo/issues/:number/labels",
          "DELETE /repos/:owner/:repo/issues/:number/labels/:name",
          "GET /repos/:owner/:repo/collaborators",
          "POST /repos/:owner/:repo/issues/:number/assignees"
        ]
      },
      false,
      "unsupported"
    );
  });

  return app;
}

function getRepoForRequest(c: Context, db: GitHubTwinDatabase) {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  if (!owner || !repo) return undefined;
  return getRepo(db, owner, repo);
}

function getIssueForRequest(c: Context, db: GitHubTwinDatabase) {
  const repo = getRepoForRequest(c, db);
  const issueNumber = Number(c.req.param("number"));
  return {
    repo,
    issue: repo && Number.isInteger(issueNumber) ? getIssue(db, repo.id, issueNumber) : undefined
  };
}

function githubError(message: string, status: number, errors?: unknown[]) {
  return {
    message,
    documentation_url: "https://docs.github.com/rest",
    status,
    ...(errors ? { errors } : {})
  };
}

async function parseBody<T extends z.ZodType>(
  c: Context,
  schema: T
): Promise<
  | { ok: true; data: z.infer<T>; raw: unknown }
  | { ok: false; status: number; body: ReturnType<typeof githubError>; raw: unknown }
> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return {
      ok: false,
      status: 400,
      body: githubError("Problems parsing JSON", 400),
      raw: null
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      status: 422,
      body: githubError(
        "Validation Failed",
        422,
        parsed.error.issues.map((issue) => ({
          resource: "Request",
          field: issue.path.join("."),
          code: issue.code
        }))
      ),
      raw
    };
  }

  return { ok: true, data: parsed.data, raw };
}

function respond(
  c: Context,
  recorder: Recorder | undefined,
  runId: string,
  started: number,
  requestBody: unknown,
  status: number,
  responseBody: unknown,
  stateMutation: boolean,
  fidelity: "semantic" | "unsupported" = "semantic"
) {
  recorder?.record({
    ts: new Date().toISOString(),
    run_id: runId,
    twin: "github",
    request_id: createRequestId(),
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    request_body: requestBody,
    status,
    response_body: responseBody,
    latency_ms: Date.now() - started,
    fidelity,
    state_mutation: stateMutation,
    error: status >= 400 ? (responseBody as { message?: string }).message ?? "request failed" : null
  });

  return c.json(responseBody, status as never);
}
