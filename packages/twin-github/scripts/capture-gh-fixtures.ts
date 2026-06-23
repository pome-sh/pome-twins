import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const fixturesDir = join("test", "fixtures", "github-api");

const endpoints = [
  ["contents-file", "repos/cli/cli/contents/README.md?ref=trunk"],
  ["contents-directory", "repos/cli/cli/contents/docs?ref=trunk"],
  ["commits", "repos/cli/cli/commits?per_page=2"],
  ["issues", "repos/cli/cli/issues?per_page=2&state=open"],
  ["pull-detail", "repos/cli/cli/pulls/1"],
  ["pull-files", "repos/cli/cli/pulls/1/files"],
  ["pull-reviews", "repos/cli/cli/pulls/1/reviews"],
  ["pull-comments", "repos/cli/cli/pulls/1/comments"],
  ["combined-status", "repos/cli/cli/commits/trunk/status"],
  ["search-repositories", "search/repositories?q=cli/cli"],
  ["search-issues", "search/issues?q=repo:cli/cli+is:issue"]
] as const;

await mkdir(fixturesDir, { recursive: true });

for (const [name, endpoint] of endpoints) {
  const result = spawnSync("gh", ["api", endpoint], { encoding: "utf8" });
  if (result.status !== 0) {
    console.warn(`Skipping ${name}: ${result.stderr.trim() || result.stdout.trim()}`);
    continue;
  }
  const parsed = JSON.parse(result.stdout) as unknown;
  const filePath = join(fixturesDir, `${name}.json`);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(sanitize(parsed), null, 2)}\n`);
  console.log(`Captured ${filePath}`);
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 3).map(sanitize);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (["url", "html_url", "avatar_url", "node_id"].includes(key)) {
      output[key] = typeof child === "string" ? "<url>" : child;
    } else if (["id"].includes(key)) {
      output[key] = 1;
    } else if (["created_at", "updated_at", "closed_at", "merged_at", "pushed_at"].includes(key)) {
      output[key] = child ? "<timestamp>" : null;
    } else {
      output[key] = sanitize(child);
    }
  }
  return output;
}
