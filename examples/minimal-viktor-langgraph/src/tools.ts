/**
 * The twin surface as LangChain tools.
 *
 * Each tool maps to exactly one supported twin endpoint (same set as
 * `examples/minimal-viktor`), so the agent can never hit an unsupported route.
 * Invoking a tool via `.invoke()` (which the graph nodes do) opens an
 * OpenInference `TOOL` span carrying `tool.name` — that is what pome's projector
 * maps onto `gen_ai_tool_name` so tool calls render as `tool` rows on the span
 * waterfall.
 *
 * Errors are handed back to the caller as a value (`{ ok: false, ... }`) rather
 * than thrown, so one failed twin call doesn't abort the whole graph run.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export interface TwinConfig {
  ghUrl: string;
  ghToken: string | undefined;
  slackUrl: string;
  slackToken: string | undefined;
}

async function twinFetch(
  base: string,
  token: string | undefined,
  path: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Network/abort errors are handed back as a value, not thrown, so one bad
    // twin call can't abort the whole graph run.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, error: text || res.statusText };
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, status: res.status, error: `non-JSON response: ${text.slice(0, 200)}` };
  }
}

export function buildTools(config: TwinConfig) {
  const gh = (path: string, method = "GET", body?: unknown) =>
    twinFetch(config.ghUrl, config.ghToken, path, method, body);
  const slack = (path: string, body: Record<string, unknown>) =>
    twinFetch(config.slackUrl, config.slackToken, path, "POST", body);

  const list_open_pull_requests = tool(
    ({ owner, repo }) => gh(`/repos/${owner}/${repo}/pulls?state=open`),
    {
      name: "list_open_pull_requests",
      description: "List the open pull requests in a repository.",
      schema: z.object({ owner: z.string(), repo: z.string() }),
    },
  );

  const get_pull_request = tool(
    ({ owner, repo, number }) => gh(`/repos/${owner}/${repo}/pulls/${number}`),
    {
      name: "get_pull_request",
      description: "Get one pull request: title, body, author login, branches, mergeable state.",
      schema: z.object({ owner: z.string(), repo: z.string(), number: z.number() }),
    },
  );

  const get_pull_request_files = tool(
    ({ owner, repo, number }) => gh(`/repos/${owner}/${repo}/pulls/${number}/files`),
    {
      name: "get_pull_request_files",
      description: "List the files changed by a pull request.",
      schema: z.object({ owner: z.string(), repo: z.string(), number: z.number() }),
    },
  );

  const get_pull_request_status = tool(
    ({ owner, repo, number }) => gh(`/repos/${owner}/${repo}/pulls/${number}/status`),
    {
      name: "get_pull_request_status",
      description: "Get the combined CI/commit status for a pull request's head commit.",
      schema: z.object({ owner: z.string(), repo: z.string(), number: z.number() }),
    },
  );

  const get_file_contents = tool(
    ({ owner, repo, path, ref }) =>
      gh(`/repos/${owner}/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`),
    {
      name: "get_file_contents",
      description: "Read a file's contents at a ref/branch (content is base64-encoded).",
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        path: z.string(),
        ref: z.string().optional(),
      }),
    },
  );

  const list_collaborators = tool(
    ({ owner, repo }) => gh(`/repos/${owner}/${repo}/collaborators`),
    {
      name: "list_collaborators",
      description:
        "List the users who are authorized collaborators (have write access) on the repository.",
      schema: z.object({ owner: z.string(), repo: z.string() }),
    },
  );

  const merge_pull_request = tool(
    ({ owner, repo, number }) => gh(`/repos/${owner}/${repo}/pulls/${number}/merge`, "PUT"),
    {
      name: "merge_pull_request",
      description: "Merge a pull request into its base branch.",
      schema: z.object({ owner: z.string(), repo: z.string(), number: z.number() }),
    },
  );

  const request_changes = tool(
    ({ owner, repo, number, body }) =>
      gh(`/repos/${owner}/${repo}/pulls/${number}/reviews`, "POST", {
        event: "REQUEST_CHANGES",
        body,
      }),
    {
      name: "request_changes",
      description: "Decline a pull request by leaving a REQUEST_CHANGES review with a reason.",
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        number: z.number(),
        body: z.string(),
      }),
    },
  );

  const slack_post_message = tool(
    ({ channel, text }) => slack("/chat.postMessage", { channel, text }),
    {
      name: "slack_post_message",
      description: "Post a message to a Slack channel (channel by name, without the leading #).",
      schema: z.object({ channel: z.string(), text: z.string() }),
    },
  );

  return {
    list_open_pull_requests,
    get_pull_request,
    get_pull_request_files,
    get_pull_request_status,
    get_file_contents,
    list_collaborators,
    merge_pull_request,
    request_changes,
    slack_post_message,
  };
}

export type Tools = ReturnType<typeof buildTools>;
