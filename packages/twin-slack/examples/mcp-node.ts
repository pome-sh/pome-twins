// Minimal MCP call against the twin's legacy `/mcp/call` route. For the real
// JSON-RPC 2.0 endpoint use `scripts/validate-mcp.ts` or the MCP SDK directly.
const baseUrl = process.env.SLACK_CLONE_MCP_URL ?? "http://127.0.0.1:3333/s/demo/mcp";
const token = process.env.SLACK_CLONE_TOKEN;
if (!token) throw new Error("set SLACK_CLONE_TOKEN to a JWT or xoxb-pome-* token");

const response = await fetch(`${baseUrl}/call`, {
  method: "POST",
  headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    tool: "slack_list_channels",
    arguments: { limit: 10 },
  }),
});

if (!response.ok) {
  throw new Error(`MCP call failed: ${response.status} ${await response.text()}`);
}

console.log(JSON.stringify(await response.json(), null, 2));
