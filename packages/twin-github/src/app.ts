// SPDX-License-Identifier: Apache-2.0
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { StateDelta } from "@pome-sh/shared-types";
import { bearerAuth, localhostOnly, type Session } from "./auth.js";
import { openGitHubCloneDatabase } from "./db.js";
import { GitHubDomain } from "./domain.js";
import { githubError, TwinError, validationFailed } from "./errors.js";
import { defaultSeedState, parseSeed } from "./seed.js";
import type { GitHubCloneDatabase, GitHubStateSeed, Recorder } from "./types.js";
import { requestId } from "./util.js";
import { executeTool, isMutatingTool, listTools } from "./tools.js";
import { handleMcpRequest, mcpMethodNotAllowed } from "./mcp.js";
import { twinBuildInfo } from "./build-info.js";
import { unsupportedEnvelope } from "./unsupported-envelope.js";
import { githubAccessControlPayload } from "./access-control.js";
import { summarizeGitHubAccessControlCatalog } from "@pome-sh/shared-types";

type HandleResult = { status: number; body: unknown; mutation: boolean; stateDelta?: StateDelta };

function captureDelta<T>(fn: (onDelta: (delta: StateDelta) => void) => T): { value: T; delta: StateDelta } {
  let delta: StateDelta = null;
  const value = fn((d) => { delta = d; });
  return { value, delta };
}

export type GitHubCloneAppOptions = {
  db?: GitHubCloneDatabase;
  seed?: GitHubStateSeed;
  recorder?: Recorder;
  runId?: string;
};

const jsonRecord = z.record(z.string(), z.unknown());
const createRepoSchema = z.object({ name: z.string().min(1), owner: z.string().min(1).optional(), description: z.string().optional(), private: z.boolean().optional() });
const contentSchema = z.object({ message: z.string().min(1), content: z.string(), branch: z.string().optional(), sha: z.string().optional(), encoding: z.enum(["utf-8", "base64"]).optional() });
const createIssueSchema = z.object({ title: z.string().min(1), body: z.string().optional(), labels: z.array(z.string()).optional(), assignees: z.array(z.string()).optional() });
const updateIssueSchema = z.object({ title: z.string().optional(), body: z.string().optional(), state: z.enum(["open", "closed"]).optional(), labels: z.array(z.string()).optional(), assignees: z.array(z.string()).optional() });
const commentSchema = z.object({ body: z.string().min(1) });
const labelSchema = z.object({ name: z.string().min(1), color: z.string().default("ededed"), description: z.string().default("") });
const labelsSchema = z.object({ labels: z.array(z.string().min(1)).min(1) });
const assigneesSchema = z.object({ assignees: z.array(z.string().min(1)).min(1) });
const createPullSchema = z.object({ title: z.string().min(1), body: z.string().optional(), head: z.string().min(1), base: z.string().optional() });
const reviewSchema = z.object({ event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]), body: z.string().optional() });
const mergeSchema = z.object({ commit_title: z.string().optional(), commit_message: z.string().optional() });
const updateBranchSchema = z.object({ expected_head_sha: z.string().optional() });
const deleteFileSchema = z.object({ message: z.string().min(1), sha: z.string().min(1), branch: z.string().optional() });
const updatePrSchema = z.object({ title: z.string().optional(), body: z.string().optional(), state: z.enum(["open", "closed"]).optional(), base: z.string().optional() });
const reviewCommentSchema = z.object({ body: z.string().min(1), path: z.string().min(1), line: z.coerce.number().int().positive(), side: z.enum(["LEFT", "RIGHT"]).optional(), commit_id: z.string().optional() });
const replyCommentSchema = z.object({ body: z.string().min(1) });
const updateCommentSchema = z.object({ body: z.string().min(1) });
const milestoneSchema = z.object({ title: z.string().min(1), description: z.string().optional(), due_on: z.string().optional(), state: z.enum(["open", "closed"]).optional() });
const updateMilestoneSchema = z.object({ title: z.string().optional(), description: z.string().optional(), due_on: z.string().optional(), state: z.enum(["open", "closed"]).optional() });
const createStatusSchema = z.object({ state: z.enum(["error", "failure", "pending", "success"]), context: z.string().optional(), description: z.string().optional(), target_url: z.string().optional() });
const createCheckRunSchema = z.object({
  name: z.string().min(1),
  head_sha: z.string().min(1),
  status: z.enum(["queued", "in_progress", "completed"]).optional(),
  conclusion: z.enum(["success", "failure", "neutral", "cancelled", "timed_out", "action_required", "skipped", "stale"]).optional(),
  details_url: z.string().optional(),
  external_id: z.string().optional(),
  output: z.object({ title: z.string().optional(), summary: z.string().optional() }).optional(),
  started_at: z.string().optional(),
  completed_at: z.string().optional()
});
const createReleaseSchema = z.object({
  tag_name: z.string().min(1),
  target_commitish: z.string().optional(),
  name: z.string().optional(),
  body: z.string().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional()
});
const addCollaboratorSchema = z.object({ permission: z.enum(["pull", "push", "admin", "maintain", "triage"]).optional() });

