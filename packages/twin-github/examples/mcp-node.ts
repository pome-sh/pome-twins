const baseUrl = process.env.GITHUB_CLONE_MCP_URL ?? "http://127.0.0.1:3333/mcp";

const response = await fetch(`${baseUrl}/call`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    tool: "search_repositories",
    arguments: { query: "acme" }
  })
});

if (!response.ok) {
  throw new Error(`MCP call failed: ${response.status} ${await response.text()}`);
}

console.log(JSON.stringify(await response.json(), null, 2));
