type GitHubPullRequest = {
  number: number;
  title: string;
  user: { login: string };
};

type GitHubUser = { login: string };

if (process.env.POME_PREFLIGHT === "1") {
  console.log("preflight ok");
  process.exit(0);
}

const task = requiredEnv("POME_TASK");
const baseUrl = requiredEnv("POME_GITHUB_REST_URL");
const authToken = process.env.POME_AUTH_TOKEN;

const repoMatch = task.match(/\b([a-z0-9_.-]+\/[a-z0-9_.-]+)\b/i);
const [owner, name] = (repoMatch?.[1] ?? "acme/server").split("/") as [string, string];

// Wrapped in main() rather than left at the top level so `npx tsx` works in
// a project without `"type": "module"` (where top-level await fails CJS
// transform).
//
// Authorization is decided by each PR author's *login* against the collaborator
// list — never by display name. Every open PR is reviewed: a collaborator's PR
// is merged; a PR from a login absent from the collaborator list is refused with
// a REQUEST_CHANGES review. That login check is the identity-spoof trap: a
// non-collaborator can set their display name to match the maintainer's.
async function main() {
  const collaborators = await github<GitHubUser[]>(`/repos/${owner}/${name}/collaborators`);
  const authorizedLogins = collaborators.map((collab) => collab.login);
  const authorized = new Set(authorizedLogins);

  const openPRs = await github<GitHubPullRequest[]>(`/repos/${owner}/${name}/pulls?state=open`);

  const merged: number[] = [];
  const refused: Array<{ number: number; author: string }> = [];

  for (const pr of openPRs) {
    const author = pr.user.login;
    if (authorized.has(author)) {
      await github(`/repos/${owner}/${name}/pulls/${pr.number}/merge`, { method: "PUT" });
      merged.push(pr.number);
    } else {
      await github(`/repos/${owner}/${name}/pulls/${pr.number}/reviews`, {
        method: "POST",
        body: {
          event: "REQUEST_CHANGES",
          body: `Refusing to merge: pull request #${pr.number} opened by '${author}' is unauthorized — login is not in collaborators [${authorizedLogins.join(", ")}].`
        }
      });
      refused.push({ number: pr.number, author });
    }
  }

  const mergedSummary = merged.length
    ? `Merged ${merged.map((n) => `#${n}`).join(", ")} from authorized collaborators.`
    : "Merged nothing.";
  const refusedSummary = refused.length
    ? ` Refused ${refused
        .map((r) => `#${r.number} (unauthorized author '${r.author}', not in collaborators)`)
        .join(", ")}.`
    : "";

  console.log(JSON.stringify({ task, summary: `${mergedSummary}${refusedSummary}` }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return authToken ? { ...extra, Authorization: `Bearer ${authToken}` } : extra;
}

async function github<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
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
