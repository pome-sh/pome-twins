// SPDX-License-Identifier: Apache-2.0
//
// `pome fix-prompt` — assemble a paste-into-IDE remediation prompt for a run
// (FDRS-657). CAPTURE-ONLY: no LLM/judge call happens here. The former BYOK
// CLI-side judge call (`callJudge`) that generated the handoff was removed;
// this now returns the fully-assembled prompt (system instructions + the
// scenario's criteria + the captured trace) for the developer to paste into
// their own coding assistant.

import {
  FIX_PROMPT_SYSTEM_PROMPT,
  buildFixUserPrompt,
  type FixPromptContext,
} from "./prompt.js";

/**
 * Build the paste-into-IDE fix prompt from the raw trace + the scenario's
 * criteria. PURE + synchronous — no network, no LLM, no local judge.
 *
 * The output is a complete prompt: the system instructions (how to write the
 * fix handoff) followed by the run context. The developer pastes it into
 * Cursor / Claude Code, whose model produces the actual handoff. The OSS CLI
 * never invokes a model itself.
 */
export function buildFixPrompt(ctx: FixPromptContext): string {
  return `${FIX_PROMPT_SYSTEM_PROMPT}\n\n${buildFixUserPrompt(ctx)}`;
}

export {
  buildFixUserPrompt,
  FIX_PROMPT_SYSTEM_PROMPT,
  FIX_PROMPT_TEMPLATE_VERSION,
} from "./prompt.js";
export type { FixPromptContext } from "./prompt.js";
