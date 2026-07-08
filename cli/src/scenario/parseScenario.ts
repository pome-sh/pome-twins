// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { defaultSeedState, seedSchema } from "@pome-sh/twin-github";
import { parseGitHubSeedState } from "./githubSeedCompat.js";
import {
  criterionSchema,
  scenarioConfigSchema,
  scenarioSchema,
  slackSeedStateSchema,
  stripeSeedStateSchema,
  type Criterion,
  type Scenario,
  type ScenarioConfig,
  type SeedState
} from "./scenarioSchema.js";

export async function parseScenarioFile(path: string): Promise<Scenario> {
  const markdown = await readFile(path, "utf8");
  const sidecarSeed = await readSidecarSeed(path);
  return parseScenario(markdown, slugFromPath(path), sidecarSeed, path);
}

export function parseScenario(markdown: string, slug = "scenario", sidecarSeed?: unknown, scenarioPath?: string): Scenario {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug;
  const sections = splitSections(markdown);
  const prompt = sections.get("prompt") ?? sections.get("task") ?? "";
  const criteriaText = sections.get("success criteria") ?? sections.get("checks") ?? "";
  const configText = sections.get("config") ?? "";
  const seedText = sections.get("seed state") ?? "";

  const config = configText.trim() ? scenarioConfigSchema.parse(parseFencedYaml(configText)) : scenarioConfigSchema.parse({});
  const criteria = parseCriteria(criteriaText);
  const seedState = resolveSeedState({ sidecarSeed, seedText, config, scenarioPath });

  return scenarioSchema.parse({
    slug,
    title,
    setup: sections.get("setup") ?? "",
    prompt,
    expectedBehavior: sections.get("expected behavior") ?? "",
    criteria,
    config,
    seedState
  });
}

function resolveSeedState(args: { sidecarSeed: unknown; seedText: string; config: ScenarioConfig; scenarioPath?: string }): SeedState {
  // Sidecar wins when present — it's the compile-seeds output, already
  // validated against the in-memory twin. The `_meta` key (source hash,
  // model, etc.) is stripped before schema parsing.
  if (args.sidecarSeed !== undefined) {
    return parseSeedStateForScenario(stripSidecarMeta(args.sidecarSeed), args.config);
  }
  if (args.seedText.trim()) {
    const raw = stripFence(args.seedText);
    // Prose ## Seed State sections are the post-2026-05-22 contract; they're
    // meant to be compiled to <name>.seed.json via `pome compile-seeds`. If we
    // got here, the sidecar is missing — tell the user what to do instead of
    // letting JSON.parse surface "Unexpected token 'A'".
    if (!/^[\[{]/.test(raw)) {
      throw new Error(missingSidecarMessage(args.scenarioPath));
    }
    try {
      return parseSeedStateForScenario(JSON.parse(raw), args.config);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`Inline JSON seed in ## Seed State is malformed: ${err.message}`);
      }
      throw err;
    }
  }
  return defaultSeedStateForConfig(args.config.twins);
}

function missingSidecarMessage(scenarioPath: string | undefined): string {
  const pathLabel = scenarioPath ?? "<scenario>.md";
  const sidecarLabel = scenarioPath
    ? scenarioPath.replace(/\.md$/i, ".seed.json")
    : "<scenario>.seed.json";
  return [
    `Scenario has a prose ## Seed State section but no compiled sidecar (${sidecarLabel}). Run:`,
    "",
    `    pome compile-seeds ${pathLabel}`,
    "",
    "then re-run the scenario. (See `pome docs scenarios-github`.)",
  ].join("\n");
}

function stripSidecarMeta(seed: unknown): unknown {
  if (seed && typeof seed === "object" && !Array.isArray(seed)) {
    const { _meta, ...rest } = seed as Record<string, unknown>;
    return rest;
  }
  return seed;
}

async function readSidecarSeed(scenarioPath: string): Promise<unknown | undefined> {
  const sidecarPath = scenarioPath.replace(/\.md$/i, ".seed.json");
  if (sidecarPath === scenarioPath || !existsSync(sidecarPath)) return undefined;
  const raw = await readFile(sidecarPath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Sidecar seed ${sidecarPath} is not valid JSON: ${(err as Error).message}`);
  }
}

function splitSections(markdown: string) {
  const sections = new Map<string, string>();
  const headingPattern = /^##\s+(.+)$/gm;
  const headings = [...markdown.matchAll(headingPattern)].map((match) => ({
    title: match[1]!.trim().toLowerCase(),
    start: match.index! + match[0].length
  }));

  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i]!;
    const next = headings[i + 1]?.start;
    const contentStart = heading.start;
    const contentEnd = next ? markdown.lastIndexOf("##", next - 1) : markdown.length;
    sections.set(heading.title, markdown.slice(contentStart, contentEnd).trim());
  }

  return sections;
}

function parseCriteria(input: string): Criterion[] {
  return input
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.match(/^[-*]\s+\[([DP])\]\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    // Authors still write `[D]`/`[P]` in markdown; the published contract's
    // tolerant reader normalizes those to the canonical `code`/`model` kinds.
    .map((match) => criterionSchema.parse({ type: match[1], text: match[2]!.trim() }));
}

function parseFencedYaml(input: string) {
  return parseYaml(stripFence(input));
}

// FDRS-365: scenario seed shape is FLAT per twin, disambiguated by config.twins.
// Stripe-only scenarios parse with the Stripe schema; everything else (default
// `["github"]`, or explicit github) parses with the GitHub schema.
function parseSeedStateForScenario(input: unknown, config: ScenarioConfig): SeedState {
  if (isStripeOnly(config.twins)) return stripeSeedStateSchema.parse(input);
  if (isSlackOnly(config.twins)) return slackSeedStateSchema.parse(input);
  return parseGitHubSeedState(input);
}

function defaultSeedStateForConfig(twins: string[]): SeedState {
  if (isStripeOnly(twins)) {
    return stripeSeedStateSchema.parse({
      api_keys: [{ key: "sk_test_pome_default", sid: "default", account_id: "acct_default" }]
    });
  }
  if (isSlackOnly(twins)) {
    // Empty Slack seed — the twin's own `parseSeed`/`defaultSeedState` fills the
    // world at boot. Scenarios always ship a sidecar, so this is just the
    // schema-valid floor.
    return slackSeedStateSchema.parse({});
  }
  return seedSchema.parse(defaultSeedState());
}

function isStripeOnly(twins: string[]): boolean {
  return twins.includes("stripe") && !twins.includes("github");
}

function isSlackOnly(twins: string[]): boolean {
  return twins.includes("slack") && !twins.includes("github") && !twins.includes("stripe");
}

function stripFence(input: string) {
  const fence = input.match(/```(?:json|yaml)?\s*([\s\S]*?)```/i);
  return (fence?.[1] ?? input).trim();
}

function slugFromPath(path: string) {
  return basename(path, extname(path))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function formatScenarioError(error: unknown, filePath: string) {
  if (error instanceof z.ZodError) {
    return `Invalid scenario ${filePath}: ${error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`;
  }
  if (error instanceof Error) {
    return `Invalid scenario ${filePath}: ${error.message}`;
  }
  return `Invalid scenario ${filePath}`;
}
