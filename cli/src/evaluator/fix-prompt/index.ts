// SPDX-License-Identifier: Apache-2.0
import { resolveJudgeConfig } from "../probabilistic/config.js";
import { callJudge, JudgeHttpError } from "../probabilistic/client.js";
import {
  FIX_PROMPT_SYSTEM_PROMPT,
  buildFixUserPrompt,
  type FixPromptContext,
} from "./prompt.js";

// Hard cap from FDRS-323: aim ~500 output tokens, hard cap ~2000.
// The cap lives here (not in the prompt template) so we control the
// HTTP-level guardrail independently of model-side instruction adherence.
const FIX_PROMPT_MAX_TOKENS = 2000;

/**
 * Generate a paste-into-IDE fix prompt for a failed scenario run.
 *
 * BYOK Flavor #1: the LLM call happens here, CLI-side, against the user's
 * OpenAI-compatible endpoint (resolved via {@link resolveJudgeConfig}). The
 * cloud never invokes the LLM and never sees the user's key.
 *
 * Errors are non-fatal: returns `null` on any failure path (no judge
 * configured, partial env config, HTTP error, network error, empty LLM
 * response). The caller writes `fix_prompt: null` to the Run row and the
 * dashboard renders an empty-state. We log a warning so the failure is
 * still visible in CLI output.
 */
export async function generateFixPrompt(ctx: FixPromptContext): Promise<string | null> {
  let cfg: ReturnType<typeof resolveJudgeConfig>;
  try {
    cfg = resolveJudgeConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`pome: fix-prompt skipped — ${message}`);
    return null;
  }

  if (!cfg) {
    console.warn(
      "pome: fix-prompt skipped — no LLM judge configured (set POME_LLM_API_KEY + BASE_URL + MODEL, or OPENAI_API_KEY, or ANTHROPIC_API_KEY).",
    );
    return null;
  }

  const userPrompt = buildFixUserPrompt(ctx);

  try {
    const call = await callJudge(cfg, FIX_PROMPT_SYSTEM_PROMPT, userPrompt, {
      maxTokens: FIX_PROMPT_MAX_TOKENS,
    });
    const trimmed = call.text.trim();
    if (!trimmed) {
      console.warn("pome: fix-prompt skipped — LLM returned an empty response.");
      return null;
    }
    return trimmed;
  } catch (err) {
    if (err instanceof JudgeHttpError) {
      console.warn(`pome: fix-prompt skipped — LLM endpoint error (${err.status}): ${err.message}`);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`pome: fix-prompt skipped — unexpected error: ${message}`);
    }
    return null;
  }
}

export { buildFixUserPrompt, FIX_PROMPT_SYSTEM_PROMPT, FIX_PROMPT_TEMPLATE_VERSION } from "./prompt.js";
export type { FixPromptContext } from "./prompt.js";
