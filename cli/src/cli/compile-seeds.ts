// SPDX-License-Identifier: Apache-2.0
/**
 * `pome compile-seeds` — translate the prose `## Seed State` section of a
 * scenario markdown file into a sidecar JSON seed via the Claude API, verify
 * it loads cleanly into the GitHub twin, and write the result next to the
 * scenario.
 *
 * See `docs/agents/scenario-prose-seed.md` for the prose convention and the
 * defense layers (schema validation, twin-load verification, PR review).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { z } from "zod";
import { compileSeed, COMPILER_MODEL, type CompileResult } from "../scenario/seed-compiler.js";
import { compileSeedHosted } from "../scenario/seed-compiler-hosted.js";
import { verifySeedWithTwin } from "../scenario/seed-verifier.js";
import { exitCodeFor } from "../hosted/errors.js";

const SIDECAR_META_VERSION = 1;

interface CompileOptions {
  force: boolean;
  hosted: boolean;
  apiBaseUrl: string;
}

interface FileResult {
  path: string;
  status: "compiled" | "skipped-cached" | "skipped-no-seed" | "skipped-unsupported-twin" | "skipped-inline-json" | "error";
  message?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  /** Set on hosted errors so the top-level handler can pick the right exit code. */
  exitCode?: number;
}

export async function runCompileSeeds(target: string | undefined, opts: CompileOptions): Promise<number> {
  const files = await resolveScenarioFiles(target ?? "scenarios");
  if (files.length === 0) {
    console.error(`No scenario .md files found at ${target ?? "scenarios"}.`);
    return 2;
  }

  const results: FileResult[] = [];
  for (const file of files) {
    results.push(await compileOne(file, opts));
  }

  for (const r of results) {
    const stamp = statusStamp(r.status);
    const tail = r.message ? ` — ${r.message}` : "";
    const cost = r.inputTokens !== undefined ? ` (${r.inputTokens} in / ${r.outputTokens} out, ${r.durationMs}ms)` : "";
    console.error(`${stamp} ${r.path}${tail}${cost}`);
  }

  const errors = results.filter((r) => r.status === "error");
  if (errors.length > 0) {
    console.error(`\n${errors.length} error(s).`);
    // Propagate the worst hosted exit code (e.g. 3=auth, 4=quota) so CI scripts
    // can branch on the reason. Falls back to 1 for local-only failures.
    const worstHosted = errors.reduce((max, r) => Math.max(max, r.exitCode ?? 0), 0);
    return worstHosted > 0 ? worstHosted : 1;
  }
  return 0;
}

async function compileOne(scenarioPath: string, opts: CompileOptions): Promise<FileResult> {
  let markdown: string;
  try {
    markdown = await readFile(scenarioPath, "utf8");
  } catch (err) {
    return { path: scenarioPath, status: "error", message: `read failed: ${(err as Error).message}` };
  }

  const seedText = extractSeedSection(markdown).trim();
  if (seedText.length === 0) {
    return { path: scenarioPath, status: "skipped-no-seed", message: "no ## Seed State section" };
  }

  // Stripe scenarios use a different schema; v1 only supports github. Check
  // twin first so Stripe scenarios are silently skipped without surfacing
  // misleading "still on inline JSON" warnings.
  const twins = readTwinsFromConfig(markdown);
  if (twins.length > 0 && !twins.includes("github")) {
    return {
      path: scenarioPath,
      status: "skipped-unsupported-twin",
      message: `twins=${twins.join(",")} not supported yet`
    };
  }

  // Heuristic: if the section is a fenced JSON block, this scenario is still
  // on the legacy inline format. Authors must replace the block with prose
  // before compile-seeds can take over.
  if (looksLikeJsonBlock(seedText)) {
    return {
      path: scenarioPath,
      status: "skipped-inline-json",
      message: "still on inline JSON — replace the fenced JSON with prose"
    };
  }

  const sidecarPath = sidecarPathFor(scenarioPath);
  const proseHash = hashProse(seedText);

  // Cache check only applies to local compile — hosted callers may have
  // different model versions than the locally-pinned COMPILER_MODEL, and the
  // cloud has its own edge cache to avoid duplicate work anyway.
  if (!opts.force && !opts.hosted && existsSync(sidecarPath)) {
    const cached = await readSidecarMeta(sidecarPath);
    if (cached && cached.source_hash === proseHash && cached.model === COMPILER_MODEL) {
      return { path: scenarioPath, status: "skipped-cached", message: `up-to-date (${sidecarPath})` };
    }
  }

  let result: CompileResult;
  try {
    result = opts.hosted
      ? await compileSeedHosted(seedText, { apiBaseUrl: opts.apiBaseUrl, scenarioPath })
      : await compileSeed(seedText);
  } catch (err) {
    return {
      path: scenarioPath,
      status: "error",
      message: `compile failed: ${(err as Error).message}`,
      exitCode: opts.hosted ? exitCodeFor(err) : undefined
    };
  }

  try {
    verifySeedWithTwin(result.seed);
  } catch (err) {
    return { path: scenarioPath, status: "error", message: (err as Error).message };
  }

  const payload = {
    _meta: {
      version: SIDECAR_META_VERSION,
      source_hash: proseHash,
      model: result.model,
      compiled_at: new Date().toISOString()
    },
    ...(result.seed as Record<string, unknown>)
  };

  await writeFile(sidecarPath, JSON.stringify(payload, null, 2) + "\n");

  return {
    path: scenarioPath,
    status: "compiled",
    message: `→ ${sidecarPath}`,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.durationMs
  };
}

