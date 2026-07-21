// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { defaultSeedState, seedSchema } from "@pome-sh/twin-github";
import {
  defaultSeedState as defaultGmailSeedState,
  gmailSeedSchema,
} from "@pome-sh/twin-gmail";
import {
  defaultSeedState as defaultLinearSeedState,
  linearSeedSchema as linearSeedStateSchema,
} from "@pome-sh/twin-linear";
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
  type SeedEnvelope,
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
  const criteria = parseCriteria(criteriaText, config.twins);
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

function resolveSeedState(args: { sidecarSeed: unknown; seedText: string; config: ScenarioConfig; scenarioPath?: string }): SeedState | SeedEnvelope {
  // Multi-twin (M3): the seed is a per-twin envelope, decided from `config.twins`
  // alone (envelope-iff-multi-twin — never by sniffing the seed shape).
  if (args.config.twins.length > 1) {
    return resolveMultiTwinSeedState(args);
  }
  // ── Single-twin: unchanged (byte-identical flat path). ──
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

// Multi-twin (M3): the seed (sidecar OR inline) MUST be the per-twin envelope
// `{ <twin>: <flat seed> }`. Envelope keys are a subset of the scenario's twins;
// each present value is parsed with THAT twin's own flat schema, and a twin with
// no envelope key falls back to its default seed. A key that is not one of the
// scenario's twins is a loud error. When no seed is provided at all, every twin
// gets its default.
function resolveMultiTwinSeedState(args: {
  sidecarSeed: unknown;
  seedText: string;
  config: ScenarioConfig;
  scenarioPath?: string;
}): SeedEnvelope {
  const twins = args.config.twins;
  let raw: unknown | undefined;
  if (args.sidecarSeed !== undefined) {
    raw = stripSidecarMeta(args.sidecarSeed);
  } else if (args.seedText.trim()) {
    const text = stripFence(args.seedText);
    if (!/^[\[{]/.test(text)) {
      throw new Error(missingSidecarMessage(args.scenarioPath));
    }
    try {
      raw = JSON.parse(text);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`Inline JSON seed in ## Seed State is malformed: ${err.message}`);
      }
      throw err;
    }
  } else {
    raw = undefined;
  }
  return buildSeedEnvelope(raw, twins);
}

function buildSeedEnvelope(raw: unknown | undefined, twins: string[]): SeedEnvelope {
  const envelope: SeedEnvelope = {};
  if (raw === undefined) {
    for (const twin of twins) envelope[twin] = defaultSeedForTwin(twin);
    return envelope;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Multi-twin scenarios need a per-twin seed envelope { <twin>: <seed> } for twins [${twins.join(", ")}], not a bare seed object.`,
    );
  }
  const allowed = new Set(twins);
  const provided = raw as Record<string, unknown>;
  for (const key of Object.keys(provided)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Seed envelope key "${key}" is not one of the scenario's twins [${twins.join(", ")}].`,
      );
    }
  }
  for (const twin of twins) {
    envelope[twin] =
      twin in provided ? parseSeedForTwin(twin, provided[twin]) : defaultSeedForTwin(twin);
  }
  return envelope;
}

// Parse one twin's flat seed with its own schema — the same schemas the
// single-twin flat path uses, keyed by twin id. Unknown twins fall back to the
// GitHub parse (mirrors the single-twin default).
function parseSeedForTwin(twin: string, input: unknown): SeedState {
  if (twin === "stripe") return stripeSeedStateSchema.parse(input);
  if (twin === "slack") return slackSeedStateSchema.parse(input);
  if (twin === "gmail") return gmailSeedSchema.parse(input);
  if (twin === "linear") return linearSeedStateSchema.parse(input);
  return parseGitHubSeedState(input);
}

