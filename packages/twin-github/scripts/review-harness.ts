type ToolCallResult = {
  ok: boolean;
  tool: string;
  status?: number;
  body?: any;
  error?: string;
};

class GitHubTwinClient {
  private sessionId: string | null = null;
  private requestId = 1;

  constructor(
    private readonly url: string,
    private readonly token?: string
  ) {}

  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.isJsonRpcMcp()) {
      await this.initialize();
      const result = await this.rpc("tools/call", { name: tool, arguments: args });
      return unwrapToolResult(result);
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await fetch(`${this.url.replace(/\/$/, "")}/call`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool, arguments: args })
    });
    const body: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof body?.message === "string" ? body.message : `HTTP ${response.status}`;
      throw Object.assign(new Error(message), { status: response.status, body });
    }
    return body;
  }

  async attempt(tool: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    try {
      const body = await this.call(tool, args);
      if (isGitHubErrorEnvelope(body)) {
        return { ok: false, tool, body, error: body.message };
      }
      return { ok: true, tool, body };
    } catch (error) {
      return {
        ok: false,
        tool,
        status: (error as { status?: number }).status,
        body: (error as { body?: unknown }).body,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private isJsonRpcMcp() {
    return !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(this.url) && (this.url.endsWith("/mcp") || this.url.includes("/github/mcp"));
  }

  private async initialize() {
    if (this.sessionId) return;
    const response = await this.postRpc({
      jsonrpc: "2.0",
      id: this.requestId++,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "github-clone-review-harness", version: "0.1.0" }
      }
    });
    this.sessionId = response.headers.get("mcp-session-id");
    if (!this.sessionId) {
      throw new Error("MCP initialize response did not include mcp-session-id");
    }
    await this.postRpc({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {}
    });
  }

  private async rpc(method: string, params: Record<string, unknown>) {
    const response = await this.postRpc({ jsonrpc: "2.0", id: this.requestId++, method, params });
    const parsed = parseMcpEnvelope(await response.text());
    if (parsed.error) {
      throw new Error(parsed.error.message ?? `MCP ${method} failed`);
    }
    return parsed.result;
  }

  private async postRpc(body: unknown) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {})
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const text = await response.text();
      throw Object.assign(new Error(text), { status: response.status, body: text });
    }
    return response;
  }

  async close() {
    if (!this.sessionId || !this.isJsonRpcMcp()) return;
    await fetch(this.url, {
      method: "DELETE",
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        "mcp-session-id": this.sessionId
      }
    });
    this.sessionId = null;
  }
}

const target = process.env.REVIEW_TARGET ?? "local";
let mcpUrl = process.env.GITHUB_MCP_URL ?? process.env.POME_GITHUB_MCP_URL ?? "http://127.0.0.1:3333/mcp";
let token = process.env.GITHUB_MCP_TOKEN;
const runId = process.env.REVIEW_RUN_ID ?? `${Date.now()}`;
const repoName = `review-fixture-${target}-${runId}`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 90);
const branchName = "claude-agent-review";
const filePath = "claude-agent.txt";

if (target === "local") {
  const sid = process.env.REVIEW_SID ?? `harness_${runId}`;
  const url = new URL(mcpUrl);
  url.pathname = `/s/${sid}/mcp`;
  mcpUrl = url.toString().replace(/\/$/, "");
  const { sign } = await import("hono/jwt");
  const secret = process.env.TWIN_AUTH_SECRET ?? "dev-only-insecure-secret";
  token = await sign(
    { sid, team_id: "tm_review", exp: Math.floor(Date.now() / 1000) + 3600 },
    secret
  );
}

const client = new GitHubTwinClient(mcpUrl, token);

const report = {
  target,
  mcpUrl: redactSession(mcpUrl),
  tests: [] as Array<{ name: string; ok: boolean; details: unknown }>
};

report.tests.push(await functionalPrFlow());
report.tests.push(await negativeFidelity());
report.tests.push(await concurrencyStress());

const ok = report.tests.every((test) => test.ok);
await client.close().catch(() => undefined);
console.log(JSON.stringify(report, null, 2));
if (!ok) process.exit(1);

