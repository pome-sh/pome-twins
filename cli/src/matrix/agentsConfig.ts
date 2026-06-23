// SPDX-License-Identifier: Apache-2.0
//
// Zod schema + loader/validator for eval/agents.yaml (and agents.scripted.yaml).
//
// A matrix cell = one named agent = a (scaffold, model, prompt) triple, listed
// EXPLICITLY (spec §1 — not auto-crossed on three axes; a full cross-product
// explodes and most combinations are uninteresting). The three axes are
// first-class fields so any one can be varied in isolation for a controlled
// comparison.
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// A named-prompt map: { default: "eval/prompts/default.md", terse: "..." }.
export const promptsMapSchema = z.record(z.string().min(1), z.string().min(1));
export type PromptsMap = z.infer<typeof promptsMapSchema>;

export const scaffoldSchema = z.enum([
  "claude-agent-sdk", // existing SDK scaffold
  "mcp-loop", // new model-agnostic Vercel AI SDK loop
  "command", // raw `--agent` command string (keyless scripted agents, CI)
]);
export type Scaffold = z.infer<typeof scaffoldSchema>;

// `command` overrides the derived invocation for scaffold:"command".
// model/prompt are required for mcp-loop & claude-agent-sdk and ignored for
// "command". Enforced via superRefine on the parent config (it needs the
// prompts map to validate prompt references).
export const agentEntrySchema = z
  .object({
    id: z.string().min(1), // e.g. "opus-4.8/sdk/default"
    scaffold: scaffoldSchema,
    model: z.string().min(1).optional(), // e.g. "claude-opus-4-8", "openai/gpt-5"
    prompt: z.string().min(1).optional(), // key into the prompts map
    command: z.string().min(1).optional(), // required iff scaffold === "command"
    timeout: z.number().int().positive().optional(), // per-agent override (else scenario timeout)
  })
  .strict();
export type AgentEntry = z.infer<typeof agentEntrySchema>;

export const agentsConfigSchema = z
  .object({
    prompts: promptsMapSchema.default({}),
    agents: z.array(agentEntrySchema).min(1),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const ids = new Set<string>();
    for (const a of cfg.agents) {
      if (ids.has(a.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate agent id: ${a.id}`,
          path: ["agents"],
        });
      }
      ids.add(a.id);
      if (a.scaffold === "command") {
        if (!a.command) {
          ctx.addIssue({
            code: "custom",
            message: `agent ${a.id}: scaffold "command" requires command`,
            path: ["agents"],
          });
        }
      } else {
        if (!a.model) {
          ctx.addIssue({
            code: "custom",
            message: `agent ${a.id}: scaffold "${a.scaffold}" requires model`,
            path: ["agents"],
          });
        }
        if (a.prompt && !(a.prompt in cfg.prompts)) {
          ctx.addIssue({
            code: "custom",
            message: `agent ${a.id}: prompt "${a.prompt}" not in prompts map`,
            path: ["agents"],
          });
        }
      }
    }
  });
export type AgentsConfig = z.infer<typeof agentsConfigSchema>;

// A loaded config with prompt names resolved to absolute file paths (resolved
// relative to the agents.yaml location, so `eval/prompts/default.md` works
// whether the matrix is invoked from the repo root or elsewhere).
export type ResolvedAgentsConfig = {
  configPath: string;
  prompts: Record<string, string>; // name -> absolute prompt path
  agents: AgentEntry[];
};

// Parse + validate raw YAML text. Separated from file IO so tests can exercise
// the happy + error paths with no filesystem.
export function parseAgentsConfig(yamlText: string): AgentsConfig {
  const raw: unknown = parseYaml(yamlText);
  return agentsConfigSchema.parse(raw);
}

export async function loadAgentsConfig(
  agentsFilePath: string,
): Promise<ResolvedAgentsConfig> {
  const configPath = resolve(agentsFilePath);
  const yamlText = await readFile(configPath, "utf8");
  const config = parseAgentsConfig(yamlText);
  const baseDir = dirname(configPath);
  const prompts: Record<string, string> = {};
  for (const [name, p] of Object.entries(config.prompts)) {
    prompts[name] = isAbsolute(p) ? p : resolve(baseDir, p);
  }
  return { configPath, prompts, agents: config.agents };
}
