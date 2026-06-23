const baseUrl = process.env.GITHUB_CLONE_MCP_URL ?? "http://127.0.0.1:3333/mcp";

async function tool(name: string, args: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: name, arguments: args })
  });
  if (!response.ok) throw new Error(`${name} failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}

await tool("create_repository", { owner: "demo", name: "bot-target", description: "Bot flow target" });
await tool("create_branch", { owner: "demo", repo: "bot-target", branch: "feature/readme" });
await tool("push_files", {
  owner: "demo",
  repo: "bot-target",
  branch: "feature/readme",
  message: "Update README",
  files: [{ path: "README.md", content: "# Bot Target\n\nUpdated by a local bot.\n" }]
});
const pr = await tool("create_pull_request", {
  owner: "demo",
  repo: "bot-target",
  title: "Update README",
  head: "feature/readme",
  base: "main"
});
await tool("create_pull_request_review", {
  owner: "demo",
  repo: "bot-target",
  pull_number: pr.number,
  event: "APPROVE",
  body: "Verified locally."
});
await tool("merge_pull_request", { owner: "demo", repo: "bot-target", pull_number: pr.number });
const readme = await tool("get_file_contents", { owner: "demo", repo: "bot-target", path: "README.md" });

console.log(`Merged PR #${pr.number}; README sha is ${readme.sha}`);
