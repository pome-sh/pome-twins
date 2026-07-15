// SPDX-License-Identifier: Apache-2.0
//
// FDRS-413 / F-766 — CAS-adapter triage agent fixture for the PR/FAQ
// acceptance #2 e2e gate. Drives scenario 01 (acme/api #1) through the real
// adapter surface (`withPome()` + wrapped `tool()`) so the resulting
// events.jsonl carries all five signal kinds the acceptance criteria require:
//
//   - LlmCallEvent     — one TCP CONNECT through HTTPS_PROXY (the bench-style
//                        path used by FDRS-405; the capture-server records the
//                        tunnel regardless of upstream success)
//   - TwinHttpEvent    — wrapped tool handler hits the twin while the ALS
//                        scope is active, so the fetch hook injects
//                        x-pome-correlation-id and the twin records
//                        tool_call_id=tlc_<hex>
//   - ToolUseEvent     — message-stream wrapper (`withToolEvents`) processes a
//                        synthetic SDK assistant message carrying a tool_use
//                        block, writing one ToolUseEvent row into the signals
//                        sidechannel
//   - HookEvent        — buildPomeHooks() produces the PreToolUse matcher we
//                        invoke explicitly with the same tool_use_id
//   - LlmTurnEvent     — the synthetic assistant message also carries a `usage`
//                        block (incl. cache-read/cache-creation tokens), so
//                        `withTurnUsage` writes one LlmTurnEvent per turn into
//                        the signals sidechannel (F-766)
//
// Using real adapter internals (rather than a fake-signals stub like the
// FDRS-411 fixture) is what makes this the *acceptance #2* gate: the trace
// shape is produced by the package under test, not by a hand-rolled mock.
//
// Why a fixture rather than a real `query()` call: CI must be deterministic
// and free of an Anthropic API key. `query()` reaches api.anthropic.com on the
// first tick, which we can't stub from outside the SDK without monkeypatching
// the module loader. Driving the adapter's public surface (`withPome` +
// wrapped `tool()`) and feeding `withToolEvents` a synthetic message stream
// exercises the same code paths a real run would, minus the LLM round-trip.

import { createConnection } from "node:net";
import { URL } from "node:url";
import { withPome, tool } from "../src/index.js";
import { buildPomeHooks } from "../src/hooks.js";
import { withToolEvents } from "../src/wrapQuery.js";
import { withTurnUsage } from "../src/turn-usage.js";

type GitHubIssue = {
  number: number;
  labels: Array<{ name: string }>;
};

if (process.env.POME_PREFLIGHT === "1") {
  console.log("preflight ok");
  process.exit(0);
}

const baseUrl = requiredEnv("POME_GITHUB_REST_URL");
const authToken = process.env.POME_AUTH_TOKEN;
const target = requiredEnv("POME_CAPTURE_TEST_TARGET");
const httpsProxy = process.env.HTTPS_PROXY ?? "";

// Pull the twin's origin into withPome's allowlist before any fetch fires. The
// CLI runner injects POME_GITHUB_REST_URL / POME_GITHUB_MCP_URL so the env
// inference picks them up automatically; pinning explicitly makes the fixture
// resilient to env-name changes.
withPome({ twinHosts: [new URL(baseUrl).origin] });

await main();

