// SPDX-License-Identifier: Apache-2.0
// FDRS-399 test fixture: same scripted triage work as
// examples/agents/scripted-triage-agent.ts, but after the triage call we open
// one raw HTTP CONNECT through the runner-injected HTTP_PROXY to a TCP host
// configured via POME_CAPTURE_TEST_TARGET="host:port". This deterministically
// produces one `LlmCallEvent` in events.jsonl without needing a real
// Anthropic call or a TLS upstream — the proxy treats CONNECT tunnels as
// opaque regardless of inner bytes (proven by FDRS-406's integration test).

import { createConnection } from "node:net";
import { URL } from "node:url";

type GitHubIssue = {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
  assignee: { login: string } | null;
};

if (process.env.POME_PREFLIGHT === "1") {
  console.log("preflight ok");
  process.exit(0);
}

const task = requiredEnv("POME_TASK");
const baseUrl = requiredEnv("POME_GITHUB_REST_URL");
const authToken = process.env.POME_AUTH_TOKEN;
const issueNumber = Number(task.match(/#(\d+)/)?.[1] ?? "1");
const repo = (task.match(/in\s+([a-z0-9_.-]+\/[a-z0-9_.-]+)/i)?.[1] ?? "acme/api").replace(/[.,]+$/, "");
const [owner, name] = repo.split("/") as [string, string];

async function main() {
  const issue = await github<GitHubIssue>(`/repos/${owner}/${name}/issues/${issueNumber}`);
  const existing = issue.labels.find((l) => ["bug", "feature", "question"].includes(l.name));
  if (!existing) {
    const label = classify(issue);
    await github(`/repos/${owner}/${name}/issues/${issueNumber}/labels`, {
      method: "POST",
      body: { labels: [label] },
    });
    await github(`/repos/${owner}/${name}/issues/${issueNumber}/assignees`, {
      method: "POST",
      body: { assignees: ["alice"] },
    });
  }

  // Produce one LlmCallEvent by opening a CONNECT tunnel through the proxy.
  await connectThroughProxy();

  console.log(JSON.stringify({ task, summary: "fixture done" }));
}

async function connectThroughProxy(): Promise<void> {
  const target = requiredEnv("POME_CAPTURE_TEST_TARGET"); // "host:port"
  const proxyUrl = requiredEnv("HTTPS_PROXY"); // injected by the runner
  const url = new URL(proxyUrl);
  const proxyHost = url.hostname;
  const proxyPort = Number(url.port);

  await new Promise<void>((resolve, reject) => {
    const sock = createConnection({ host: proxyHost, port: proxyPort });
    let buf = "";
    let header = false;
    sock.on("error", reject);
    sock.on("data", (chunk: Buffer) => {
      if (header) return;
      buf += chunk.toString("utf8");
      if (buf.indexOf("\r\n\r\n") === -1) return;
      header = true;
      if (!/^HTTP\/1\.[01] 200/.test(buf)) {
        sock.destroy();
        reject(new Error(`CONNECT failed: ${buf.slice(0, 80)}`));
        return;
      }
      sock.write("probe");
      // Give the upstream a tick to echo, then close.
      setTimeout(() => sock.end(), 50);
    });
    sock.on("close", () => resolve());
    sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  });
}

function classify(issue: GitHubIssue): string {
  const text = `${issue.title}\n${issue.body}`.toLowerCase();
  if (text.includes("500") || text.includes("error") || text.includes("null") || text.includes("failing")) return "bug";
  if (text.includes("add") || text.includes("export") || text.includes("feature")) return "feature";
  return "question";
}

async function github<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: authToken
      ? { Authorization: `Bearer ${authToken}`, ...(options.body ? { "content-type": "application/json" } : {}) }
      : options.body
        ? { "content-type": "application/json" }
        : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

function requiredEnv(n: string): string {
  const v = process.env[n]?.trim();
  if (!v) throw new Error(`${n} is required`);
  return v;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
