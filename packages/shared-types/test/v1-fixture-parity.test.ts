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
const SCHEMA_BY_DIR: Record<string, ZodTypeAny> = {
  planTier: planTierSchema,
  createSessionRequest: createSessionRequestSchema,
  createSessionResponse: createSessionResponseSchema,
  usage: usageResponseSchema,
  run: runSchema,
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
