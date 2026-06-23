import { spawnSync } from "node:child_process";
import { sign } from "hono/jwt";
import { createGitHubCloneApp } from "../src/app.js";
import { listTools } from "../src/tools.js";

type HarnessState = { pullNumber?: number };
type ToolCase = { tool: string; arguments: Record<string, unknown> | ((state: HarnessState) => Record<string, unknown>); mutates?: boolean };

const sid = "fidelity-parity";
const secret = process.env.TWIN_AUTH_SECRET ?? "dev-only-insecure-secret";
const token = await sign({ sid, team_id: "tm_fidelity", exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
const app = createGitHubCloneApp();
const base = `/s/${sid}`;

const cases: ToolCase[] = [
  { tool: "search_repositories", arguments: { query: "acme" } },
  { tool: "create_repository", arguments: { owner: "qa", name: "parity" }, mutates: true },
  { tool: "fork_repository", arguments: { owner: "acme", repo: "api", organization: "forks" }, mutates: true },
  { tool: "get_repository", arguments: { owner: "acme", repo: "api" } },
  { tool: "search_code", arguments: { query: "handler" } },
  { tool: "search_users", arguments: { query: "alice" } },
  { tool: "get_file_contents", arguments: { owner: "acme", repo: "api", path: "README.md" } },
  { tool: "list_commits", arguments: { owner: "acme", repo: "api" } },
  { tool: "create_or_update_file", arguments: { owner: "acme", repo: "api", path: "parity.txt", message: "Add parity", content: "ok\n" }, mutates: true },
  { tool: "create_branch", arguments: { owner: "acme", repo: "api", branch: "parity" }, mutates: true },
  { tool: "push_files", arguments: { owner: "acme", repo: "api", branch: "parity", message: "Change parity", files: [{ path: "parity.txt", content: "changed\n" }] }, mutates: true },
  { tool: "get_issue", arguments: { owner: "acme", repo: "api", issue_number: 1 } },
  { tool: "update_issue", arguments: { owner: "acme", repo: "api", issue_number: 1, state: "open" }, mutates: true },
  { tool: "search_issues", arguments: { query: "500" } },
  { tool: "list_issues", arguments: { owner: "acme", repo: "api", state: "all" } },
  { tool: "add_issue_comment", arguments: { owner: "acme", repo: "api", issue_number: 1, body: "Parity comment" }, mutates: true },
  { tool: "list_issue_comments", arguments: { owner: "acme", repo: "api", issue_number: 1 } },
  { tool: "create_issue", arguments: { owner: "acme", repo: "api", title: "Parity issue" }, mutates: true },
  { tool: "list_repository_labels", arguments: { owner: "acme", repo: "api" } },
  { tool: "create_label", arguments: { owner: "acme", repo: "api", name: "parity-label", color: "ededed" }, mutates: true },
  { tool: "list_issue_labels", arguments: { owner: "acme", repo: "api", issue_number: 1 } },
  { tool: "add_issue_labels", arguments: { owner: "acme", repo: "api", issue_number: 1, labels: ["parity-label"] }, mutates: true },
  { tool: "remove_issue_label", arguments: { owner: "acme", repo: "api", issue_number: 1, label: "parity-label" }, mutates: true },
  { tool: "list_collaborators", arguments: { owner: "acme", repo: "api" } },
  { tool: "add_assignees", arguments: { owner: "acme", repo: "api", issue_number: 1, assignees: ["alice"] }, mutates: true },
  { tool: "create_pull_request", arguments: { owner: "acme", repo: "api", title: "Parity PR", head: "parity", base: "main" }, mutates: true },
  { tool: "get_pull_request", arguments: (state) => ({ owner: "acme", repo: "api", pull_number: state.pullNumber }) },
  { tool: "get_pull_request_reviews", arguments: (state) => ({ owner: "acme", repo: "api", pull_number: state.pullNumber }) },
  { tool: "create_pull_request_review", arguments: (state) => ({ owner: "acme", repo: "api", pull_number: state.pullNumber, event: "APPROVE" }), mutates: true },
  { tool: "get_pull_request_comments", arguments: (state) => ({ owner: "acme", repo: "api", pull_number: state.pullNumber }) },
  { tool: "get_pull_request_files", arguments: (state) => ({ owner: "acme", repo: "api", pull_number: state.pullNumber }) },
  { tool: "get_pull_request_status", arguments: (state) => ({ owner: "acme", repo: "api", pull_number: state.pullNumber }) },
  { tool: "list_pull_requests", arguments: { owner: "acme", repo: "api", state: "all" } },
  { tool: "update_pull_request_branch", arguments: (state) => ({ owner: "acme", repo: "api", pull_number: state.pullNumber }), mutates: true },
  { tool: "merge_pull_request", arguments: (state) => ({ owner: "acme", repo: "api", pull_number: state.pullNumber }), mutates: true }
];

const expected = listTools().map((tool) => tool.name).sort();
const covered = cases.map((item) => item.tool).sort();
if (JSON.stringify(expected) !== JSON.stringify(covered)) {
  throw new Error(`fidelity harness case list does not match tool list.\nexpected=${expected.join(",")}\ncovered=${covered.join(",")}`);
}

const report: unknown[] = [];
const state: HarnessState = {};
for (const item of cases) {
  const args = typeof item.arguments === "function" ? item.arguments(state) : item.arguments;
  const response = await app.request(`${base}/mcp/call`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ tool: item.tool, arguments: args })
  });
  const body = await response.json().catch(() => ({}));
  if (item.tool === "create_pull_request" && response.ok && body && typeof body === "object" && typeof (body as { number?: unknown }).number === "number") {
    state.pullNumber = (body as { number: number }).number;
  }
  report.push({
    tool: item.tool,
    status: response.status,
    ok: response.ok,
    keys: body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body as Record<string, unknown>).sort() : Array.isArray(body) ? ["array"] : []
  });
}

const unsupported = await app.request(`${base}/repos/acme/api/actions/runs`, {
  headers: { authorization: `Bearer ${token}` }
});
report.push({ surface: "unsupported-rest", status: unsupported.status, body: await unsupported.json() });

const sandboxRepo = process.env.GITHUB_PARITY_REPO;
if (sandboxRepo) {
  const endpoints = [
    `repos/${sandboxRepo}`,
    `repos/${sandboxRepo}/contents/README.md`,
    `repos/${sandboxRepo}/issues?state=open&per_page=1`,
    `search/repositories?q=repo:${sandboxRepo}`
  ];
  for (const endpoint of endpoints) {
    const result = spawnSync("gh", ["api", endpoint], { encoding: "utf8" });
    report.push({
      real_github_endpoint: endpoint,
      status: result.status === 0 ? 200 : "gh-error",
      stderr: result.status === 0 ? undefined : result.stderr.trim().slice(0, 400)
    });
  }
} else {
  report.push({ real_github: "skipped", reason: "set GITHUB_PARITY_REPO=owner/repo to compare read-only live shapes with gh api" });
}

console.log(JSON.stringify({ tools: expected.length, report }, null, 2));
