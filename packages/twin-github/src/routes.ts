// SPDX-License-Identifier: Apache-2.0
//
// GitHub REST domain routes (F-682). Pure domain shape: every handler maps
// wire args (path params, query, JSON body) onto a GitHubDomain call and
// returns the GitHub-shaped result with its frozen status code. Everything
// cross-cutting — auth, recording, redaction, error envelopes, the 501
// catch-all — is the engine's (`@pome-sh/sdk`), wired through the twin
// manifest in ./twin.ts.

import type { Context, Hono } from "hono";
import { z } from "zod";
import type { RouteContext } from "@pome-sh/sdk";
import type { StateDelta } from "@pome-sh/shared-types";
import type { GitHubDomain } from "./domain.js";
import { TwinError, validationFailed } from "./errors.js";

type HandleResult = { status: number; body: unknown; mutation?: boolean; delta?: StateDelta };

function captureDelta<T>(fn: (onDelta: (delta: StateDelta) => void) => T): { value: T; delta: StateDelta } {
  let delta: StateDelta = null;
  const value = fn((d) => { delta = d; });
  return { value, delta };
}

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

export function registerGitHubRoutes(session: Hono, { domain, recorder }: RouteContext<GitHubDomain>): void {
  /** Route wrapper: engine recorder middleware with the handler's own result. */
  const handle = (fn: (c: Context) => Promise<HandleResult> | HandleResult) =>
    recorder.handle({ mutation: false }, async (c) => {
      const result = await fn(c);
      return { status: result.status, body: result.body, mutation: result.mutation ?? false, delta: result.delta ?? null };
    });

  session.get("/search/repositories", handle((c) => ok(domain.searchRepositories({ q: c.req.query("q"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.get("/search/code", handle((c) => ok(domain.searchCode({ q: c.req.query("q"), owner: c.req.query("owner"), repo: c.req.query("repo"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.get("/search/issues", handle((c) => ok(domain.searchIssues({ q: c.req.query("q"), owner: c.req.query("owner"), repo: c.req.query("repo"), state: stateQuery(c), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.get("/search/users", handle((c) => ok(domain.searchUsers({ q: c.req.query("q"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.get("/search/commits", handle((c) => ok(domain.searchCommits({ q: c.req.query("q"), owner: c.req.query("owner"), repo: c.req.query("repo"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));

  session.get("/repos/:owner/:repo", handle((c) => ok(domain.getRepository(params(c)))));
  session.post("/user/repos", handle(async (c) => {
    const args = createRepoSchema.parse(await readJson(c));
    const { value, delta } = captureDelta((onDelta) => domain.createRepository(args, onDelta));
    return created(value, delta);
  }));
  session.post("/orgs/:owner/repos", handle(async (c) => {
    const args = { ...createRepoSchema.parse(await readJson(c)), owner: c.req.param("owner") };
    const { value, delta } = captureDelta((onDelta) => domain.createRepository(args, onDelta));
    return created(value, delta);
  }));
  session.post("/repos/:owner/:repo/forks", handle(async (c) => {
    const organization = (await maybeJson(c)).organization as string | undefined;
    const { value, delta } = captureDelta((onDelta) => domain.forkRepository({ ...params(c), organization }, onDelta));
    return created(value, delta);
  }));

  session.get("/repos/:owner/:repo/contents", handle((c) => ok(domain.getFileContents({ ...params(c), path: "", ref: c.req.query("ref") }))));
  session.get("/repos/:owner/:repo/contents/*", handle((c) => ok(domain.getFileContents({ ...params(c), path: contentPath(c), ref: c.req.query("ref") }))));
  session.put("/repos/:owner/:repo/contents/*", handle(async (c) => {
    const body = contentSchema.parse(await readJson(c));
    const args = { ...params(c), path: contentPath(c), ...body };
    const actor = sessionLogin(c);
    const { value, delta } = captureDelta((onDelta) => domain.createOrUpdateFile(args, { actor }, onDelta));
    // GitHub returns 201 Created when the file did not previously exist and 200
    // OK when an existing file is updated (FDRS-596). The domain reports a
    // `before: null` delta for an insert (documented convention in
    // shared-types' stateDeltaSchema).
    const status = delta !== null && delta.before === null ? 201 : 200;
    return { status, body: value, mutation: true, delta };
  }));
  session.get("/repos/:owner/:repo/commits", handle((c) => ok(domain.listCommits({ ...params(c), sha: c.req.query("sha"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.post("/repos/:owner/:repo/git/refs", handle(async (c) => {
    const body = z.object({ ref: z.string().min(1), sha: z.string().optional() }).parse(await readJson(c));
    const branch = body.ref.replace(/^refs\/heads\//, "");
    const { value, delta } = captureDelta((onDelta) => domain.createBranch({ ...params(c), branch, sha: body.sha }, onDelta));
    return created(value, delta);
  }));

  session.get("/repos/:owner/:repo/issues", handle((c) => ok(domain.listIssues({ ...params(c), state: stateQuery(c), labels: c.req.query("labels"), assignee: c.req.query("assignee"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.post("/repos/:owner/:repo/issues", handle(async (c) => {
    const args = { ...params(c), ...createIssueSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.createIssue(args, onDelta));
    return created(value, delta);
  }));
  session.get("/repos/:owner/:repo/issues/:number", handle((c) => ok(domain.getIssue({ ...params(c), issue_number: numberParam(c, "number") }))));
  session.patch("/repos/:owner/:repo/issues/:number", handle(async (c) => {
    const args = { ...params(c), issue_number: numberParam(c, "number"), ...updateIssueSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.updateIssue(args, onDelta));
    return ok(value, true, delta);
  }));
  session.get("/repos/:owner/:repo/issues/:number/comments", handle((c) => ok(domain.listIssueComments({ ...params(c), issue_number: numberParam(c, "number"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.post("/repos/:owner/:repo/issues/:number/comments", handle(async (c) => {
    const args = { ...params(c), issue_number: numberParam(c, "number"), ...commentSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.addIssueComment(args, onDelta));
    return created(value, delta);
  }));
  session.get("/repos/:owner/:repo/labels", handle((c) => ok(domain.listRepositoryLabels(params(c)))));
  session.post("/repos/:owner/:repo/labels", handle(async (c) => {
    const args = { ...params(c), ...labelSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.createRepositoryLabel(args, onDelta));
    return created(value, delta);
  }));
  session.get("/repos/:owner/:repo/issues/:number/labels", handle((c) => ok(domain.listIssueLabelsForIssue({ ...params(c), issue_number: numberParam(c, "number") }))));
  session.post("/repos/:owner/:repo/issues/:number/labels", handle(async (c) => {
    const args = { ...params(c), issue_number: numberParam(c, "number"), ...labelsSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.addIssueLabels(args, onDelta));
    return ok(value, true, delta);
  }));
  session.delete("/repos/:owner/:repo/issues/:number/labels/:name", handle((c) => {
    const args = { ...params(c), issue_number: numberParam(c, "number"), label: requireParam(c, "name") };
    const { value, delta } = captureDelta((onDelta) => domain.deleteIssueLabel(args, onDelta));
    return ok(value, true, delta);
  }));
  session.get("/repos/:owner/:repo/collaborators", handle((c) => ok(domain.listCollaborators(params(c)))));
  session.get("/repos/:owner/:repo/collaborators/:username", handle((c) => {
    const found = domain.isCollaborator({ ...params(c), username: requireParam(c, "username") });
    if (!found) throw new TwinError("Not Found", 404);
    return { status: 204, body: null, mutation: false };
  }));
  session.post("/repos/:owner/:repo/issues/:number/assignees", handle(async (c) => {
    const args = { ...params(c), issue_number: numberParam(c, "number"), ...assigneesSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.addAssignees(args, onDelta));
    return created(value, delta);
  }));

  session.get("/repos/:owner/:repo/pulls", handle((c) => ok(domain.listPullRequests({ ...params(c), state: stateQuery(c), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.post("/repos/:owner/:repo/pulls", handle(async (c) => {
    const actor = sessionLogin(c);
    const args = { ...params(c), ...createPullSchema.parse(await readJson(c)), actor };
    const { value, delta } = captureDelta((onDelta) => domain.createPullRequest(args, onDelta));
    return created(value, delta);
  }));
  session.get("/repos/:owner/:repo/pulls/:number", handle((c) => ok(domain.getPullRequest({ ...params(c), pull_number: numberParam(c, "number") }))));
  session.get("/repos/:owner/:repo/pulls/:number/files", handle((c) => ok(domain.getPullRequestFiles({ ...params(c), pull_number: numberParam(c, "number"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.get("/repos/:owner/:repo/pulls/:number/reviews", handle((c) => ok(domain.getPullRequestReviews({ ...params(c), pull_number: numberParam(c, "number"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.post("/repos/:owner/:repo/pulls/:number/reviews", handle(async (c) => {
    const args = { ...params(c), pull_number: numberParam(c, "number"), ...reviewSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.createPullRequestReview(args, onDelta));
    return created(value, delta);
  }));
  session.get("/repos/:owner/:repo/pulls/:number/comments", handle((c) => ok(domain.getPullRequestComments({ ...params(c), pull_number: numberParam(c, "number"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.get("/repos/:owner/:repo/pulls/:number/status", handle((c) => ok(domain.getPullRequestStatus({ ...params(c), pull_number: numberParam(c, "number") }))));
  session.put("/repos/:owner/:repo/pulls/:number/merge", handle(async (c) => {
    const args = { ...params(c), pull_number: numberParam(c, "number"), ...mergeSchema.parse(await maybeJson(c)) };
    const actor = sessionLogin(c);
    if (!actor || !domain.hasRepositoryPermission({ owner: args.owner, repo: args.repo, username: actor, permissions: ["push", "maintain", "admin"] })) {
      throw new TwinError("Must have push access to the repository to merge pull requests.", 403);
    }
    const { value, delta } = captureDelta((onDelta) => domain.mergePullRequest(args, onDelta));
    return ok(value, true, delta);
  }));
  session.put("/repos/:owner/:repo/pulls/:number/update-branch", handle(async (c) => {
    const args = { ...params(c), pull_number: numberParam(c, "number"), ...updateBranchSchema.parse(await maybeJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.updatePullRequestBranch(args, onDelta));
    return ok(value, true, delta);
  }));

  // ===== v2 hot paths (FDRS-300) =========================================
  // Cluster A — branches & files
  session.get("/repos/:owner/:repo/branches", handle((c) => ok(domain.listBranchesForRepo({ ...params(c), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.get("/repos/:owner/:repo/branches/*", handle((c) => ok(domain.getBranchByName({ ...params(c), branch: routeTail(c, "branches/") }))));
  session.delete("/repos/:owner/:repo/git/refs/heads/*", handle((c) => {
    const args = { ...params(c), branch: routeTail(c, "git/refs/heads/") };
    const { delta } = captureDelta((onDelta) => domain.deleteBranch(args, onDelta));
    return { status: 204, body: null, mutation: true, delta };
  }));
  session.delete("/repos/:owner/:repo/contents/*", handle(async (c) => {
    const body = deleteFileSchema.parse(await readJson(c));
    const args = { ...params(c), path: contentPath(c), ...body };
    const actor = sessionLogin(c);
    const { value, delta } = captureDelta((onDelta) => domain.deleteFile(args, { actor }, onDelta));
    return ok(value, true, delta);
  }));

  // Cluster B — commits & diffs
  session.get("/repos/:owner/:repo/commits/:ref", handle((c) => ok(domain.getCommitWithFiles({ ...params(c), ref: requireParam(c, "ref") }))));
  session.get("/repos/:owner/:repo/compare/:basehead{.+}", handle((c) => {
    const basehead = requireParam(c, "basehead");
    const parts = basehead.split("...");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new TwinError("Invalid compare ref. Expected 'base...head'.", 422);
    }
    return ok(domain.compareCommits({ ...params(c), base: parts[0], head: parts[1] }));
  }));
  session.get("/repos/:owner/:repo/pulls/:number/diff", handle((c) => ok(domain.getPullRequestDiff({ ...params(c), pull_number: numberParam(c, "number") }))));

  // Cluster C — pull requests deeper
  session.patch("/repos/:owner/:repo/pulls/:number", handle(async (c) => {
    const args = { ...params(c), pull_number: numberParam(c, "number"), ...updatePrSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.updatePullRequest(args, onDelta));
    return ok(value, true, delta);
  }));
  session.get("/repos/:owner/:repo/pulls/:number/commits", handle((c) => ok(domain.getPullRequestCommits({ ...params(c), pull_number: numberParam(c, "number"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.post("/repos/:owner/:repo/pulls/:number/comments", handle(async (c) => {
    const args = { ...params(c), pull_number: numberParam(c, "number"), ...reviewCommentSchema.parse(await readJson(c)) };
    const actor = sessionLogin(c);
    const { value, delta } = captureDelta((onDelta) => domain.createPullRequestReviewComment(args, { actor }, onDelta));
    return created(value, delta);
  }));
  session.post("/repos/:owner/:repo/pulls/:number/comments/:comment_id/replies", handle(async (c) => {
    const args = { ...params(c), pull_number: numberParam(c, "number"), comment_id: numberParam(c, "comment_id"), ...replyCommentSchema.parse(await readJson(c)) };
    const actor = sessionLogin(c);
    const { value, delta } = captureDelta((onDelta) => domain.addReplyToPullRequestComment(args, { actor }, onDelta));
    return created(value, delta);
  }));

  // Cluster D — issue comments deeper
  session.patch("/repos/:owner/:repo/issues/comments/:comment_id", handle(async (c) => {
    const args = { ...params(c), comment_id: numberParam(c, "comment_id"), ...updateCommentSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.updateIssueComment(args, onDelta));
    return ok(value, true, delta);
  }));
  session.delete("/repos/:owner/:repo/issues/comments/:comment_id", handle((c) => {
    const args = { ...params(c), comment_id: numberParam(c, "comment_id") };
    const { delta } = captureDelta((onDelta) => domain.deleteIssueComment(args, onDelta));
    return { status: 204, body: null, mutation: true, delta };
  }));

  // Cluster E — milestones
  session.get("/repos/:owner/:repo/milestones", handle((c) => ok(domain.listMilestones({ ...params(c), state: stateQuery(c), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.post("/repos/:owner/:repo/milestones", handle(async (c) => {
    const args = { ...params(c), ...milestoneSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.createMilestone(args, onDelta));
    return created(value, delta);
  }));
  session.patch("/repos/:owner/:repo/milestones/:number", handle(async (c) => {
    const args = { ...params(c), milestone_number: numberParam(c, "number"), ...updateMilestoneSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.updateMilestone(args, onDelta));
    return ok(value, true, delta);
  }));
  session.delete("/repos/:owner/:repo/milestones/:number", handle((c) => {
    const args = { ...params(c), milestone_number: numberParam(c, "number") };
    const { delta } = captureDelta((onDelta) => domain.deleteMilestone(args, onDelta));
    return { status: 204, body: null, mutation: true, delta };
  }));

  // Cluster F — commit status + checks
  session.post("/repos/:owner/:repo/statuses/:sha", handle(async (c) => {
    const args = { ...params(c), sha: requireParam(c, "sha"), ...createStatusSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.createCommitStatus(args, onDelta));
    return created(value, delta);
  }));
  session.get("/repos/:owner/:repo/commits/:ref/status", handle((c) => ok(domain.getCombinedStatusForRef({ ...params(c), ref: requireParam(c, "ref") }))));
  session.post("/repos/:owner/:repo/check-runs", handle(async (c) => {
    const args = { ...params(c), ...createCheckRunSchema.parse(await readJson(c)) };
    const { value, delta } = captureDelta((onDelta) => domain.createCheckRun(args, onDelta));
    return created(value, delta);
  }));
  session.get("/repos/:owner/:repo/commits/:ref/check-runs", handle((c) => ok(domain.listCheckRunsForRef({ ...params(c), ref: requireParam(c, "ref"), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));

  // Cluster G — tags & releases
  session.get("/repos/:owner/:repo/tags", handle((c) => ok(domain.listTags({ ...params(c), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.get("/repos/:owner/:repo/releases", handle((c) => ok(domain.listReleases({ ...params(c), page: numberQuery(c, "page"), per_page: numberQuery(c, "per_page") }))));
  session.get("/repos/:owner/:repo/releases/latest", handle((c) => ok(domain.getLatestRelease(params(c)))));
  session.get("/repos/:owner/:repo/releases/tags/:tag", handle((c) => ok(domain.getReleaseByTag({ ...params(c), tag: requireParam(c, "tag") }))));
  session.post("/repos/:owner/:repo/releases", handle(async (c) => {
    const args = { ...params(c), ...createReleaseSchema.parse(await readJson(c)) };
    const actor = sessionLogin(c);
    const { value, delta } = captureDelta((onDelta) => domain.createRelease(args, { actor }, onDelta));
    return created(value, delta);
  }));

  // Cluster H — identity & collaborators
  session.get("/user", handle((c) => ok(domain.getMe({ actor: sessionLogin(c) }))));
  session.put("/repos/:owner/:repo/collaborators/:username", handle(async (c) => {
    const body = addCollaboratorSchema.parse(await maybeJson(c));
    const actor = sessionLogin(c);
    if (!actor || !domain.hasRepositoryPermission({ ...params(c), username: actor, permissions: ["push", "maintain", "admin"] })) {
      throw new TwinError("Must have push access to the repository to add collaborators.", 403);
    }
    const args = { ...params(c), username: requireParam(c, "username"), permission: body.permission };
    const { value, delta } = captureDelta((onDelta) => domain.addCollaboratorAction({ ...args, actor }, onDelta));
    return { status: value.status, body: value.body, mutation: true, delta };
  }));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function ok(body: unknown, mutation = false, delta: StateDelta = null): HandleResult {
  return { status: 200, body, mutation, delta };
}

function created(body: unknown, delta: StateDelta = null): HandleResult {
  return { status: 201, body, mutation: true, delta };
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

function sessionLogin(c: Context): string | undefined {
  const session = c.get("session") as { login?: unknown } | undefined;
  return typeof session?.login === "string" ? session.login : undefined;
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
  const pathname = new URL(c.req.url).pathname;
  // The session mount is always /s/:sid — derive the sid from the pathname
  // (route params from the parent mount are not visible in a nested app).
  const sid = pathname.match(/^\/s\/([^/]+)\//)?.[1] ?? "";
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
