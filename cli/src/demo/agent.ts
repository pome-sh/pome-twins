// SPDX-License-Identifier: Apache-2.0
// FDRS-643 — the bundled demo agent: a small tool-loop agent that drives the
// packaged first-run demo task against the LOCAL GitHub twin, with its model
// calls served by pome's anonymous demo gateway (FDRS-637).
//
// It is spawned by `pome demo` as `pome demo-agent`, a child of the REAL
// capture path (runScenario): the runner injects the standard POME_* twin
// contract plus the demo-specific vars below, and HTTP(S)_PROXY pointing at
// the capture-server so the gateway calls land in events.jsonl as genuine
// LlmCallEvent rows.
//
// Env contract (beyond runScenario's standard POME_* set):
//   POME_DEMO_LLM_URL    — {POME_API_BASE}/v1/demo/sessions/{sid}/llm
//   POME_DEMO_TOKEN      — the trial session's demo_token (Bearer)
//   POME_DEMO_TASK_NAME  — server-allowlisted task name ("first-run-demo")
//   POME_DEMO_REPO       — "owner/name" the packaged seed created
//
// The agent exposes exactly three tools — list_open_issues, add_label,
// comment_on_issue — matching the packaged task. It never scores anything
// (capture-only CLI): it acts, the trace is judged in the cloud.
//
// Honest failure contract: when the GATEWAY says the demo is at capacity
// (402/429 machine-readable errors), the agent prints a
// `POME_DEMO_CAPACITY:<kind>` marker to stderr and exits non-zero so the
// parent renders the labeled state — never a fabricated completion.

import {
  callDemoGateway,
  type DemoMessage,
  type DemoTextPart,
  type DemoToolCallPart,
  type DemoToolDef,
  type DemoToolResultPart,
} from "./gateway.js";
import { DemoCapacityError, capacityMarkerLine } from "./capacity.js";

/** Ceiling on gateway round-trips per trial. Deliberately below the server's
 *  per-session call cap (default 20) so a wandering loop fails as OUR
 *  "agent gave up", not as a server 429. */
const MAX_TURNS = 12;

export const DEMO_AGENT_TOOLS: DemoToolDef[] = [
  {
    name: "list_open_issues",
    description:
      "List the open issues in the repository you are triaging. Returns number, title, body, and current labels for each.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "add_label",
    description:
      "Apply an EXISTING label to an issue by number. Fails if the label does not exist in the repository.",
    input_schema: {
      type: "object",
      properties: {
        issue_number: { type: "number", description: "Issue number, e.g. 1" },
        label: { type: "string", description: "Name of an existing label" },
      },
      required: ["issue_number", "label"],
      additionalProperties: false,
    },
  },
  {
    name: "comment_on_issue",
    description: "Leave one comment on an issue by number.",
    input_schema: {
      type: "object",
      properties: {
        issue_number: { type: "number", description: "Issue number, e.g. 1" },
        body: { type: "string", description: "Comment body (markdown)" },
      },
      required: ["issue_number", "body"],
      additionalProperties: false,
    },
  },
];

export interface DemoAgentEnv {
  task: string;
  twinRestUrl: string;
  twinAuthToken: string;
  gatewayUrl: string;
  demoToken: string;
  taskName: string;
  repo: string; // "owner/name"
  proxyUrl?: string;
  noProxy?: string;
}

