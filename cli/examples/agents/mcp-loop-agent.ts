// SPDX-License-Identifier: Apache-2.0
//
// Thin runnable entrypoint for the model-agnostic mcp-loop scaffold (spec §2).
// Invoked by `pome matrix` as `npx tsx examples/agents/mcp-loop-agent.ts` with
// the model + prompt passed via env (POME_MATRIX_MODEL / POME_MATRIX_PROMPT_PATH)
// and the standard twin contract (POME_TASK / POME_<TWIN>_MCP_URL /
// POME_AUTH_TOKEN). All loop logic lives in src/scaffolds/mcp-loop/.
//
// Like every example agent: POME_PREFLIGHT==="1" → print "preflight ok", exit 0,
// touching no network and constructing no model.

// Preflight guard MUST run before any model construction or network I/O.
if (process.env.POME_PREFLIGHT === "1") {
  console.log("preflight ok");
  process.exit(0);
}

import { readFile } from "node:fs/promises";
import {
  createHttpMcpClient,
  resolveLoopEnv,
  runMcpLoop,
} from "../../src/scaffolds/mcp-loop/loop.js";
import {
  preflightModel,
  preflightModelMessage,
  resolveLlmHost,
  resolveModel,
} from "../../src/scaffolds/mcp-loop/providers.js";

// Wrapped in main() so `npx tsx` works in a package without "type":"module"
// (top-level await fails the CJS transform there).
async function main() {
  const contract = resolveLoopEnv(process.env);

  // Fail early + clearly if the provider key is missing (defense in depth — the
  // matrix preflights the whole fleet first, but a hand-run agent might not).
  const pf = preflightModel(contract.model, process.env);
  if (!pf.ok) {
    console.error(preflightModelMessage(pf));
    process.exit(3);
  }

  const system = contract.promptPath
    ? await readFile(contract.promptPath, "utf8")
    : undefined;

  const model = resolveModel(contract.model, process.env);
  const mcp = createHttpMcpClient({
    url: contract.mcpUrl,
    authToken: contract.authToken,
  });

  const result = await runMcpLoop({
    model,
    mcp,
    task: contract.task,
    system,
    signalsPath: contract.signalsPath,
    // The verbatim slug is the LlmCallEvent.model label + the Tier-2 pricing
    // key; host is the synthetic source for the emitted LLM-usage rows.
    modelId: contract.model,
    host: resolveLlmHost(contract.model, process.env),
  });

  console.log(
    JSON.stringify({
      task: contract.task,
      model: contract.model,
      summary: result.text || "Agent finished.",
      tool_calls: result.toolCallCount,
      steps: result.steps,
      finish_reason: result.finishReason,
    }),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
