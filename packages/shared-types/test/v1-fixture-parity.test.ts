// SPDX-License-Identifier: Apache-2.0
//
// FDRS-613 — /v1 wire fixture-corpus parity.
//
// Every JSON fixture under `test/fixtures/v1/<schema>/` MUST parse successfully
// under the twins schema keyed by its directory name. The SAME corpus is fetched
// and parsed by pome-cloud's `shared-types-v1-parity` CI job against the cloud
// schema. This is intentionally parse-only: it catches represented required
// fields, enum narrowing, and other fixture-level wire incompatibilities, but it
// is not a proof of whole-schema equality.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ZodTypeAny } from "zod";
import { describe, expect, it } from "vitest";
import {
  createSessionRequestSchema,
  createSessionResponseSchema,
  planTierSchema,
  usageResponseSchema,
} from "../src/index.js";
import { runSchema } from "../src/run.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpusRoot = join(here, "fixtures", "v1");

// Directory name → schema. Keep in lockstep with fixtures/v1/README.md and the
// cloud-side schema map.
//
// The `*TaskVocab` dirs (FDRS-653) hold NEW-vocabulary payloads (task_name /
// task_source / criterion code|model). They are twins-only until the FDRS-654
// consumer swap adds them to the cloud-side map — the cloud parity gate
// iterates its own dir list, so the extra dirs are ignored there until then.
// The original dirs keep their 0.3.0-era (scenario_*) payloads on purpose:
// they now double as tolerant-reader proof.
const SCHEMA_BY_DIR: Record<string, ZodTypeAny> = {
  planTier: planTierSchema,
  createSessionRequest: createSessionRequestSchema,
  createSessionRequestTaskVocab: createSessionRequestSchema,
  createSessionResponse: createSessionResponseSchema,
  usage: usageResponseSchema,
  run: runSchema,
  runTaskVocab: runSchema,
};

describe("/v1 fixture-corpus parity (twins schema)", () => {
  for (const [dir, schema] of Object.entries(SCHEMA_BY_DIR)) {
    const dirPath = join(corpusRoot, dir);
    const files = readdirSync(dirPath).filter((f) => f.endsWith(".json"));

    it(`${dir}: has at least one fixture`, () => {
      expect(files.length).toBeGreaterThan(0);
    });

    for (const file of files) {
      it(`${dir}/${file} parses under the twins schema`, () => {
        const raw = JSON.parse(readFileSync(join(dirPath, file), "utf8"));
        const result = schema.safeParse(raw);
        if (!result.success) {
          throw new Error(
            `${dir}/${file} failed to parse:\n${JSON.stringify(result.error.issues, null, 2)}`,
          );
        }
        expect(result.success).toBe(true);
      });
    }
  }
});

// FDRS-653 — the 0.3.0-era corpus must not just PARSE, it must NORMALIZE to
// the W3 task vocabulary; new-vocab fixtures must round-trip unchanged.
describe("/v1 fixture corpus — task-vocab normalization (FDRS-653)", () => {
  const readFixture = (dir: string, file: string) =>
    JSON.parse(readFileSync(join(corpusRoot, dir, file), "utf8"));

  it("0.3.0 run fixtures normalize scenario_* → task_* (old keys dropped)", () => {
    for (const file of ["legacy-minimal.json", "full-production.json"]) {
      const raw = readFixture("run", file);
      const parsed = runSchema.parse(raw);
      expect(parsed.task_name).toBe(raw.scenario_name);
      expect(parsed.task_hash).toBe(raw.scenario_hash);
      expect(parsed).not.toHaveProperty("scenario_name");
      expect(parsed).not.toHaveProperty("scenario_hash");
      expect(parsed).not.toHaveProperty("promoted_scenario_id");
      if (raw.promoted_scenario_id !== undefined) {
        expect(parsed.promoted_task_id).toBe(raw.promoted_scenario_id);
      }
    }
  });

  it("0.3.0 run fixture criterion kinds normalize D→code, P→model", () => {
    const raw = readFixture("run", "full-production.json");
    const parsed = runSchema.parse(raw);
    const kinds = parsed.criteria_results.map((r) => r.criterion.type);
    expect(kinds).toEqual(["model"]); // fixture carries a single P criterion
    expect(kinds.every((k) => k === "code" || k === "model")).toBe(true);
  });

  it("new-vocab run fixture round-trips (task_* keys and code|model preserved)", () => {
    const raw = readFixture("runTaskVocab", "full-production-task-vocab.json");
    const parsed = runSchema.parse(raw);
    expect(parsed.task_name).toBe(raw.task_name);
    expect(parsed.task_hash).toBe(raw.task_hash);
    expect(parsed.promoted_task_id).toBe(raw.promoted_task_id);
    expect(parsed.criteria_results.map((r) => r.criterion.type)).toEqual([
      "model",
      "code",
    ]);
    // Re-parse of the serialized output is stable (idempotent normalization).
    expect(runSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("0.3.0 createSessionRequest fixtures normalize scenario_source/scenario_id → task_*", () => {
    const bySource = createSessionRequestSchema.parse(
      readFixture("createSessionRequest", "scenario-source-github.json"),
    );
    expect(bySource.task_source).toBeDefined();
    expect(bySource).not.toHaveProperty("scenario_source");

    const byId = createSessionRequestSchema.parse(
      readFixture("createSessionRequest", "stored-scenario.json"),
    );
    expect(byId.task_id).toBe("scn_abc123");
    expect(byId).not.toHaveProperty("scenario_id");
  });
});