export function createGitHubCloneApp(options: GitHubCloneAppOptions = {}) {
  const db = options.db ?? openGitHubCloneDatabase();
  const domain = new GitHubDomain(db);
  if (!options.db) domain.seed(options.seed ?? defaultSeedState());

  const recorder = options.recorder;
  const runId = options.runId ?? "local";

  const root = new Hono();

  root.get("/healthz", (c) => {
    const access = summarizeGitHubAccessControlCatalog();
    return c.json({
      ok: true,
      twin: "github",
      implementation: "github_clone",
      fidelity: "semantic",
      tools: listTools().length,
      access_control: access,
      runtime: twinBuildInfo()
    });
  });

  const adminApp = new Hono();
  adminApp.use("*", localhostOnly());
  adminApp.post("/reset", (c) => handle(c, recorder, runId, async () => {
    const { delta } = captureDelta((onDelta) => {
      domain.seed(defaultSeedState(), onDelta);
    });
    return { status: 200, body: { ok: true, message: "GitHub twin state reset to default seed." }, mutation: true, stateDelta: delta };
  }));
  adminApp.post("/seed", (c) => handle(c, recorder, runId, async () => {
    const parsed = parseSeed(await c.req.json());
    const { delta } = captureDelta((onDelta) => {
      domain.seed(parsed, onDelta);
    });
    return { status: 200, body: { ok: true, repositories: parsed.repositories.length }, mutation: true, stateDelta: delta };
  }));
  root.route("/admin", adminApp);

  const session = new Hono();
  session.use("*", bearerAuth());

  session.get("/healthz", (c) => c.json({ ok: true, sid: c.req.param("sid") }));
  session.get("/_pome/health", (c) =>
    c.json({
      ok: true,
      twin: "github",
      implementation: "github_clone",
      fidelity: "semantic",
      runtime: twinBuildInfo()
    })
  );
  session.get("/_pome/state", (c) => c.json(domain.exportState()));
  session.get("/_pome/events", (c) => c.json(recorder?.events() ?? []));
  session.get("/_pome/access-control", (c) => c.json(githubAccessControlPayload()));

  // Real MCP JSON-RPC endpoint (Streamable HTTP, stateless). The bearerAuth
  // middleware on `session` covers this — auth contract is unchanged. Legacy
  // custom routes below (`/mcp/tools`, `/mcp/tools/:name`, `/mcp/call`) stay
  // mounted at sub-paths; they do not collide with `POST /mcp`.
  session.post("/mcp", (c) => handleMcpRequest(c, { domain, recorder, runId, actor: sessionFrom(c).login }));
  session.get("/mcp", (c) => mcpMethodNotAllowed(c));
  session.delete("/mcp", (c) => mcpMethodNotAllowed(c));

  session.get("/mcp/tools", (c) => c.json({ tools: listTools() }));
  session.post("/mcp/tools/:name", (c) => handle(c, recorder, runId, async () => {
    const args = await readJson(c);
    const name = requireParam(c, "name");
    const actor = sessionFrom(c).login;
    const { value, delta } = captureDelta((onDelta) => executeTool(domain, name, args, onDelta, { actor }));
    return { status: 200, body: value, mutation: isMutatingTool(name), stateDelta: delta };
  }));
  session.post("/mcp/call", (c) => handle(c, recorder, runId, async () => {
    const call = z.object({ tool: z.string().min(1), arguments: jsonRecord.default({}) }).parse(await readJson(c));
    const actor = sessionFrom(c).login;
    const { value, delta } = captureDelta((onDelta) => executeTool(domain, call.tool, call.arguments, onDelta, { actor }));
    return { status: 200, body: value, mutation: isMutatingTool(call.tool), stateDelta: delta };
  }));

  session.get("/search/repositories", (c) => handle(c, recorder, runId, () => ok(domain.searchRepositories({ q: c.req.query("q"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.get("/search/code", (c) => handle(c, recorder, runId, () => ok(domain.searchCode({ q: c.req.query("q"), owner: c.req.query("owner"), repo: c.req.query("repo"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.get("/search/issues", (c) => handle(c, recorder, runId, () => ok(domain.searchIssues({ q: c.req.query("q"), owner: c.req.query("owner"), repo: c.req.query("repo"), state: stateQuery(c), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.get("/search/users", (c) => handle(c, recorder, runId, () => ok(domain.searchUsers({ q: c.req.query("q"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));

  session.get("/repos/:owner/:repo", (c) => handle(c, recorder, runId, () => ok(domain.getRepository(params(c)))));
  session.post("/user/repos", (c) => handle(c, recorder, runId, async () => {
    const args = createRepoSchema.parse(await readJson(c));
    const { value, delta } = captureDelta((onDelta) => domain.createRepository(args, onDelta));
    return created(value, delta);
  }));
  session.post("/orgs/:owner/repos", (c) => handle(c, recorder, runId, async () => {
    const args = { ...createRepoSchema.parse(await readJson(c)), owner: c.req.param("owner") };
    const { value, delta } = captureDelta((onDelta) => domain.createRepository(args, onDelta));
    return created(value, delta);
  }));
  session.post("/repos/:owner/:repo/forks", (c) => handle(c, recorder, runId, async () => {
    const organization = (await maybeJson(c)).organization as string | undefined;
    const { value, delta } = captureDelta((onDelta) => domain.forkRepository({ ...params(c), organization }, onDelta));
    return created(value, delta);
  }));

  session.get("/repos/:owner/:repo/contents", (c) => handle(c, recorder, runId, () => ok(domain.getFileContents({ ...params(c), path: "", ref: c.req.query("ref") }))));
  session.get("/repos/:owner/:repo/contents/*", (c) => handle(c, recorder, runId, () => ok(domain.getFileContents({ ...params(c), path: contentPath(c), ref: c.req.query("ref") }))));
  session.put("/repos/:owner/:repo/contents/*", (c) => handle(c, recorder, runId, async () => {
    const body = contentSchema.parse(await readJson(c));
    const args = { ...params(c), path: contentPath(c), ...body };
    const actor = sessionFrom(c).login;
    const { value, delta } = captureDelta((onDelta) => domain.createOrUpdateFile(args, { actor }, onDelta));
    return { status: 200, body: value, mutation: true, stateDelta: delta };
  }));
  session.get("/repos/:owner/:repo/commits", (c) => handle(c, recorder, runId, () => ok(domain.listCommits({ ...params(c), sha: c.req.query("sha"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.post("/repos/:owner/:repo/git/refs", (c) => handle(c, recorder, runId, async () => {
    const body = z.object({ ref: z.string().min(1), sha: z.string().optional() }).parse(await readJson(c));
    const branch = body.ref.replace(/^refs\/heads\//, "");
    const { value, delta } = captureDelta((onDelta) => domain.createBranch({ ...params(c), branch, sha: body.sha }, onDelta));
    return created(value, delta);
  }));

  session.get("/repos/:owner/:repo/issues", (c) => handle(c, recorder, runId, () => ok(domain.listIssues({ ...params(c), state: stateQuery(c), labels: c.req.query("labels"), assignee: c.req.query("assignee"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.post("/repos/:owner/:repo/issues", (c) => handle(c, recorder, runId, async () => {
    const args = { ...params(c), ...createIssueSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.createIssue(args, onDelta));
    return created(value, delta);
  }));
  session.get("/repos/:owner/:repo/issues/:number", (c) => handle(c, recorder, runId, () => ok(domain.getIssue({ ...params(c), issue_number: numberParam(c, "number") }))));
  session.patch("/repos/:owner/:repo/issues/:number", (c) => handle(c, recorder, runId, async () => {
    const args = { ...params(c), issue_number: numberParam(c, "number"), ...updateIssueSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.updateIssue(args, onDelta));
    return ok(value, true, delta);
  }));
  session.get("/repos/:owner/:repo/issues/:number/comments", (c) => handle(c, recorder, runId, () => ok(domain.listIssueComments({ ...params(c), issue_number: numberParam(c, "number"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.post("/repos/:owner/:repo/issues/:number/comments", (c) => handle(c, recorder, runId, async () => {
    const args = { ...params(c), issue_number: numberParam(c, "number"), ...commentSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.addIssueComment(args, onDelta));
    return created(value, delta);
  }));
  session.get("/repos/:owner/:repo/labels", (c) => handle(c, recorder, runId, () => ok(domain.listRepositoryLabels(params(c)))));
  session.post("/repos/:owner/:repo/labels", (c) => handle(c, recorder, runId, async () => {
    const args = { ...params(c), ...labelSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.createRepositoryLabel(args, onDelta));
    return created(value, delta);
  }));
  session.get("/repos/:owner/:repo/issues/:number/labels", (c) => handle(c, recorder, runId, () => ok(domain.listIssueLabelsForIssue({ ...params(c), issue_number: numberParam(c, "number") }))));
  session.post("/repos/:owner/:repo/issues/:number/labels", (c) => handle(c, recorder, runId, async () => {
    const args = { ...params(c), issue_number: numberParam(c, "number"), ...labelsSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.addIssueLabels(args, onDelta));
    return ok(value, true, delta);
  }));
  session.delete("/repos/:owner/:repo/issues/:number/labels/:name", (c) => handle(c, recorder, runId, () => {
    const args = { ...params(c), issue_number: numberParam(c, "number"), label: requireParam(c, "name") };
    const { value, delta } = captureDelta((onDelta) => domain.deleteIssueLabel(args, onDelta));
    return ok(value, true, delta);
  }));
  session.get("/repos/:owner/:repo/collaborators", (c) => handle(c, recorder, runId, () => ok(domain.listCollaborators(params(c)))));
  session.get("/repos/:owner/:repo/collaborators/:username", (c) => handle(c, recorder, runId, () => {
    const found = domain.isCollaborator({ ...params(c), username: requireParam(c, "username") });
    if (!found) throw new TwinError("Not Found", 404);
    return { status: 204, body: null, mutation: false };
  }));
  session.post("/repos/:owner/:repo/issues/:number/assignees", (c) => handle(c, recorder, runId, async () => {
    const args = { ...params(c), issue_number: numberParam(c, "number"), ...assigneesSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.addAssignees(args, onDelta));
    return created(value, delta);
  }));

  session.get("/repos/:owner/:repo/pulls", (c) => handle(c, recorder, runId, () => ok(domain.listPullRequests({ ...params(c), state: stateQuery(c), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.post("/repos/:owner/:repo/pulls", (c) => handle(c, recorder, runId, async () => {
    const actor = sessionFrom(c).login;
    const args = { ...params(c), ...createPullSchema.parse(await readJson(c)), actor };
    const { value, delta } = captureDelta((onDelta) => domain.createPullRequest(args, onDelta));
    return created(value, delta);
  }));
  session.get("/repos/:owner/:repo/pulls/:number", (c) => handle(c, recorder, runId, () => ok(domain.getPullRequest({ ...params(c), pull_number: numberParam(c, "number") }))));
  session.get("/repos/:owner/:repo/pulls/:number/files", (c) => handle(c, recorder, runId, () => ok(domain.getPullRequestFiles({ ...params(c), pull_number: numberParam(c, "number"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.get("/repos/:owner/:repo/pulls/:number/reviews", (c) => handle(c, recorder, runId, () => ok(domain.getPullRequestReviews({ ...params(c), pull_number: numberParam(c, "number"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.post("/repos/:owner/:repo/pulls/:number/reviews", (c) => handle(c, recorder, runId, async () => {
    const args = { ...params(c), pull_number: numberParam(c, "number"), ...reviewSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.createPullRequestReview(args, onDelta));
    return created(value, delta);
  }));
  session.get("/repos/:owner/:repo/pulls/:number/comments", (c) => handle(c, recorder, runId, () => ok(domain.getPullRequestComments({ ...params(c), pull_number: numberParam(c, "number"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.get("/repos/:owner/:repo/pulls/:number/status", (c) => handle(c, recorder, runId, () => ok(domain.getPullRequestStatus({ ...params(c), pull_number: numberParam(c, "number") }))));
  session.put("/repos/:owner/:repo/pulls/:number/merge", (c) => handle(c, recorder, runId, async () => {
    const args = { ...params(c), pull_number: numberParam(c, "number"), ...mergeSchema.parse(await maybeJson(c)) };
    const actor = sessionFrom(c).login;
    if (!actor || !domain.hasRepositoryPermission({ owner: args.owner, repo: args.repo, username: actor, permissions: ["push", "maintain", "admin"] })) {
      throw new TwinError("Must have push access to the repository to merge pull requests.", 403);
    }
    const { value, delta } = captureDelta((onDelta) => domain.mergePullRequest(args, onDelta));
    return ok(value, true, delta);
  }));
  session.put("/repos/:owner/:repo/pulls/:number/update-branch", (c) => handle(c, recorder, runId, async () => {
    const args = { ...params(c), pull_number: numberParam(c, "number"), ...updateBranchSchema.parse(await maybeJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.updatePullRequestBranch(args, onDelta));
    return ok(value, true, delta);
  }));

  // ===== v2 hot paths (FDRS-300) =========================================
  // Cluster A — branches & files
  session.get("/repos/:owner/:repo/branches", (c) => handle(c, recorder, runId, () => ok(domain.listBranchesForRepo({ ...params(c), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.get("/repos/:owner/:repo/branches/*", (c) => handle(c, recorder, runId, () => ok(domain.getBranchByName({ ...params(c), branch: routeTail(c, "branches/") }))));
  session.delete("/repos/:owner/:repo/git/refs/heads/*", (c) => handle(c, recorder, runId, () => {
    const args = { ...params(c), branch: routeTail(c, "git/refs/heads/") };
    const { delta } = captureDelta((onDelta) => domain.deleteBranch(args, onDelta));
    return { status: 204, body: null, mutation: true, stateDelta: delta };
  }));
  session.delete("/repos/:owner/:repo/contents/*", (c) => handle(c, recorder, runId, async () => {
    const body = deleteFileSchema.parse(await readJson(c));
    const args = { ...params(c), path: contentPath(c), ...body };
    const actor = sessionFrom(c).login;
    const { value, delta } = captureDelta((onDelta) => domain.deleteFile(args, { actor }, onDelta));
    return ok(value, true, delta);
  }));

  // Cluster B — commits & diffs
  session.get("/repos/:owner/:repo/commits/:ref", (c) => handle(c, recorder, runId, () => ok(domain.getCommitWithFiles({ ...params(c), ref: requireParam(c, "ref") }))));
  session.get("/repos/:owner/:repo/compare/:basehead{.+}", (c) => handle(c, recorder, runId, () => {
    const basehead = requireParam(c, "basehead");
    const parts = basehead.split("...");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new TwinError("Invalid compare ref. Expected 'base...head'.", 422);
    }
    return ok(domain.compareCommits({ ...params(c), base: parts[0], head: parts[1] }));
  }));
  session.get("/repos/:owner/:repo/pulls/:number/diff", (c) => handle(c, recorder, runId, () => ok(domain.getPullRequestDiff({ ...params(c), pull_number: numberParam(c, "number") }))));

  // Cluster C — pull requests deeper
  session.patch("/repos/:owner/:repo/pulls/:number", (c) => handle(c, recorder, runId, async () => {
    const args = { ...params(c), pull_number: numberParam(c, "number"), ...updatePrSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.updatePullRequest(args, onDelta));
    return ok(value, true, delta);
  }));
  session.get("/repos/:owner/:repo/pulls/:number/commits", (c) => handle(c, recorder, runId, () => ok(domain.getPullRequestCommits({ ...params(c), pull_number: numberParam(c, "number"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.post("/repos/:owner/:repo/pulls/:number/comments", (c) => handle(c, recorder, runId, async () => {
    const args = { ...params(c), pull_number: numberParam(c, "number"), ...reviewCommentSchema.parse(await readJson(c)) };
    const actor = sessionFrom(c).login;
    const { value, delta } = captureDelta((onDelta) => domain.createPullRequestReviewComment(args, { actor }, onDelta));
    return created(value, delta);
  }));
  session.post("/repos/:owner/:repo/pulls/:number/comments/:comment_id/replies", (c) => handle(c, recorder, runId, async () => {
    const args = { ...params(c), pull_number: numberParam(c, "number"), comment_id: numberParam(c, "comment_id"), ...replyCommentSchema.parse(await readJson(c)) };
    const actor = sessionFrom(c).login;
    const { value, delta } = captureDelta((onDelta) => domain.addReplyToPullRequestComment(args, { actor }, onDelta));
    return created(value, delta);
  }));

  // Cluster D — issue comments deeper
  session.patch("/repos/:owner/:repo/issues/comments/:comment_id", (c) => handle(c, recorder, runId, async () => {
    const args = { ...params(c), comment_id: numberParam(c, "comment_id"), ...updateCommentSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.updateIssueComment(args, onDelta));
    return ok(value, true, delta);
  }));
  session.delete("/repos/:owner/:repo/issues/comments/:comment_id", (c) => handle(c, recorder, runId, () => {
    const args = { ...params(c), comment_id: numberParam(c, "comment_id") };
    const { delta } = captureDelta((onDelta) => domain.deleteIssueComment(args, onDelta));
    return { status: 204, body: null, mutation: true, stateDelta: delta };
  }));

  // Cluster E — milestones
  session.get("/repos/:owner/:repo/milestones", (c) => handle(c, recorder, runId, () => ok(domain.listMilestones({ ...params(c), state: stateQuery(c), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.post("/repos/:owner/:repo/milestones", (c) => handle(c, recorder, runId, async () => {
    const args = { ...params(c), ...milestoneSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.createMilestone(args, onDelta));
    return created(value, delta);
  }));
  session.patch("/repos/:owner/:repo/milestones/:number", (c) => handle(c, recorder, runId, async () => {
    const args = { ...params(c), milestone_number: numberParam(c, "number"), ...updateMilestoneSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.updateMilestone(args, onDelta));
    return ok(value, true, delta);
  }));
  session.delete("/repos/:owner/:repo/milestones/:number", (c) => handle(c, recorder, runId, () => {
    const args = { ...params(c), milestone_number: numberParam(c, "number") };
    const { delta } = captureDelta((onDelta) => domain.deleteMilestone(args, onDelta));
    return { status: 204, body: null, mutation: true, stateDelta: delta };
  }));

  // Cluster F — commit status + checks
  session.post("/repos/:owner/:repo/statuses/:sha", (c) => handle(c, recorder, runId, async () => {
    const args = { ...params(c), sha: requireParam(c, "sha"), ...createStatusSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.createCommitStatus(args, onDelta));
    return created(value, delta);
  }));
  session.get("/repos/:owner/:repo/commits/:ref/status", (c) => handle(c, recorder, runId, () => ok(domain.getCombinedStatusForRef({ ...params(c), ref: requireParam(c, "ref") }))));
  session.post("/repos/:owner/:repo/check-runs", (c) => handle(c, recorder, runId, async () => {
    const args = { ...params(c), ...createCheckRunSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.createCheckRun(args, onDelta));
    return created(value, delta);
  }));
  session.get("/repos/:owner/:repo/commits/:ref/check-runs", (c) => handle(c, recorder, runId, () => ok(domain.listCheckRunsForRef({ ...params(c), ref: requireParam(c, "ref"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));

  // Cluster G — tags & releases
  session.get("/repos/:owner/:repo/tags", (c) => handle(c, recorder, runId, () => ok(domain.listTags({ ...params(c), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.get("/repos/:owner/:repo/releases", (c) => handle(c, recorder, runId, () => ok(domain.listReleases({ ...params(c), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.get("/repos/:owner/:repo/releases/latest", (c) => handle(c, recorder, runId, () => ok(domain.getLatestRelease(params(c)))));
  session.post("/repos/:owner/:repo/releases", (c) => handle(c, recorder, runId, async () => {
    const args = { ...params(c), ...createReleaseSchema.parse(await readJson(c)) };
    const actor = sessionFrom(c).login;
    const { value, delta } = captureDelta((onDelta) => domain.createRelease(args, { actor }, onDelta));
    return created(value, delta);
  }));

  // Cluster H — identity & collaborators
  session.get("/user", (c) => handle(c, recorder, runId, () => {
    const actor = sessionFrom(c).login;
    return ok(domain.getMe({ actor }));
  }));
  session.put("/repos/:owner/:repo/collaborators/:username", (c) => handle(c, recorder, runId, async () => {
    const body = addCollaboratorSchema.parse(await maybeJson(c));
    const actor = sessionFrom(c).login;
    if (!actor || !domain.hasRepositoryPermission({ ...params(c), username: actor, permissions: ["push", "maintain", "admin"] })) {
      throw new TwinError("Must have push access to the repository to add collaborators.", 403);
    }
    const args = { ...params(c), username: requireParam(c, "username"), permission: body.permission };
    const { value, delta } = captureDelta((onDelta) => domain.addCollaboratorAction({ ...args, actor }, onDelta));
    return { status: value.status, body: value.body, mutation: true, stateDelta: delta };
  }));

  // FDRS-431: twin-only fields (`fidelity`, `supported_surfaces`) live under the
  // `_twin` namespace, matching twin-slack / twin-stripe. Clean cutover — no bare
  // top-level `fidelity` key. The envelope is defined once in
  // ./unsupported-envelope.ts so the cross-twin namespace lint checks the shipped
  // shape. The recorder's own `fidelity` arg below is internal tape telemetry, not
  // the response envelope.
  session.all("*", (c) =>
    respond(c, recorder, runId, Date.now(), null, unsupportedEnvelope.status, unsupportedEnvelope.body, false, "unsupported")
  );

  root.route("/s/:sid", session);

  return root;
}

function ok(body: unknown, mutation = false, stateDelta: StateDelta = null): HandleResult {
  return { status: 200, body, mutation, stateDelta };
}

function created(body: unknown, stateDelta: StateDelta = null): HandleResult {
  return { status: 201, body, mutation: true, stateDelta };
}

async function handle(
  c: Context,
  recorder: Recorder | undefined,
  runId: string,
  fn: () => Promise<HandleResult> | HandleResult
) {
  const started = Date.now();
  let requestBody: unknown = null;
  try {
    requestBody = c.req.method === "GET" || c.req.method === "HEAD" ? null : await c.req.raw.clone().json().catch(() => null);
    const result = await fn();
    return respond(c, recorder, runId, started, requestBody, result.status, result.body, result.mutation, "semantic", result.stateDelta ?? null);
  } catch (error) {
    if (error instanceof TwinError) {
      return respond(c, recorder, runId, started, requestBody, error.status, githubError(error.message, error.status, error.errors), false);
    }
    if (error instanceof z.ZodError) {
      return respond(c, recorder, runId, started, requestBody, 422, githubError("Validation Failed", 422, error.issues.map((issue) => ({
        resource: "Request",
        field: issue.path.join("."),
        code: issue.code
      }))), false);
    }
    if (error instanceof SyntaxError) {
      return respond(c, recorder, runId, started, requestBody, 400, githubError("Problems parsing JSON", 400), false);
    }
    return respond(c, recorder, runId, started, requestBody, 500, githubError(error instanceof Error ? error.message : "Internal Server Error", 500), false);
  }
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
  fidelity: "semantic" | "unsupported" = "semantic",
  stateDelta: StateDelta = null
) {
  const reqId = requestId();
  const correlationHeader = c.req.header("x-pome-correlation-id") ?? null;
  recorder?.record({
    ts: new Date().toISOString(),
    run_id: runId,
    twin: "github",
    request_id: reqId,
    // FDRS-402: persist the adapter's x-pome-correlation-id as `correlation_id`
    // (legacy correlator path) and as `tool_call_id` (adapter-rich path).
    // When the header is absent we keep the heuristic-path fallback: reqId for
    // correlation_id, null for tool_call_id.
    correlation_id: correlationHeader ?? reqId,
    scenario_step_id: c.req.header("x-pome-scenario-step-id") ?? null,
    step_id: null,
    tool_call_id: correlationHeader,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    request_body: requestBody,
    status,
    response_body: responseBody,
    latency_ms: Date.now() - started,
    fidelity,
    state_mutation: stateMutation,
    state_delta: stateDelta,
    error: status >= 400 ? (responseBody as { message?: string }).message ?? "request failed" : null
  });
  if (status === 204) return c.body(null, status as never);
  return c.json(responseBody, status as never);
}

async function readJson(c: Context) {
  try {
    return await c.req.json();
  } catch {
    throw new SyntaxError("Problems parsing JSON");
  }
}

async function maybeJson(c: Context) {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function params(c: Context) {
  return { owner: requireParam(c, "owner"), repo: requireParam(c, "repo") };
}

function sessionFrom(c: Context): Session {
  return (c.get("session") as Session | undefined) ?? { sid: "", team_id: "" };
}

function numberParam(c: Context, name: string) {
  const value = Number(c.req.param(name));
  if (!Number.isInteger(value) || value < 1) validationFailed(name, "invalid", c.req.param(name));
  return value;
}

function requireParam(c: Context, name: string) {
  const value = c.req.param(name);
  if (!value) throw new TwinError(`Missing route parameter: ${name}`, 400);
  return value;
}

function contentPath(c: Context) {
  return routeTail(c, "contents/");
}

function routeTail(c: Context, marker: string) {
  const { owner, repo } = params(c);
  const sid = c.req.param("sid");
  const pathname = new URL(c.req.url).pathname;
  const prefix = `/s/${sid}/repos/${owner}/${repo}/${marker}`;
  const value = decodeURIComponent(pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "");
  if (!value) throw new TwinError(`Missing route path after ${marker}`, 400);
  return value;
}

function numberQuery(c: Context, name: string) {
  const value = c.req.query(name);
  return value ? Number(value) : undefined;
}

function stateQuery(c: Context) {
  const state = c.req.query("state");
  return state === "open" || state === "closed" || state === "all" ? state : undefined;
}

