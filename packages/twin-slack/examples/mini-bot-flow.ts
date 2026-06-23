// Mini end-to-end flow: drives the 3 stateful MCP tools + a few read tools
// against the twin's legacy `/mcp/call` route. Mirrors twin-github's
// examples/mini-bot-flow.ts shape; swap in the JSON-RPC `/mcp` endpoint
// (with @modelcontextprotocol/sdk's Client) for production-flavored tests.

const baseUrl = process.env.SLACK_CLONE_MCP_URL ?? "http://127.0.0.1:3333/s/demo/mcp";
const token = process.env.SLACK_CLONE_TOKEN;
if (!token) throw new Error("set SLACK_CLONE_TOKEN to a JWT or xoxb-pome-* token");

async function tool(name: string, args: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/call`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tool: name, arguments: args }),
  });
  if (!response.ok) throw new Error(`${name} failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<Record<string, unknown>>;
}

// 1. Discover the workspace.
const channels = (await tool("slack_list_channels", { limit: 25 })) as {
  channels: Array<{ id: string; name: string }>;
};
const general = channels.channels.find((c) => c.name === "general");
if (!general) throw new Error("seeded #general channel missing");

const users = (await tool("slack_get_users", { limit: 50 })) as {
  members: Array<{ id: string; name: string }>;
};
console.log(`workspace has ${users.members.length} users across ${channels.channels.length} channels`);

// 2. Post a parent message.
const parent = (await tool("slack_post_message", {
  channel_id: general.id,
  text: "Bot flow: starting a thread",
})) as { ts: string };
console.log(`posted parent ts=${parent.ts}`);

// 3. Reply twice in the thread.
await tool("slack_reply_to_thread", {
  channel_id: general.id,
  thread_ts: parent.ts,
  text: "Bot flow: reply #1",
});
await tool("slack_reply_to_thread", {
  channel_id: general.id,
  thread_ts: parent.ts,
  text: "Bot flow: reply #2",
});

// 4. React.
await tool("slack_add_reaction", {
  channel_id: general.id,
  timestamp: parent.ts,
  reaction: "rocket",
});

// 5. Read it back.
const replies = (await tool("slack_get_thread_replies", {
  channel_id: general.id,
  thread_ts: parent.ts,
})) as { messages: Array<{ text: string }> };
console.log(`thread shows ${replies.messages.length} messages: ${replies.messages.map((m) => m.text).join(" | ")}`);

const history = (await tool("slack_get_channel_history", {
  channel_id: general.id,
  limit: 5,
})) as { messages: Array<{ ts: string }> };
console.log(`channel head: ${history.messages.map((m) => m.ts).join(", ")}`);
