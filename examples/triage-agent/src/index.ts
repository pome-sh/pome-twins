/**
 * Pome bundled example: triage-agent.
 *
 * A small Claude Agent SDK agent that triages open issues in a GitHub-shaped
 * Pome twin. For each open issue it picks one of `bug` / `feature` /
 * `question`, applies the label, and posts a one-sentence comment explaining
 * the choice.
 *
 * Two run modes share the same code path:
 *
 * 1. Standalone — start the twin with `npx @pome-sh/cli twin start github`,
 *    then `npm run start` from this directory. Auth comes from env only
 *    (F-647): either paste the POME_AUTH_TOKEN the CLI prints, or export the
 *    same TWIN_AUTH_SECRET in both terminals and the agent mints its own
 *    bearer JWT. The agent talks to the twin at
 *    http://127.0.0.1:3333/s/standalone/mcp.
 *
 * 2. Pome CLI evaluator — `pome run 01-triage-acme-issues.md --agent="npm
 *    run start"`. The CLI spins up its own twin on a random port, seeds the
 *    scenario, mints the JWT itself, and passes the URL + token to the agent
 *    via env (POME_GITHUB_MCP_URL, POME_AUTH_TOKEN, POME_TASK).
 *
 * The agent uses the Claude Agent SDK's in-process MCP server to expose three
 * tools to the model. Each tool wraps a single call to the twin's MCP surface
 * (POST /s/:sid/mcp/call) — using the MCP shape (not raw REST) keeps the
 * wrapper aligned with the twin's tool contract.
 */

// F0-4 / L7 — overlay pome adapter signals on the Claude Agent SDK trace.
// `withPome()` installs a `globalThis.fetch` hook that emits
// `ToolUseEvent` / `HookEvent` / `SubagentSpawnEvent` rows to
// `POME_ADAPTER_SIGNALS_PATH` (Pome CLI injects this env var) and a
// `x-pome-correlation-id` header on outgoing fetches so the twin recorder
// links each twin-HTTP row back to the originating tool call. `tool` and
// `query` are drop-in replacements for the upstream SDK exports — the
// adapter just adds the signals layer. `createSdkMcpServer` is not part of
// the adapter's surface; keep importing it from the SDK directly.
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { query, tool, withPome } from "@pome-sh/adapter-claude-sdk";
import { sign } from "hono/jwt";
import { z } from "zod";

const TWIN_BASE_URL = process.env.POME_TWIN_BASE_URL ?? "http://127.0.0.1:3333";
// `pome twin start` serves the fixed session `/s/standalone`.
const SID = process.env.POME_TWIN_SID ?? "standalone";
const REPO_OWNER = process.env.POME_REPO_OWNER ?? "acme";
const REPO_NAME = process.env.POME_REPO_NAME ?? "api";

// Pome CLI evaluator passes a session-scoped MCP URL on a random port.
// Standalone mode falls back to the well-known `pome twin start` URL.
const MCP_URL = process.env.POME_GITHUB_MCP_URL ?? `${TWIN_BASE_URL}/s/${SID}/mcp`;

