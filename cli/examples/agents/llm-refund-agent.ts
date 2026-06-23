if (process.env.POME_PREFLIGHT === "1") {
  console.log("preflight ok");
  process.exit(0);
}

const task = requiredEnv("POME_TASK");
const baseUrl = requiredEnv("POME_STRIPE_API_BASE");
const stripeKey = requiredEnv("POME_STRIPE_API_KEY");
const anthropicKey = requiredEnv("ANTHROPIC_API_KEY");

const system = `You are a customer-support agent for Acme Inc. integrated with the Stripe REST API.
You have tools to read charges and issue refunds against Stripe.
Amounts are integers in the smallest currency unit (cents for USD: $75 is 7500).
Follow the customer's instructions exactly — if they ask for a $75 refund on a charge, issue exactly $75.
If a Stripe API call fails, follow the customer's instructions about retrying.
Stop once the task is complete.`;

const tools = [
  tool("get_charge", "Read a Stripe charge by id (GET /v1/charges/:id).", { charge_id: "string" }),
  tool("issue_refund", "Issue a refund against a charge (POST /v1/refunds).", { charge: "string", amount: "number" })
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
      "x-api-key": anthropicKey,
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
    const result = await callStripeTool(block.name, block.input);
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

async function callStripeTool(name: string, input: any) {
  if (name === "get_charge") {
    return stripe(`/v1/charges/${encodeURIComponent(input.charge_id)}`);
  }
  if (name === "issue_refund") {
    const body = new URLSearchParams({
      charge: String(input.charge),
      amount: String(input.amount)
    });
    return stripe("/v1/refunds", "POST", body);
  }
  throw new Error(`Unknown tool ${name}`);
}

// Hero bug surfaced by scenarios/14-stripe-refund-retry.md: this agent intentionally
// never sends an `Idempotency-Key` header on POST /v1/refunds. When the twin's
// failure-injection middleware drops the first response, the LLM-driven retry
// creates a second refund row — exactly the double-charge bug Pome is built to catch.
// Fixed variant: examples/agents/llm-refund-agent-fixed.ts (forward-looking, not yet shipped).
async function stripe(path: string, method = "GET", body?: URLSearchParams) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${stripeKey}`
  };
  if (body) headers["content-type"] = "application/x-www-form-urlencoded";

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? body.toString() : undefined
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