export function readDemoAgentEnv(env: NodeJS.ProcessEnv): DemoAgentEnv {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required for pome demo-agent`);
    return value;
  };
  return {
    task: required("POME_TASK"),
    twinRestUrl: required("POME_GITHUB_REST_URL"),
    twinAuthToken: required("POME_AUTH_TOKEN"),
    gatewayUrl: required("POME_DEMO_LLM_URL"),
    demoToken: required("POME_DEMO_TOKEN"),
    taskName: required("POME_DEMO_TASK_NAME"),
    repo: required("POME_DEMO_REPO"),
    proxyUrl: env.HTTPS_PROXY ?? env.HTTP_PROXY,
    noProxy: env.NO_PROXY,
  };
}

interface TwinIssue {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string } | string>;
}

async function twinFetch<T>(
  agentEnv: DemoAgentEnv,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`${agentEnv.twinRestUrl}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${agentEnv.twinAuthToken}`,
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  return (text.length ? JSON.parse(text) : {}) as T;
}

/** Execute one tool call against the twin. Tool failures are returned as
 *  error strings (the model gets to react), not thrown. */
export async function executeDemoTool(
  agentEnv: DemoAgentEnv,
  name: string,
  input: unknown,
): Promise<{ output: unknown; isError: boolean }> {
  const [owner, repo] = agentEnv.repo.split("/") as [string, string];
  const args = (input ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "list_open_issues": {
        const issues = await twinFetch<TwinIssue[]>(
          agentEnv,
          `/repos/${owner}/${repo}/issues?state=open`,
        );
        return {
          output: issues.map((issue) => ({
            number: issue.number,
            title: issue.title,
            body: issue.body,
            labels: (issue.labels ?? []).map((label) =>
              typeof label === "string" ? label : label.name,
            ),
          })),
          isError: false,
        };
      }
      case "add_label": {
        const issueNumber = Number(args.issue_number);
        const label = String(args.label ?? "");
        if (!Number.isInteger(issueNumber) || label.length === 0) {
          return { output: "add_label requires issue_number and label", isError: true };
        }
        await twinFetch(agentEnv, `/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
          method: "POST",
          body: { labels: [label] },
        });
        return { output: `applied label "${label}" to issue #${issueNumber}`, isError: false };
      }
      case "comment_on_issue": {
        const issueNumber = Number(args.issue_number);
        const body = String(args.body ?? "");
        if (!Number.isInteger(issueNumber) || body.length === 0) {
          return { output: "comment_on_issue requires issue_number and body", isError: true };
        }
        await twinFetch(agentEnv, `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
          method: "POST",
          body: { body },
        });
        return { output: `commented on issue #${issueNumber}`, isError: false };
      }
      default:
        return { output: `unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return {
      output: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

/**
 * The tool loop. Exit codes: 0 done; 1 loop error/exhaustion; 42 gateway
 * capacity (marker on stderr).
 */
export async function runDemoAgent(
  agentEnv: DemoAgentEnv,
  io: { log: (line: string) => void; error: (line: string) => void },
): Promise<number> {
  const messages: DemoMessage[] = [{ role: "user", content: agentEnv.task }];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const response = await callDemoGateway({
        gatewayUrl: agentEnv.gatewayUrl,
        demoToken: agentEnv.demoToken,
        taskName: agentEnv.taskName,
        messages,
        tools: DEMO_AGENT_TOOLS,
        proxyUrl: agentEnv.proxyUrl,
        noProxy: agentEnv.noProxy,
      });

      if (response.tool_calls.length === 0) {
        io.log(response.text.trim().length > 0 ? response.text.trim() : "(done)");
        return 0;
      }

      const assistantParts: Array<DemoTextPart | DemoToolCallPart> = [];
      if (response.text.trim().length > 0) {
        assistantParts.push({ type: "text", text: response.text });
      }
      for (const call of response.tool_calls) {
        assistantParts.push({
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
        });
      }
      messages.push({ role: "assistant", content: assistantParts });

      const resultParts: DemoToolResultPart[] = [];
      for (const call of response.tool_calls) {
        const result = await executeDemoTool(agentEnv, call.name, call.input);
        // AI SDK canonical tool-result output shape ({type, value}) — the
        // gateway forwards `output` verbatim into ModelMessage content.
        resultParts.push({
          type: "tool-result",
          toolCallId: call.id,
          toolName: call.name,
          output: result.isError
            ? { type: "error-text", value: String(result.output) }
            : { type: "json", value: result.output },
        });
      }
      messages.push({ role: "tool", content: resultParts });
    }

    io.error(`demo agent gave up after ${MAX_TURNS} model calls without finishing`);
    return 1;
  } catch (err) {
    if (err instanceof DemoCapacityError) {
      io.error(capacityMarkerLine(err.kind));
      io.error(err.message);
      return 42;
    }
    io.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

/** `pome demo-agent` entrypoint (hidden command in main.ts). */
export async function runDemoAgentCommand(): Promise<number> {
  if (process.env.POME_PREFLIGHT === "1") {
    console.log("preflight ok");
    return 0;
  }
  const agentEnv = readDemoAgentEnv(process.env);
  return runDemoAgent(agentEnv, {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
}