function defaultSeedForTwin(twin: string): SeedState {
  if (twin === "stripe") {
    return stripeSeedStateSchema.parse({
      api_keys: [{ key: "sk_test_pome_default", sid: "default", account_id: "acct_default" }]
    });
  }
  if (twin === "slack") {
    return slackSeedStateSchema.parse({});
  }
  if (twin === "gmail") {
    return gmailSeedSchema.parse(defaultGmailSeedState());
  }
  if (twin === "linear") {
    return linearSeedStateSchema.parse(defaultLinearSeedState());
  }
  return seedSchema.parse(defaultSeedState());
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

// Criterion marker grammar (F-778): `[code]` / `[model]` optionally carrying a
// twin tag, `[code:<twin>]` / `[model:<twin>]`, where <twin> is
// `[a-z][a-z0-9_-]*`. The marker spells the canonical criterion kind directly.
// The tag lands on `criterion.twin`; a bare marker leaves it undefined
// (attributes to the session's primary twin, `twins[0]`).
const CRITERION_LINE_RE = /^[-*]\s+\[(code|model)(?::([a-z][a-z0-9_-]*))?\]\s+(.+)$/;
// The retired pre-F-778 marker spelling, matched ONLY to fail loudly. Without
// this guard a legacy `[D]`/`[P]` line would fall through the silent
// skip-non-criterion path below and the scenario would "pass" with fewer
// criteria than its author wrote.
const LEGACY_CRITERION_LINE_RE = /^[-*]\s+\[([DP])(?::([a-z][a-z0-9_-]*))?\]\s+(.+)$/;

function parseCriteria(input: string, twins: string[]): Criterion[] {
  const multiTwin = twins.length > 1;
  const allowed = new Set(twins);
  const primary = twins[0]!;
  const criteria: Criterion[] = [];

  for (const rawLine of input.split("\n")) {
    const line = rawLine.trim();
    const legacy = line.match(LEGACY_CRITERION_LINE_RE);
    if (legacy) {
      const legacyMarker = `[${legacy[1]}${legacy[2] ? `:${legacy[2]}` : ""}]`;
      throw new Error(
        `Criterion "${legacyMarker} ${legacy[3]!.trim()}" uses a retired marker — markers were renamed [D]→[code] and [P]→[model] (tags carry over: [D:github]→[code:github]).`,
      );
    }
    const match = line.match(CRITERION_LINE_RE);
    if (!match) continue;
    const kind = match[1]!; // "code" | "model"
    const tag = match[2]; // twin tag or undefined
    const text = match[3]!.trim();
    // Reconstruct the human-facing marker for error messages.
    const marker = `[${kind}${tag ? `:${tag}` : ""}]`;

    if (tag !== undefined) {
      if (!multiTwin) {
        // Single-twin: an explicit tag is allowed but must equal the sole twin.
        if (tag !== primary) {
          throw new Error(
            `Criterion "${marker} ${text}" tags twin "${tag}", but this single-twin scenario runs "${primary}". Drop the tag or set config.twins to include "${tag}".`,
          );
        }
      } else if (!allowed.has(tag)) {
        // Multi-twin: an explicit tag must name one of the scenario's twins.
        throw new Error(
          `Criterion "${marker} ${text}" tags twin "${tag}", which is not in the scenario's twins [${twins.join(", ")}].`,
        );
      }
    } else if (multiTwin && kind === "code") {
      // Multi-twin: every [code] criterion MUST carry a tag so the cloud knows
      // which twin's state to check it against. [model] may stay bare
      // (attributes to the primary twin).
      throw new Error(
        `Criterion "${marker} ${text}" needs a twin tag ([code:<twin>]) in a multi-twin scenario (twins [${twins.join(", ")}]).`,
      );
    }

    // The marker spells the canonical kind; `criterionSchema` keeps accepting
    // the legacy `D`/`P` enum values only for 0.3.0-era persisted artifacts
    // (the published contract's tolerant reader), never from markdown.
    // The optional `twin` rides through untouched.
    criteria.push(
      criterionSchema.parse(
        tag !== undefined ? { type: kind, text, twin: tag } : { type: kind, text },
      ),
    );
  }

  return criteria;
}

/** The flat seed a single twin boots from. Single-twin scenarios return the
 *  flat `seedState` as-is; multi-twin scenarios return that twin's slice of the
 *  per-twin envelope (decided from `config.twins`, per the envelope-iff-multi-twin
 *  rule). Used by the local runner to seed each twin harness. */
export function seedStateForTwin(scenario: Scenario, twin: string): unknown {
  if (scenario.config.twins.length > 1) {
    return (scenario.seedState as SeedEnvelope)[twin];
  }
  return scenario.seedState;
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
  if (isGmailOnly(config.twins)) return gmailSeedSchema.parse(input);
  if (isLinearOnly(config.twins)) return linearSeedStateSchema.parse(input);
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
  if (isGmailOnly(twins)) {
    return gmailSeedSchema.parse(defaultGmailSeedState());
  }
  if (isLinearOnly(twins)) {
    return linearSeedStateSchema.parse(defaultLinearSeedState());
  }
  return seedSchema.parse(defaultSeedState());
}

function isStripeOnly(twins: string[]): boolean {
  return twins.length === 1 && twins[0] === "stripe";
}

function isSlackOnly(twins: string[]): boolean {
  return twins.length === 1 && twins[0] === "slack";
}

function isGmailOnly(twins: string[]): boolean {
  return twins.length === 1 && twins[0] === "gmail";
}

function isLinearOnly(twins: string[]): boolean {
  return twins.length === 1 && twins[0] === "linear";
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
