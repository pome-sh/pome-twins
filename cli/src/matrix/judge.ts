// SPDX-License-Identifier: Apache-2.0
//
// Judge wiring for the matrix (upgrade #1).
//
// `[P]` criteria are graded by an LLM judge that the runner resolves from env
// (POME_LLM_BASE_URL/_API_KEY/_MODEL → OPENAI_API_KEY → ANTHROPIC_API_KEY; see
// evaluator/probabilistic/config.ts). The judge client speaks the OpenAI
// `/chat/completions` shape over plain fetch — it does NOT use the AI SDK, so it
// does not pick up the gateway the way mcp-loop does. The matrix therefore
// translates a single `--judge-model` slug into the POME_LLM_* env trio the
// judge already understands, and injects it into every shelled `pome run` so a
// `[P]` criterion actually runs instead of being skipped.
//
// Routing is gateway-first: the Vercel AI Gateway exposes an OpenAI-compatible
// endpoint at https://ai-gateway.vercel.sh/v1, so one AI_GATEWAY_API_KEY routes
// any provider/model slug — the same one-key story the fleet itself uses.

export const GATEWAY_OPENAI_BASE_URL = "https://ai-gateway.vercel.sh/v1";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

export type JudgeEnvResolution = {
  // Env to inject into each child `pome run`. Empty when no judge is wired (the
  // [P] criteria then skip, exactly as before this upgrade).
  env: Record<string, string>;
  // One-line human note for the orchestrator to log (how the judge was routed,
  // or why it was not). Never contains the key value.
  note: string;
};

// Translate a `--judge-model` slug into the POME_LLM_* env the runner's judge
// reads. Pure over `env` so it is unit-testable and never reads process.env
// implicitly.
//
// Priority:
//   1. judgeModel unset                 → no judge (preserve skip behavior)
//   2. POME_LLM_BASE_URL already set     → respect the operator's explicit judge
//      config verbatim (it already flows to the child via process.env)
//   3. AI_GATEWAY_API_KEY set            → gateway OpenAI-compat, judgeModel slug
//   4. OPENAI_API_KEY set                → OpenAI direct, judgeModel id
//   5. nothing usable                    → no judge, with a note explaining why
export function resolveJudgeEnv(
  judgeModel: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): JudgeEnvResolution {
  const model = judgeModel?.trim();
  if (!model) {
    return { env: {}, note: "no --judge-model set; [P] criteria will skip" };
  }

  // The operator already pinned a judge endpoint — don't second-guess it. It
  // propagates to the child through process.env; we only note the model.
  if (env.POME_LLM_BASE_URL && env.POME_LLM_BASE_URL.trim() !== "") {
    return {
      env: {},
      note: `judge: using pre-set POME_LLM_* (model ${env.POME_LLM_MODEL ?? "?"})`,
    };
  }

  const gatewayKey = env.AI_GATEWAY_API_KEY;
  if (gatewayKey && gatewayKey.trim() !== "") {
    return {
      env: {
        POME_LLM_BASE_URL: GATEWAY_OPENAI_BASE_URL,
        POME_LLM_API_KEY: gatewayKey,
        POME_LLM_MODEL: model,
      },
      note: `judge: ${model} via Vercel AI Gateway`,
    };
  }

  const openaiKey = env.OPENAI_API_KEY;
  if (openaiKey && openaiKey.trim() !== "") {
    return {
      env: {
        POME_LLM_BASE_URL: OPENAI_BASE_URL,
        POME_LLM_API_KEY: openaiKey,
        POME_LLM_MODEL: model,
      },
      note: `judge: ${model} via OpenAI`,
    };
  }

  return {
    env: {},
    note: `judge: --judge-model ${model} set but no AI_GATEWAY_API_KEY / OPENAI_API_KEY / POME_LLM_* to route it — [P] criteria will skip`,
  };
}
