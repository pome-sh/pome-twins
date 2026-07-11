import { serve } from "@hono/node-server";
import { sign } from "hono/jwt";
import { createGitHubCloneApp } from "../src/twin.js";

const port = 43333;
const sid = "smoke-session";
const secret = process.env.TWIN_AUTH_SECRET ?? "dev-only-insecure-secret";
const token = await sign(
  { sid, team_id: "tm_smoke", exp: Math.floor(Date.now() / 1000) + 3600 },
  secret
);

const app = createGitHubCloneApp();
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
const baseUrl = `http://127.0.0.1:${port}`;
const sessionBase = `${baseUrl}/s/${sid}`;
const authHeader = { authorization: `Bearer ${token}` };

try {
  const health = await fetch(`${baseUrl}/healthz`);
  if (!health.ok) throw new Error(`healthz failed: ${health.status}`);

  const tools = await fetch(`${sessionBase}/mcp/tools`, { headers: authHeader }).then((response) => response.json()) as { tools: unknown[] };
  if (tools.tools.length !== 65) throw new Error(`expected 65 tools, got ${tools.tools.length}`);

  const issue = await fetch(`${sessionBase}/repos/acme/api/issues`, {
    method: "POST",
    headers: { ...authHeader, "content-type": "application/json" },
    body: JSON.stringify({ title: "Smoke issue", body: "Created by smoke test." })
  });
  if (issue.status !== 201) throw new Error(`issue create failed: ${issue.status}`);

  const mcp = await fetch(`${sessionBase}/mcp/call`, {
    method: "POST",
    headers: { ...authHeader, "content-type": "application/json" },
    body: JSON.stringify({ tool: "search_repositories", arguments: { query: "acme" } })
  });
  if (!mcp.ok) throw new Error(`mcp call failed: ${mcp.status}`);

  console.log("GitHub clone smoke check passed.");
} finally {
  server.close();
}
