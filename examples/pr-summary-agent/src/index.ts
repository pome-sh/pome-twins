/**
 * Pome bundled example: pr-summary-agent.
 *
 * A small Claude Agent SDK agent that summarizes pull requests on a
 * GitHub-shaped Pome twin. For each open PR it reads the title, body, changed
 * files, and unified diff, then posts a structured summary comment (what
 * changed, why, risk, and a review checklist).
 *
 * Two run modes share the same code path:
 *
 * 1. Standalone — boot the twin via `docker compose up` from the repo root,
 *    then `bun run start` from this directory. The agent reads the auto-
 *    generated secret from `<repo-root>/.pome-data/secret`, mints its own
 *    bearer JWT, and talks to the twin at http://127.0.0.1:3333/s/demo/mcp.
 *
 * 2. Pome CLI evaluator — `pome run <scenario>.md --agent="bun run start"`.
 *    The CLI spins up its own twin on a random port, seeds the scenario, mints
 *    the JWT itself, and passes the URL + token to the agent via env
 *    (POME_GITHUB_MCP_URL, POME_AUTH_TOKEN, POME_TASK).
 *
 * Claude credentials: the agent loop needs an Anthropic API key. It is
 * resolved from `ANTHROPIC_API_KEY` if present, otherwise pulled from
 * Infisical via the `infisical` CLI (see resolveAnthropicKey). That lets you
 * keep the key in Infisical and never export it into your shell.
 *
 * The agent uses the Claude Agent SDK's in-process MCP server to expose tools
 * to the model. Each tool wraps a single call to the twin's MCP surface
 * (POST /s/:sid/mcp/call) — using the MCP shape (not raw REST) keeps the
 * wrapper aligned with the twin's tool contract.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `withPome()` installs a `globalThis.fetch` hook that emits adapter signals to
// `POME_ADAPTER_SIGNALS_PATH` (Pome CLI injects this env var) and an
// `x-pome-correlation-id` header on outgoing fetches so the twin recorder links
// each twin-HTTP row back to the originating tool call. `tool` and `query` are
// drop-in replacements for the upstream SDK exports. `createSdkMcpServer` is not
// part of the adapter's surface; keep importing it from the SDK directly.
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { query, tool, withPome } from "@pome-sh/adapter-claude-sdk";
import { sign } from "hono/jwt";
import { z } from "zod";

withPome();

const __dirname = dirname(fileURLToPath(import.meta.url));

const TWIN_BASE_URL = process.env.POME_TWIN_BASE_URL ?? "http://127.0.0.1:3333";
const SID = process.env.POME_TWIN_SID ?? "demo";
const REPO_OWNER = process.env.POME_REPO_OWNER ?? "acme";
const REPO_NAME = process.env.POME_REPO_NAME ?? "api";

// Pome CLI evaluator passes a session-scoped MCP URL on a random port.
// Standalone mode falls back to the well-known docker-compose URL.
const MCP_URL = process.env.POME_GITHUB_MCP_URL ?? `${TWIN_BASE_URL}/s/${SID}/mcp`;

// SID embedded in the URL must match the JWT `sid` claim (twin's auth
// middleware rejects mismatches with 401). Trust the URL over the env.
const MCP_SID = MCP_URL.match(/\/s\/([^/]+)\//)?.[1] ?? SID;

const DEFAULT_TASK = `Summarize every open pull request in ${REPO_OWNER}/${REPO_NAME}.

For each open pull request:
1. Read its title, body, author, and its base and head branch names.
2. List the files it changes, then for each changed file read its content on the
   base branch and on the head branch and compare them — that comparison is the
   actual diff. (The file content is base64-encoded; decode it.)
3. Post one comment on the pull request with a concise summary in this shape:
   - **What changed** — 1–2 sentences describing the change.
   - **Why** — the apparent motivation, drawn from the title/body.
   - **Risk** — anything a reviewer should look at closely (or "Low" if none).
   - **Review checklist** — 2–4 short bullet points to verify before merging.

Base every claim on the actual file contents and PR metadata — never invent
changes that are not in the files. Stop once every open pull request has a
summary comment.`;

const TASK = process.env.POME_TASK?.trim() || DEFAULT_TASK;

await main();

async function main() {
  const token = await resolveAuthToken();

  if (process.env.POME_PREFLIGHT === "1") {
    // Pome CLI's preflight: a short sanity boot before the real run. Verify the
    // twin is reachable with the token (and that a Claude key is resolvable),
    // then exit 0 so the real run can start. Failing here surfaces config bugs
    // before burning a full run.
    await preflight(token);
    return;
  }

  // Resolve the Claude key from env or Infisical and export it so the Claude
  // Agent SDK (which reads ANTHROPIC_API_KEY from the environment) picks it up.
  process.env.ANTHROPIC_API_KEY = resolveAnthropicKey();

  banner({ task: TASK, mcpUrl: MCP_URL, sid: MCP_SID });

  const twin = new TwinMcpClient(MCP_URL, token);
  const tools = buildTwinTools(twin);
  const server = createSdkMcpServer({ name: "github-twin", version: "0.1.0", tools });

  const run = query({
    prompt: TASK,
    options: {
      systemPrompt:
        "You are a pull-request summarization assistant for a local GitHub twin. " +
        "Use the provided tools to enumerate open pull requests, then for each one read its metadata and base/head branch names, list the changed files, and read each changed file's content on BOTH the base and head branches to see what actually changed (file content is base64-encoded — decode it), then post exactly one summary comment. " +
        "Ground every statement in the actual file contents — never describe changes that are not present. Be concise and useful to a human reviewer. " +
        "Stop once every open pull request has a summary comment.",
      permissionMode: "bypassPermissions",
      maxTurns: 30,
      allowedTools: tools.map((t) => t.name),
      mcpServers: {
        "github-twin": { type: "sdk", name: "github-twin", instance: server.instance }
      }
    }
  });

  let exitCode = 0;
  const thinking = startThinkingIndicator();
  try {
    for await (const msg of run) {
      thinking.reset();
      if (msg.type === "assistant") {
        logAssistantMessage(msg);
      } else if (msg.type === "result") {
        if (msg.subtype === "success") {
          console.log("\n— agent finished —");
          if (msg.result) console.log(msg.result);
          console.log(`(${msg.usage.input_tokens} in / ${msg.usage.output_tokens} out, $${msg.total_cost_usd.toFixed(4)})`);
        } else {
          console.error(`\nagent stopped: ${msg.subtype}`);
          for (const err of msg.errors) console.error(err);
          exitCode = 1;
        }
      }
    }
  } finally {
    thinking.stop();
  }

  process.exit(exitCode);
}

// The Claude Agent SDK falls silent for 3–10s per round-trip between
// `assistant` / `tool_use` events. First-time users assume the process is
// hung. Print a `· thinking… Ns` line on a 1-second tick, cleared on the
// next message. When stderr isn't a TTY (logs piped to a file, CI tail),
// skip the carriage-return rewriting and just log one line per tick so
// scrollback stays readable.
function startThinkingIndicator() {
  const isTty = Boolean((process.stderr as NodeJS.WriteStream).isTTY ?? false);
  let count = 0;
  const tick = () => {
    count += 1;
    if (isTty) {
      process.stderr.write(`\r· thinking… ${count}s`);
    } else {
      process.stderr.write(`· thinking… ${count}s\n`);
    }
  };
  let timer: ReturnType<typeof setInterval> | null = setInterval(tick, 1000);
  function clearLine() {
    if (isTty) process.stderr.write(`\r${" ".repeat(28)}\r`);
  }
  return {
    reset() {
      clearLine();
      count = 0;
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      clearLine();
    }
  };
}

function buildTwinTools(twin: TwinMcpClient) {
  const ownerRepo = {
    owner: z.string().describe("Repository owner (org or user login)."),
    repo: z.string().describe("Repository name.")
  };

  const listOpenPullRequests = tool(
    "list_open_pull_requests",
    "List open pull requests in a repository on the GitHub twin. Returns the array as JSON text.",
    ownerRepo,
    async ({ owner, repo }) => {
      const prs = await twin.call("list_pull_requests", { owner, repo, state: "open" });
      return { content: [{ type: "text", text: JSON.stringify(prs, null, 2) }] };
    }
  );

  const getPullRequest = tool(
    "get_pull_request",
    "Get one pull request: title, body, author login, branches, and mergeable state.",
    { ...ownerRepo, pull_number: z.number().int().positive() },
    async ({ owner, repo, pull_number }) => {
      const pr = await twin.call("get_pull_request", { owner, repo, pull_number });
      return { content: [{ type: "text", text: JSON.stringify(pr, null, 2) }] };
    }
  );

  const getPullRequestFiles = tool(
    "get_pull_request_files",
    "List the files changed by a pull request, with per-file additions/deletions.",
    { ...ownerRepo, pull_number: z.number().int().positive() },
    async ({ owner, repo, pull_number }) => {
      const files = await twin.call("get_pull_request_files", { owner, repo, pull_number });
      return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
    }
  );

  const getFileContents = tool(
    "get_file_contents",
    "Read a file from a repository at a specific branch/ref. Returns GitHub-shaped JSON whose `content` field is base64-encoded. To see what a PR actually changed, read each changed file at the PR's base ref AND its head ref, then compare the two contents.",
    {
      ...ownerRepo,
      path: z.string().min(1).describe("File path within the repository."),
      ref: z.string().min(1).describe("Branch name or ref to read the file from (e.g. the PR's base or head branch).")
    },
    async ({ owner, repo, path, ref }) => {
      const file = await twin.call("get_file_contents", { owner, repo, path, ref });
      return { content: [{ type: "text", text: JSON.stringify(file, null, 2) }] };
    }
  );

  const commentOnPullRequest = tool(
    "comment_on_pull_request",
    "Post a summary comment on a pull request. (A PR shares the issue-number space, so this comments via the issue endpoint.)",
    {
      ...ownerRepo,
      pull_number: z.number().int().positive(),
      body: z.string().min(1).describe("The markdown summary comment body.")
    },
    async ({ owner, repo, pull_number, body }) => {
      await twin.call("add_issue_comment", { owner, repo, issue_number: pull_number, body });
      return { content: [{ type: "text", text: `Commented on PR #${pull_number}.` }] };
    }
  );

  return [listOpenPullRequests, getPullRequest, getPullRequestFiles, getFileContents, commentOnPullRequest];
}

class TwinMcpClient {
  constructor(private readonly url: string, private readonly token: string) {}

  async call(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${trimSlash(this.url)}/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`
      },
      body: JSON.stringify({ tool: toolName, arguments: args })
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`twin tool ${toolName} failed: ${res.status} ${text.slice(0, 400)}`);
    }
    return text ? JSON.parse(text) : null;
  }
}

/**
 * Resolve the Anthropic API key from the environment, falling back to
 * Infisical. Order:
 *   1. ANTHROPIC_API_KEY (local env / already-injected Infisical secret).
 *   2. `infisical secrets get ANTHROPIC_API_KEY --plain` via the CLI.
 *
 * Tip: you can skip the CLI fallback entirely by wrapping the run command,
 * which injects every project secret as an env var:
 *   infisical run -- bun run start
 */