function extractSeedSection(markdown: string): string {
  // Mirrors the H2-section logic in parseScenario.ts: find the "## Seed State"
  // heading and return everything until the next H2.
  const headingRegex = /^##\s+seed state\s*$/im;
  const m = markdown.match(headingRegex);
  if (!m) return "";
  const start = m.index! + m[0].length;
  const rest = markdown.slice(start);
  const nextHeading = rest.match(/^##\s+/m);
  return nextHeading ? rest.slice(0, nextHeading.index!).trim() : rest.trim();
}

function readTwinsFromConfig(markdown: string): string[] {
  // Find the `## Config` heading and read everything until the next `##` or
  // end of file. JS regex has no `\Z`, so we use a lookahead-or-EOF approach.
  const headingMatch = markdown.match(/^##\s+config\s*$/im);
  if (!headingMatch) return [];
  const rest = markdown.slice(headingMatch.index! + headingMatch[0].length);
  const nextHeading = rest.match(/^##\s+/m);
  const block = nextHeading ? rest.slice(0, nextHeading.index!) : rest;
  const twinsLine = block.match(/^\s*twins\s*:\s*\[(.+?)\]/m);
  if (!twinsLine) return [];
  return twinsLine[1]!
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function looksLikeJsonBlock(input: string): boolean {
  return /^```(?:json)?\s*\{/m.test(input.trim());
}

function sidecarPathFor(scenarioPath: string): string {
  const ext = extname(scenarioPath);
  return scenarioPath.slice(0, -ext.length) + ".seed.json";
}

function hashProse(input: string): string {
  return "sha256:" + createHash("sha256").update(input.replace(/\s+$/g, "")).digest("hex");
}

const sidecarMetaSchema = z.object({
  _meta: z.object({
    version: z.number().int(),
    source_hash: z.string(),
    model: z.string(),
    compiled_at: z.string()
  })
});

async function readSidecarMeta(path: string): Promise<{ source_hash: string; model: string } | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = sidecarMetaSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return { source_hash: parsed.data._meta.source_hash, model: parsed.data._meta.model };
  } catch {
    return null;
  }
}

async function resolveScenarioFiles(target: string): Promise<string[]> {
  const abs = resolve(target);
  if (!existsSync(abs)) throw new Error(`Path not found: ${target}`);
  const st = await stat(abs);
  if (st.isFile()) return [abs];
  const entries = await readdir(abs);
  return entries.filter((e) => e.endsWith(".md")).sort().map((e) => join(abs, e));
}

function statusStamp(status: FileResult["status"]): string {
  switch (status) {
    case "compiled":
      return "OK  ";
    case "skipped-cached":
      return "skip";
    case "skipped-no-seed":
      return "skip";
    case "skipped-unsupported-twin":
      return "skip";
    case "skipped-inline-json":
      return "warn";
    case "error":
      return "FAIL";
  }
}
