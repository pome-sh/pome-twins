// SPDX-License-Identifier: Apache-2.0
// FDRS-635 test fixture: same scripted triage work as capture-probe-agent.ts,
// then two raw CONNECTs through the runner-injected HTTPS_PROXY:
//   1. POME_EGRESS_TEST_BLOCKED ("host:port") — MUST be refused with 403 by
//      the egress floor. A 200 here means the proxy silently passed a
//      non-allowlisted host through to "production", which is exactly the
//      failure FDRS-635 exists to prevent — so the fixture exits non-zero.
//   2. POME_CAPTURE_TEST_TARGET ("host:port", a loopback echo) — MUST still
//      tunnel (200): loopback/twin-adjacent traffic is unaffected.

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

  const blockedStatus = await connectStatus(requiredEnv("POME_EGRESS_TEST_BLOCKED"));
  if (blockedStatus !== "403") {
    throw new Error(
      `expected the egress floor to refuse the blocked target with 403, got ${blockedStatus}`,
    );
  }

  const allowedStatus = await connectStatus(requiredEnv("POME_CAPTURE_TEST_TARGET"));
  if (allowedStatus !== "200") {
    throw new Error(`expected the loopback tunnel to stay open (200), got ${allowedStatus}`);
  }

  console.log(JSON.stringify({ task, summary: "egress fixture done" }));
}

// Open one CONNECT through the proxy and return the response status code.
// For a 200, write one probe payload then close.
function connectStatus(target: string): Promise<string> {
  const proxyUrl = requiredEnv("HTTPS_PROXY");
  const url = new URL(proxyUrl);

  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: url.hostname, port: Number(url.port) });
    let buf = "";
    let done = false;
    sock.on("error", reject);
    sock.on("data", (chunk: Buffer) => {
      if (done) return;
      buf += chunk.toString("utf8");
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      if (!match) return;
      done = true;
      const status = match[1]!;
      if (status === "200") {
        sock.write("probe");
        setTimeout(() => sock.end(), 50);
      } else {
        sock.end();
      }
      resolve(status);
    });
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
