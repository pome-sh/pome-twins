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

// Wrapped in main() rather than left at the top level so `npx tsx` works in
// a project without `"type": "module"` (where top-level await fails CJS
// transform).
async function main() {
  const issue = await github<GitHubIssue>(`/repos/${owner}/${name}/issues/${issueNumber}`);
  const existingClassification = issue.labels.find((label) => ["bug", "feature", "question"].includes(label.name));

  if (existingClassification) {
    console.log(JSON.stringify({ task, summary: `Issue #${issueNumber} is already triaged as ${existingClassification.name}.` }));
    process.exit(0);
  }

  const classification = classifyIssue(issue);
  await ensureLabelApplied(owner, name, issueNumber, classification.label);

  if (classification.assignee) {
    await github(`/repos/${owner}/${name}/issues/${issueNumber}/assignees`, {
      method: "POST",
      body: { assignees: [classification.assignee] }
    });
  }

  console.log(
    JSON.stringify({
      task,
      summary: `Issue #${issueNumber} labeled ${classification.label}${classification.assignee ? ` and assigned to ${classification.assignee}` : ""}.`
    })
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function ensureLabelApplied(owner: string, repo: string, issueNumber: number, label: string) {
  const apply = await fetch(`${baseUrl}/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ labels: [label] })
  });

  if (apply.status === 422) {
    await github(`/repos/${owner}/${repo}/labels`, {
      method: "POST",
      body: { name: label, color: label === "bug" ? "d73a4a" : "ededed" }
    });
    await github(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
      method: "POST",
      body: { labels: [label] }
    });
    return;
  }

  if (!apply.ok) {
    throw new Error(`Failed to apply label ${label}: ${apply.status} ${await apply.text()}`);
  }
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return authToken ? { ...extra, Authorization: `Bearer ${authToken}` } : extra;
}

function classifyIssue(issue: GitHubIssue) {
  const text = `${issue.title}\n${issue.body}`.toLowerCase();
  if (text.includes("500") || text.includes("error") || text.includes("null") || text.includes("failing")) {
    return {
      label: "bug",
      assignee: text.includes("auth") ? "bob" : "alice"
    };
  }
  if (text.includes("add") || text.includes("export") || text.includes("feature")) {
    return { label: "feature", assignee: null };
  }
  return { label: "question", assignee: null };
}

async function github<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: authHeaders(options.body ? { "content-type": "application/json" } : {}),
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as T;
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
