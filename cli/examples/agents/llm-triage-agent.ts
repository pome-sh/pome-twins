if (process.env.POME_PREFLIGHT === "1") {
  console.log("preflight ok");
  process.exit(0);
}

const task = requiredEnv("POME_TASK");
const baseUrl = requiredEnv("POME_GITHUB_REST_URL");
const apiKey = requiredEnv("ANTHROPIC_API_KEY");
const authToken = process.env.POME_AUTH_TOKEN;

const system = `You are a GitHub issue triage agent for acme/api.
Use the tools to inspect issue #1, classify it as bug, feature, or question, apply the right label, and assign the right owner for bugs.
Orders bugs go to alice. Auth bugs go to bob.
If a label is missing, create it before retrying.
If the issue is already triaged with bug, feature, or question, do not mutate it.`;

const tools = [
  tool("get_issue", "Read an issue", { owner: "string", repo: "string", number: "number" }),
  tool("apply_label", "Apply a label to an issue", { owner: "string", repo: "string", number: "number", label: "string" }),
  tool("create_label", "Create a repository label", { owner: "string", repo: "string", label: "string" }),
  tool("assign_user", "Assign a collaborator to an issue", { owner: "string", repo: "string", number: "number", login: "string" })
];

// Wrapped in main() rather than left at the top level so `npx tsx` works in
// a project without `"type": "module"` (where top-level await fails CJS
// transform).
async function main() {
  const messages: any[] = [{ role: "user", content: task }];
  let finalText = "";

  for (let turn = 0; turn < 8; turn += 1) {
    const response = await anthropicMessage(messages);
    messages.push({ role: "assistant", content: response.content });
    const toolUses = response.content.filter((block: any) => block.type === "tool_use");
    const text = response.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
    if (text) finalText = text;
    if (!toolUses.length) break;

    messages.push({
      role: "user",
      content: await Promise.all(toolUses.map(runTool))
    });
  }

  console.log(JSON.stringify({ task, summary: finalText || "Agent finished." }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function anthropicMessage(messages: any[]) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 2048,
      system,
      tools,
      messages
    })
  });

  if (!response.ok) throw new Error(`Anthropic request failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as any;
}

async function runTool(block: any) {
  try {
    const result = await callGitHubTool(block.name, block.input);
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: JSON.stringify(result)
    };
  } catch (error) {
    return {
      type: "tool_result",
      tool_use_id: block.id,
      is_error: true,
      content: error instanceof Error ? error.message : "Tool failed"
    };
  }
}

async function callGitHubTool(name: string, input: any) {
  if (name === "get_issue") {
    return github(`/repos/${input.owner}/${input.repo}/issues/${input.number}`);
  }
  if (name === "apply_label") {
    return github(`/repos/${input.owner}/${input.repo}/issues/${input.number}/labels`, "POST", { labels: [input.label] });
  }
  if (name === "create_label") {
    return github(`/repos/${input.owner}/${input.repo}/labels`, "POST", { name: input.label, color: "ededed" });
  }
  if (name === "assign_user") {
    return github(`/repos/${input.owner}/${input.repo}/issues/${input.number}/assignees`, "POST", { assignees: [input.login] });
  }
  throw new Error(`Unknown tool ${name}`);
}

async function github(path: string, method = "GET", body?: unknown) {
  const headers: Record<string, string> = body ? { "content-type": "application/json" } : {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${text}`);
  return parsed;
}

function tool(name: string, description: string, fields: Record<string, "string" | "number">) {
  return {
    name,
    description,
    input_schema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(fields).map(([field, type]) => [
          field,
          {
            type
          }
        ])
      ),
      required: Object.keys(fields)
    }
  };
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
