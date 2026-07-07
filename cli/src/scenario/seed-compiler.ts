// SPDX-License-Identifier: Apache-2.0
/**
 * Compile a prose seed description into a JSON seed object matching
 * `seedStateSchema`. Uses the Anthropic Messages API with structured
 * output (`output_config` + `zodOutputFormat`).
 *
 * See `docs/agents/scenario-prose-seed.md` for the prose convention.
 *
 * Why Messages API and not the Agent SDK: this is a pure prose-to-JSON
 * transform with no tools needed during generation, so the agent loop
 * adds only cost and variance. The bundled Claude Code system prompt
 * also pushes per-call cost up ~3-10×.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { parseGitHubSeedState } from "./githubSeedCompat.js";
import { seedSchema as seedStateSchema } from "@pome-sh/twin-github";

export const COMPILER_MODEL = "claude-opus-4-7";

const SYSTEM_PROMPT = `You convert natural-language descriptions of a GitHub twin's seed state into JSON matching the provided schema.

Rules:
1. Anything marked "(exact)" or "exact text" or shown inside an inline code block as a value must be copied character-for-character. Do NOT rephrase, normalize whitespace, or fix typos.
2. For values described semantically (e.g. "GitHub-conventional colors", "a reasonable description"), pick realistic GitHub-style values.
3. When the prose says "exactly N" or "and no others", do not add extras.
4. When a field is not mentioned, omit it — schema defaults will fill in.
5. Do not invent entities not mentioned. If the prose describes one issue, output exactly one issue.
6. Issue \`number\` is required and must be set (use #N if the prose says so, otherwise start at 1).
7. PR \`number\` is optional; set it when the prose says "#N".
8. Issue \`assignees\` is an array of login strings; use [] when unassigned.
9. Use fenced code blocks in the prose to indicate the exact content of \`files[].content\`. Preserve trailing newlines verbatim.`;

export interface CompileResult {
  seed: unknown;
  inputTokens: number;
  outputTokens: number;
  model: string;
  durationMs: number;
}

export async function compileSeed(prose: string, opts: { model?: string } = {}): Promise<CompileResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Export your Anthropic API key before running `pome compile-seeds`."
    );
  }

  const model = opts.model ?? COMPILER_MODEL;
  const client = new Anthropic();
  const t0 = Date.now();

  const response = await client.messages.parse({
    model,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prose }],
    output_config: { format: zodOutputFormat(seedStateSchema) }
  });

  const durationMs = Date.now() - t0;

  if (!response.parsed_output) {
    throw new Error(
      `Compiler returned no parsed_output (stop_reason=${response.stop_reason}). ` +
        `This usually means the model produced output that failed schema validation.`
    );
  }

  // Re-validate locally to be safe — `parse()` already ran the schema, but
  // running it again here gives us a stable error site for tests + ensures
  // downstream code holds a `ParsedSeedState`-shaped value, not `unknown`.
  const seed = parseGitHubSeedState(response.parsed_output);

  return {
    seed,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model,
    durationMs
  };
}