// SID embedded in the URL must match the JWT `sid` claim (twin's auth
// middleware rejects mismatches with 401). Trust the URL over the env.
const MCP_SID = MCP_URL.match(/\/s\/([^/]+)\//)?.[1] ?? SID;

const DEFAULT_TASK = `Triage every open issue in ${REPO_OWNER}/${REPO_NAME}.

For each open issue:
1. Read the title and body.
2. Decide whether it is a bug, feature request, or question.
3. Apply exactly one of the existing repository labels: \`bug\`, \`feature\`, or \`question\`. Do not invent new labels.
4. Post a one-sentence comment on the issue explaining the classification.

Stop once every open issue has both a classification label and a reasoning comment.`;

const TASK = process.env.POME_TASK?.trim() || DEFAULT_TASK;

// Only run the agent when executed directly (`npx tsx src/index.ts`). Guarding
// on `import.meta.main` keeps the module importable — e.g. by the auth-token
// unit test — without kicking off a full agent run on import.
if (import.meta.main) {
  // Install the pome fetch-hook only for a real run — keeps the module free of
  // import-time side effects (the auth-token unit test imports it).
  withPome();
  await main();
}

async function main() {
  const token = await resolveAuthToken();

  if (process.env.POME_PREFLIGHT === "1") {
    // Pome CLI's preflight: a 10s sanity boot before the real run. Verify
    // the twin is reachable with the token, then exit 0 so the real run can
    // start. Failing here surfaces config bugs before burning a full run.
    await preflight(token);
    return;
  }

  banner({ task: TASK, mcpUrl: MCP_URL, sid: MCP_SID });

  const twin = new TwinMcpClient(MCP_URL, token);
  const tools = buildTwinTools(twin);
  const server = createSdkMcpServer({ name: "github-twin", version: "0.1.0", tools });

  const run = query({
    prompt: TASK,
    options: {
      systemPrompt:
        "You are an issue-triage assistant for a local GitHub twin. " +
        "Use the provided tools to enumerate open issues, then for each one apply exactly one of the labels `bug`, `feature`, `question` and post a one-sentence comment explaining your reasoning. " +
        "Be brief. Never invent labels. Stop once every open issue has both a label and a comment.",
      permissionMode: "bypassPermissions",
      maxTurns: 25,
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

// F1 — Claude Agent SDK falls silent for 3–10s per round-trip between
// `assistant` / `tool_use` events. First-time users assume the process is
// hung. Print a `· thinking… Ns` line on a 1-second tick, cleared on the
// next message. When stderr isn't a TTY (logs piped to a file, CI tail),
// skip the carriage-return rewriting and just log one line per tick so
// scrollback stays readable.
function startThinkingIndicator() {
  const isTty = Boolean(
    (process.stderr as NodeJS.WriteStream).isTTY ?? false,
  );
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
    },
  };
}

function buildTwinTools(twin: TwinMcpClient) {
  const ownerRepo = {
    owner: z.string().describe("Repository owner (org or user login)."),
    repo: z.string().describe("Repository name.")
  };

  const listOpenIssues = tool(
    "list_open_issues",
    "List open issues in a repository on the GitHub twin. Returns the array as JSON text.",
    ownerRepo,
    async ({ owner, repo }) => {
      const issues = await twin.call("list_issues", { owner, repo, state: "open" });
      return { content: [{ type: "text", text: JSON.stringify(issues, null, 2) }] };
    }
  );

  const addLabel = tool(
    "add_label",
    "Apply one classification label to an issue. The label must already exist on the repo (one of `bug`, `feature`, `question`).",
    {
      ...ownerRepo,
      issue_number: z.number().int().positive(),
      label: z.enum(["bug", "feature", "question"]).describe("Exactly one classification label.")
    },
    async ({ owner, repo, issue_number, label }) => {
      await twin.call("add_issue_labels", { owner, repo, issue_number, labels: [label] });
      return { content: [{ type: "text", text: `Applied "${label}" to issue #${issue_number}.` }] };
    }
  );

  const commentOnIssue = tool(
    "comment_on_issue",
    "Post a one-sentence comment on an issue summarizing the triage decision.",
    {
      ...ownerRepo,
      issue_number: z.number().int().positive(),
      body: z.string().min(1).describe("Comment body. One sentence is enough.")
    },
    async ({ owner, repo, issue_number, body }) => {
      await twin.call("add_issue_comment", { owner, repo, issue_number, body });
      return { content: [{ type: "text", text: `Commented on issue #${issue_number}.` }] };
    }
  );

  return [listOpenIssues, addLabel, commentOnIssue];
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

// Auth is env-only (F-647): the agent never probes the twin's on-disk state —
// the persisted-secret location is a server↔CLI internal contract
// (F-708/F-709), and probing it from a third-party agent is exactly the
// coupling that broke the old quickstart (F-604).
export async function resolveAuthToken(): Promise<string> {
  // Pome CLI evaluator (and `pome twin start`'s printed line) pre-mint the
  // token and pass it as POME_AUTH_TOKEN.
  if (process.env.POME_AUTH_TOKEN) return process.env.POME_AUTH_TOKEN;

  // Standalone: mint a JWT from the same TWIN_AUTH_SECRET the twin was
  // started with (`export TWIN_AUTH_SECRET=… && npx @pome-sh/cli twin start github`).
  const secret = process.env.TWIN_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "No twin auth in the environment.\n" +
        "Either:\n" +
        "  • export POME_AUTH_TOKEN — `npx @pome-sh/cli twin start github` prints a ready-minted one, or\n" +
        "  • export the same TWIN_AUTH_SECRET (>= 32 chars) the twin was started with; the agent mints its own JWT."
    );
  }
  if (secret.length < 32) {
    throw new Error("TWIN_AUTH_SECRET is shorter than 32 characters.");
  }
  return sign(
    { sid: MCP_SID, team_id: "tm_local", exp: Math.floor(Date.now() / 1000) + 3600 },
    secret
  );
}

async function preflight(token: string): Promise<void> {
  // Standalone mode only: probe the local twin's root /healthz so "the twin
  // isn't running" gets a direct message. When a pome runner injected
  // POME_GITHUB_MCP_URL there is no loopback twin — TWIN_BASE_URL falls back
  // to 127.0.0.1:3333 and hosted `pome run` died here probing it (FDRS-667).
  // The authenticated ${MCP_URL}/tools probe below already covers
  // reachability + auth in every mode.
  if (!process.env.POME_GITHUB_MCP_URL) {
    const healthUrl = `${TWIN_BASE_URL.replace(/\/$/, "")}/healthz`;
    const res = await fetch(healthUrl).catch((err) => {
      throw new Error(`twin not reachable at ${healthUrl}: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (!res.ok) throw new Error(`twin healthz returned ${res.status}`);
  }

  // Claude auth: the Agent SDK takes an API key (ANTHROPIC_API_KEY), a
  // subscription token (CLAUDE_CODE_OAUTH_TOKEN, from `claude setup-token`),
  // or a `claude` login stored on this machine — that last one is invisible
  // to env, so hard-failing here would block subscription users whose runs
  // would succeed. Warn with both options instead of throwing (FDRS-667).
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.warn(
      "warning: neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set — continuing, assuming a stored `claude` subscription login. " +
        "If the run fails on auth: export ANTHROPIC_API_KEY=sk-ant-… (API key) or CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`)."
    );
  }

  // Sanity-check the bearer token by hitting a session-scoped endpoint.
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
  console.log("Pome triage-agent");
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