function resolveAnthropicKey(): string {
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  const fromInfisical = readKeyFromInfisical();
  if (fromInfisical) return fromInfisical;

  throw new Error(
    "Could not resolve an Anthropic API key.\n" +
      "Either:\n" +
      "  • export ANTHROPIC_API_KEY=sk-ant-..., or\n" +
      "  • run under Infisical: `infisical run -- bun run start`, or\n" +
      "  • store ANTHROPIC_API_KEY in your Infisical project (the agent will fetch it via the CLI)."
  );
}

function readKeyFromInfisical(): string | null {
  const secretName = process.env.POME_INFISICAL_SECRET_NAME ?? "ANTHROPIC_API_KEY";
  const env = process.env.INFISICAL_ENV ?? "dev";
  const args = ["secrets", "get", secretName, "--plain", `--env=${env}`];
  if (process.env.INFISICAL_PROJECT_ID) args.push(`--projectId=${process.env.INFISICAL_PROJECT_ID}`);

  try {
    const out = execFileSync("infisical", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const value = out.trim();
    return value.length > 0 ? value : null;
  } catch {
    // CLI missing, not logged in, or secret absent — treat as "not found" and
    // let the caller surface a single actionable error.
    return null;
  }
}

async function resolveAuthToken(): Promise<string> {
  // Pome CLI evaluator pre-mints the token and passes it as POME_AUTH_TOKEN.
  if (process.env.POME_AUTH_TOKEN) return process.env.POME_AUTH_TOKEN;

  // Standalone: read the secret from .pome-data/secret (auto-generated by
  // the docker-compose entrypoint) or fall back to the env override.
  const secret = process.env.TWIN_AUTH_SECRET ?? readSecretFromDisk();
  return sign(
    { sid: MCP_SID, team_id: "tm_local", exp: Math.floor(Date.now() / 1000) + 3600 },
    secret
  );
}

function readSecretFromDisk(): string {
  const explicit = process.env.POME_DATA_SECRET_PATH;
  // Default location: <repo-root>/.pome-data/secret. From this file
  // (examples/pr-summary-agent/src/index.ts) the repo root is three levels up.
  const candidates = [
    explicit,
    resolve(process.cwd(), ".pome-data/secret"),
    resolve(__dirname, "../../../.pome-data/secret")
  ].filter((p): p is string => Boolean(p));

  for (const path of candidates) {
    if (existsSync(path)) {
      const value = readFileSync(path, "utf8").trim();
      if (value.length >= 32) return value;
      throw new Error(`Twin secret at ${path} is shorter than 32 characters.`);
    }
  }

  throw new Error(
    "Could not locate the twin auth secret.\n" +
      "Either:\n" +
      "  • run `docker compose up` from the repo root (writes .pome-data/secret), or\n" +
      "  • export TWIN_AUTH_SECRET (>= 32 chars), or\n" +
      "  • export POME_AUTH_TOKEN with a pre-minted JWT."
  );
}

async function preflight(token: string): Promise<void> {
  // Resolve the Claude key (env or Infisical) — throws with guidance if absent.
  resolveAnthropicKey();

  // Probe the session-scoped MCP surface with the token. This works in both
  // run modes: standalone (the default :3333 URL) and the Pome CLI evaluator,
  // which boots the twin on a RANDOM port and injects POME_GITHUB_MCP_URL.
  // (Don't probe a hardcoded 127.0.0.1:3333/healthz — under `pome run` nothing
  // is listening there, which would fail preflight on an otherwise healthy run.)
  const probe = await fetch(`${trimSlash(MCP_URL)}/tools`, {
    headers: { authorization: `Bearer ${token}` }
  }).catch((err) => {
    throw new Error(`twin MCP not reachable at ${MCP_URL}/tools: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (!probe.ok) throw new Error(`twin MCP probe failed: ${probe.status}`);

  console.log("preflight ok");
}

function banner(input: { task: string; mcpUrl: string; sid: string }) {
  console.log("─".repeat(72));
  console.log("Pome pr-summary-agent");
  console.log(`twin MCP: ${input.mcpUrl}`);
  console.log(`session:  ${input.sid}`);
  console.log("task:");
  for (const line of input.task.split("\n")) console.log(`  ${line}`);
  console.log("─".repeat(72));
}

function logAssistantMessage(msg: { message: { content?: Array<unknown> } }) {
  for (const block of msg.message.content ?? []) {
    const b = block as { type: string; text?: string; name?: string; input?: unknown };
    if (b.type === "text" && b.text) {
      console.log(`assistant: ${b.text}`);
    } else if (b.type === "tool_use") {
      const args = JSON.stringify(b.input);
      console.log(`tool_use:  ${b.name}(${args.length > 200 ? `${args.slice(0, 197)}...` : args})`);
    }
  }
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
