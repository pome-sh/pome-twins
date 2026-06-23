// SPDX-License-Identifier: Apache-2.0
//
// FDRS-411 e2e fixture. Mimics what `@pome-sh/adapter-claude-sdk`'s
// `withPome()` does for the parts FDRS-411 cares about:
//   1. honors `POME_PREFLIGHT=1` and exits 0
//   2. on the real run, appends two M0 HookEvent rows to
//      `POME_ADAPTER_SIGNALS_PATH` then triages the issue against the twin
//      so the scenario passes deterministically.
//
// Using a hand-rolled fixture avoids spinning up the real Anthropic SDK in
// CI. The full CAS-adapter happy path is covered by FDRS-413.

import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

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

const signalsPath = process.env.POME_ADAPTER_SIGNALS_PATH;
const baseUrl = requiredEnv("POME_GITHUB_REST_URL");
const authToken = process.env.POME_AUTH_TOKEN;
const task = requiredEnv("POME_TASK");
const issueNumber = Number(task.match(/#(\d+)/)?.[1] ?? "1");
const repo = (task.match(/in\s+([a-z0-9_.-]+\/[a-z0-9_.-]+)/i)?.[1] ?? "acme/api").replace(/[.,]+$/, "");
const [owner, name] = repo.split("/") as [string, string];

function writeHook(hookName: string, toolName: string | null) {
  if (!signalsPath) return;
  const row = {
    ts: new Date().toISOString(),
    event_id: randomUUID(),
    parent_id: null,
    kind: "HookEvent" as const,
    hook_name: hookName,
    tool_name: toolName,
  };
  appendFileSync(signalsPath, JSON.stringify(row) + "\n");
}

async function main() {
  writeHook("SessionStarted", null);

  const issue = await github<GitHubIssue>(`/repos/${owner}/${name}/issues/${issueNumber}`);
  const existing = issue.labels.find((l) => ["bug", "feature", "question"].includes(l.name));
  if (!existing) {
    await github(`/repos/${owner}/${name}/issues/${issueNumber}/labels`, {
      method: "POST",
      body: { labels: ["bug"] },
    });
  }

  writeHook("PostToolUse", "github_api");
  console.log(JSON.stringify({ task, summary: `triaged #${issueNumber}` }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return authToken ? { ...extra, Authorization: `Bearer ${authToken}` } : extra;
}

async function github<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: authHeaders(options.body ? { "content-type": "application/json" } : {}),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

function requiredEnv(envName: string) {
  const value = process.env[envName]?.trim();
  if (!value) throw new Error(`${envName} is required`);
  return value;
}