async function functionalPrFlow() {
  const details: ToolCallResult[] = [];
  const repoResult = await client.attempt("create_repository", { name: repoName, description: "Review harness fixture", private: false });
  details.push(repoResult);
  if (!repoResult.ok) return result("functional-pr-flow", false, details);

  const repo = repoResult.body as { name: string; owner?: { login: string }; full_name?: string };
  const owner = repo.owner?.login ?? repo.full_name?.split("/")[0] ?? "pome-agent";
  const name = repo.name;
  details.push(await client.attempt("create_branch", { owner, repo: name, branch: branchName, from_branch: "main" }));
  details.push(await client.attempt("create_or_update_file", { owner, repo: name, branch: branchName, path: filePath, message: "Add Claude agent output", content: `hello from ${target}\n` }));
  const pr = await client.attempt("create_pull_request", { owner, repo: name, title: "Claude agent review", head: branchName, base: "main", body: "Created by review harness." });
  details.push(pr);
  if (!pr.ok) return result("functional-pr-flow", false, details);

  const pullNumber = (pr.body as { number?: number }).number;
  details.push(await client.attempt("create_pull_request_review", { owner, repo: name, pull_number: pullNumber, body: "Looks good.", event: "APPROVE" }));
  const merge = await client.attempt("merge_pull_request", { owner, repo: name, pull_number: pullNumber, commit_title: "Merge Claude agent review" });
  details.push(merge);
  const contents = await client.attempt("get_file_contents", { owner, repo: name, path: filePath, ref: "main" });
  details.push(contents);

  return result("functional-pr-flow", merge.ok && contents.ok, details);
}

async function negativeFidelity() {
  const repoResult = await client.attempt("create_repository", { name: `${repoName}-negative`, description: "Negative review harness fixture", private: false });
  if (!repoResult.ok) return result("negative-fidelity", false, [repoResult]);
  const repo = repoResult.body as { name: string; owner?: { login: string }; full_name?: string };
  const owner = repo.owner?.login ?? repo.full_name?.split("/")[0] ?? "pome-agent";
  const name = repo.name;

  const missingFile = await client.attempt("get_file_contents", { owner, repo: name, path: "missing.txt" });
  const createFile = await client.attempt("create_or_update_file", { owner, repo: name, branch: "main", path: "stale.txt", message: "Create stale target", content: "first\n" });
  const wrongSha = await client.attempt("create_or_update_file", { owner, repo: name, branch: "main", path: "stale.txt", message: "Wrong sha", content: "bad\n", sha: "wrong" });

  return result("negative-fidelity", !missingFile.ok && createFile.ok && !wrongSha.ok, [missingFile, createFile, wrongSha]);
}

async function concurrencyStress() {
  const repoResult = await client.attempt("create_repository", { name: `${repoName}-race`, description: "Race review harness fixture", private: false });
  if (!repoResult.ok) return result("concurrency-stress", false, [repoResult]);
  const repo = repoResult.body as { name: string; owner?: { login: string }; full_name?: string };
  const owner = repo.owner?.login ?? repo.full_name?.split("/")[0] ?? "pome-agent";
  const name = repo.name;

  const calls = Array.from({ length: 8 }, (_, index) =>
    client.attempt("create_or_update_file", {
      owner,
      repo: name,
      branch: "main",
      path: "race.txt",
      message: `Race write ${index}`,
      content: `write ${index}\n`
    })
  );
  const results = await Promise.all(calls);
  const successes = results.filter((entry) => entry.ok).length;
  const finalRead = await client.attempt("get_file_contents", { owner, repo: name, path: "race.txt" });

  return result("concurrency-stress", successes === 1 && finalRead.ok, { successes, finalRead, results });
}

function result(name: string, ok: boolean, details: unknown) {
  return { name, ok, details };
}

function parseMcpEnvelope(text: string) {
  if (text.trimStart().startsWith("event:")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
    return JSON.parse(data);
  }
  return JSON.parse(text);
}

function unwrapToolResult(result: any) {
  if (result?.isError) {
    const text = result?.content?.find?.((entry: { type?: string }) => entry.type === "text")?.text;
    throw new Error(typeof text === "string" ? text : "MCP tool call failed");
  }
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find?.((entry: { type?: string }) => entry.type === "text")?.text;
  if (typeof text === "string") {
    if (text.startsWith("MCP error")) throw new Error(text);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

function redactSession(url: string) {
  return url.replace(/runtime\/[^/]+/g, "runtime/SESSION");
}

function isGitHubErrorEnvelope(body: unknown): body is { message: string; documentation_url?: string } {
  return Boolean(
    body &&
      typeof body === "object" &&
      "message" in body &&
      typeof (body as { message?: unknown }).message === "string" &&
      ("documentation_url" in body || (body as { status?: unknown }).status === 404 || (body as { status?: unknown }).status === 422)
  );
}