async function main(): Promise<void> {
  // 1) Wrapped tool — the handler runs inside the adapter's ALS scope, so each
  // outbound fetch picks up x-pome-correlation-id automatically. We use the
  // SDK's `tool()` re-export to exercise the real wrapping path, not just a
  // hand-rolled call into wrapHandler.
  const triageIssue = tool(
    "triage_issue",
    "Label an open GitHub issue and assign a triager.",
    // The SDK's tool() infers the input shape from this schema at runtime via
    // an internal zod path; supplying an empty object is fine because the
    // fixture never serializes the schema to JSON.
    {} as never,
    async () => {
      const issue = await twinJson<GitHubIssue>(`/repos/acme/api/issues/1`);
      const alreadyTriaged = issue.labels.some((l) =>
        ["bug", "feature", "question"].includes(l.name),
      );
      if (!alreadyTriaged) {
        await twinJson(`/repos/acme/api/issues/1/labels`, {
          method: "POST",
          body: { labels: ["bug"] },
        });
        await twinJson(`/repos/acme/api/issues/1/assignees`, {
          method: "POST",
          body: { assignees: ["alice"] },
        });
      }
      return { content: [{ type: "text", text: "triaged #1 as bug" }] };
    },
  );

  // 2) Invoke the wrapped handler directly. The SDK normally drives this from
  // `query()`, but we don't need an Anthropic round-trip for the acceptance
  // gate — the wrap is what matters. The shape of the call mirrors what the
  // SDK's MCP transport does internally.
  const TOOL_USE_ID = "toolu_fdrs413_acceptance2";
  const handlerResult = await (
    triageIssue as unknown as {
      handler: (input: unknown, extra: unknown) => Promise<unknown>;
    }
  ).handler({}, { tool_use_id: TOOL_USE_ID });

  // 3) Drive a synthetic SDK message stream through the real message-stream
  // wrappers so they write the ToolUseEvent + ToolResultEvent rows AND the
  // LlmTurnEvent row (the assistant turn carries a usage block) that the
  // correlator merges into events.jsonl. Iterating to completion is what
  // triggers the writes.
  for await (const _ of withTurnUsage(
    withToolEvents(syntheticSdkStream(TOOL_USE_ID, handlerResult)),
  )) {
    void _;
  }

  // 4) Fire the PreToolUse hook ourselves. The SDK normally invokes pome's
  // merged matcher on its own; with no real query() in the loop we drive it
  // manually so the HookEvent row lands in signals.jsonl.
  const pomeHooks = buildPomeHooks();
  const preToolUse = pomeHooks.PreToolUse?.[0]?.hooks[0];
  if (!preToolUse) throw new Error("buildPomeHooks() returned no PreToolUse matcher");
  await preToolUse(
    {
      hook_event_name: "PreToolUse",
      tool_name: "triage_issue",
      tool_input: {},
      tool_use_id: TOOL_USE_ID,
    } as Parameters<typeof preToolUse>[0],
    TOOL_USE_ID,
    { signal: new AbortController().signal },
  );

  // 5) LlmCallEvent — one TCP CONNECT through HTTPS_PROXY. We can't talk to
  // api.anthropic.com from CI without a key + network egress, but the
  // capture-server records every CONNECT tunnel regardless of inner traffic,
  // so an echo upstream is enough to surface the row.
  if (!httpsProxy) {
    throw new Error("HTTPS_PROXY is empty — gate must run with capture-server");
  }
  const [host, portStr] = target.split(":");
  if (!host || !portStr) throw new Error(`POME_CAPTURE_TEST_TARGET malformed: "${target}"`);
  await connectViaProxy(httpsProxy, host, Number.parseInt(portStr, 10));

  process.stdout.write(JSON.stringify({ summary: "cas-adapter triage ok" }) + "\n");
}

async function* syntheticSdkStream(
  toolUseId: string,
  handlerResult: unknown,
): AsyncGenerator<
  { type: string; message?: { content?: unknown; model?: string; usage?: unknown; stop_reason?: string } },
  void,
  unknown
> {
  // Mirrors the SDK's assistant-then-user pattern: assistant emits the
  // tool_use block (with the turn's usage block, incl. cache tokens, so
  // withTurnUsage writes an LlmTurnEvent), then a follow-up user turn carries
  // the tool_result.
  yield {
    type: "assistant",
    message: {
      model: "claude-opus-4-8",
      stop_reason: "tool_use",
      usage: {
        input_tokens: 1200,
        output_tokens: 340,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 128,
      },
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "triage_issue",
          input: { issue: 1, label: "bug" },
        },
      ],
    },
  };
  yield {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: handlerResult,
          is_error: false,
        },
      ],
    },
  };
}

async function twinJson<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  if (options.body) headers["content-type"] = "application/json";
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    throw new Error(
      `twin ${options.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as T;
}

function connectViaProxy(proxyUrl: string, host: string, port: number): Promise<void> {
  const url = new URL(proxyUrl);
  const proxyHost = url.hostname;
  const proxyPort = Number.parseInt(url.port, 10) || 80;
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: proxyHost, port: proxyPort });
    let headerBuf = "";
    let headerDone = false;
    sock.once("error", reject);
    sock.once("close", () => resolve());
    sock.on("data", (chunk: Buffer) => {
      if (headerDone) return;
      headerBuf += chunk.toString("utf8");
      if (headerBuf.indexOf("\r\n\r\n") === -1) return;
      headerDone = true;
      if (!/^HTTP\/1\.[01] 200/.test(headerBuf)) {
        sock.destroy();
        reject(new Error(`CONNECT failed: ${headerBuf.slice(0, 80)}`));
        return;
      }
      sock.end();
    });
    sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
  });
}

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return v;
}
